/**
 * media.js — customer media understanding pipeline.
 *
 * WhatsApp sends voice notes as ogg/opus, images as jpeg, videos as mp4.
 * The Cloud API only gives us a media *id* (in `message.media.url` — yes, the
 * field is misnamed upstream); we resolve it via downloadWhatsAppMedia(),
 * then:
 *
 *   voice/audio -> ffmpeg to 16kHz mono wav -> Groq Whisper (whisper-large-v3-turbo)
 *   image       -> Gemini vision (free tier) -> short description
 *   video       -> 3 frames to Gemini vision + audio track to Whisper -> combined summary
 *
 * Every branch returns plain text the brain consumes as the user's message,
 * e.g. `[Voice note transcript]: "..."`. All temp files are cleaned up.
 * If GEMINI_API_KEY is unset, image/video analysis is skipped with a notice;
 * voice notes only need GROQ_API_KEY.
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { downloadWhatsAppMedia } from '@wappy_ai/whatsapp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const LIMITS = {
  audio: 20 * 1024 * 1024,
  image: 12 * 1024 * 1024,
  video: 48 * 1024 * 1024,
};

const WHISPER_MODEL = 'whisper-large-v3-turbo'; // verified live via Groq API 2026-10-19

let cachedFfmpeg = null;

// Resolution order: vendored binary → FFMPEG_PATH env → @ffmpeg-installer
// package (ships a real binary as an npm dep — works on hosts with no system
// ffmpeg and no postinstall scripts, e.g. Botkeep) → system 'ffmpeg'.
function resolveFfmpeg() {
  if (cachedFfmpeg) return cachedFfmpeg;
  const vendor = join(ROOT, 'vendor', 'ffmpeg');
  if (existsSync(vendor)) return (cachedFfmpeg = vendor);
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    return (cachedFfmpeg = process.env.FFMPEG_PATH);
  }
  try {
    const req = createRequire(import.meta.url);
    const installer = req('@ffmpeg-installer/ffmpeg');
    if (installer?.path && existsSync(installer.path)) return (cachedFfmpeg = installer.path);
  } catch {
    /* package not installed — fall through */
  }
  return (cachedFfmpeg = 'ffmpeg'); // system fallback (may not exist -> caught & reported)
}

function ff(args, timeoutMs = 120000) {
  return execFileSync(resolveFfmpeg(), args, { timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function download(message, accessToken, maxBytes, allowedMimeTypes, fetchImpl) {
  const mediaId = message.media?.url; // upstream quirk: this field holds the media *id*
  if (!mediaId) throw new Error('no media id on message');
  const result = await downloadWhatsAppMedia({
    mediaId,
    accessToken,
    maxBytes,
    allowedMimeTypes,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (!result.ok) throw new Error(`media download failed: ${result.error.kind}`);
  return result.media; // { bytes: Uint8Array, mimeType }
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wabot-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

async function transcribeWav(wavBytes, groqKey, fetchImpl = fetch) {
  const form = new FormData();
  form.append('file', new File([wavBytes], 'audio.wav', { type: 'audio/wav' }));
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'json');
  const res = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKey}`, 'User-Agent': 'curl/8.5.0' },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`whisper HTTP ${res.status}`);
  const data = await res.json();
  return (data.text || '').trim();
}

export async function transcribeVoiceNote(message, { accessToken, groqKey, fetchImpl }) {
  const media = await download(message, accessToken, LIMITS.audio, undefined, fetchImpl);
  return withTempDir(async (dir) => {
    const input = join(dir, 'in.bin');
    const wav = join(dir, 'out.wav');
    writeFileSync(input, media.bytes);
    ff(['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const { readFileSync } = await import('node:fs');
    return transcribeWav(readFileSync(wav), groqKey, fetchImpl);
  });
}

async function geminiDescribe(parts, { geminiKey, geminiModel, fetchImpl = fetch }) {
  const res = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(120000),
    },
  );
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();
}

export async function describeImage(message, { accessToken, geminiKey, geminiModel, fetchImpl }) {
  const media = await download(message, accessToken, LIMITS.image, undefined, fetchImpl);
  const b64 = Buffer.from(media.bytes).toString('base64');
  return geminiDescribe(
    [
      { text: 'Describe this image in 2-3 sentences for a customer-support agent. Mention any text visible in it, products, people, or problems shown.' },
      { inline_data: { mime_type: media.mimeType || 'image/jpeg', data: b64 } },
    ],
    { geminiKey, geminiModel, fetchImpl },
  );
}

export async function analyzeVideo(message, { accessToken, groqKey, geminiKey, geminiModel, fetchImpl }) {
  const media = await download(message, accessToken, LIMITS.video, undefined, fetchImpl);
  return withTempDir(async (dir) => {
    const input = join(dir, 'in.mp4');
    writeFileSync(input, media.bytes);
    // 3 frames spread across the clip (1 frame / 2s, scaled down) + full audio track
    ff(['-y', '-i', input, '-vf', 'fps=1/2,scale=640:-1', '-frames:v', '3', join(dir, 'frame%d.jpg')]);
    const audioWav = join(dir, 'audio.wav');
    ff(['-y', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', audioWav]);

    const { readdirSync, readFileSync } = await import('node:fs');
    const frames = readdirSync(dir)
      .filter((f) => f.startsWith('frame') && f.endsWith('.jpg'))
      .sort()
      .slice(0, 3);

    const parts = [
      { text: 'These are frames from a short customer video. Describe what is happening in 2-3 sentences for a customer-support agent.' },
    ];
    for (const f of frames) {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: readFileSync(join(dir, f)).toString('base64') } });
    }
    const visual = frames.length
      ? await geminiDescribe(parts, { geminiKey, geminiModel, fetchImpl })
      : 'no frames extracted';
    let audioText = '';
    try {
      audioText = await transcribeWav(readFileSync(audioWav), groqKey, fetchImpl);
    } catch (err) {
      audioText = `(audio transcription unavailable: ${err.message})`;
    }
    return { visual, audioText };
  });
}

/**
 * Main entry: turns any supported inbound media message into brain-ready text.
 * Returns a string like `[Voice note transcript]: "..."`. Throws on failure —
 * the caller decides the fallback (see agent-wrapper.js).
 */
export async function mediaToText(message, ctx) {
  const kind = message.media?.kind;
  const caption = message.media?.caption ? `\n[Caption]: ${message.media.caption}` : '';
  if (kind === 'voice' || kind === 'audio') {
    const transcript = await transcribeVoiceNote(message, ctx);
    return `[Voice note transcript]: "${transcript}"${caption}`;
  }
  if (kind === 'image') {
    if (!ctx.geminiKey) return `[Image received — vision unavailable (GEMINI_API_KEY not set)]${caption}`;
    const desc = await describeImage(message, ctx);
    return `[Image description]: ${desc}${caption}`;
  }
  if (kind === 'video') {
    if (!ctx.geminiKey) return `[Video received — vision unavailable (GEMINI_API_KEY not set)]${caption}`;
    const { visual, audioText } = await analyzeVideo(message, ctx);
    return `[Video summary — visual]: ${visual}\n[Video summary — audio transcript]: "${audioText}"${caption}`;
  }
  if (kind === 'document') {
    return `[Document received]${caption}`;
  }
  if (kind === 'location') {
    const { latitude, longitude } = message.media;
    return `[Location shared]: ${latitude}, ${longitude}${caption}`;
  }
  return `[Unsupported message type: ${kind || 'unknown'}]${caption}`;
}

export { WHISPER_MODEL, resolveFfmpeg, transcribeWav, geminiDescribe };
