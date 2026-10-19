/**
 * Media pipeline tests: real ffmpeg conversion (vendor binary) + mocked
 * Groq/Gemini HTTP calls. The REAL Groq Whisper endpoint was verified
 * separately with an Urdu voice sample (see report) — these tests pin the
 * local conversion + request-shaping code paths.
 * Run: npm test
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFfmpeg, transcribeWav, geminiDescribe, WHISPER_MODEL } from '../src/media.js';

const FF = resolveFfmpeg();

function tmp() {
  return mkdtempSync(join(tmpdir(), 'wabot-test-'));
}

describe('ffmpeg (vendor static binary)', () => {
  it('converts ogg/opus voice note -> 16kHz mono wav (pipeline args)', () => {
    const dir = tmp();
    try {
      const ogg = join(dir, 'voice.ogg');
      const wav = join(dir, 'voice.wav');
      // synthesize a 2s opus voice-note-like file
      execFileSync(FF, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libopus', ogg],
        { stdio: 'pipe' });
      // exact args the pipeline uses
      execFileSync(FF, ['-y', '-i', ogg, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
        { stdio: 'pipe' });
      const header = readFileSync(wav, null).subarray(0, 44);
      assert.equal(header.subarray(0, 4).toString(), 'RIFF'); // valid WAV
      // 2s * 16000Hz * 2 bytes = 64000 data bytes (+44 header)
      assert.ok(header.length === 44);
      const size = readFileSync(wav).length;
      assert.ok(Math.abs(size - 64044) < 2000, `wav size ${size} ≈ 64044`);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('extracts 3 frames + audio from a synthesized mp4 (pipeline args)', () => {
    const dir = tmp();
    try {
      const mp4 = join(dir, 'clip.mp4');
      execFileSync(FF, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=7:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4],
        { stdio: 'pipe' });
      execFileSync(FF, ['-y', '-i', mp4, '-vf', 'fps=1/2,scale=640:-1', '-frames:v', '3', join(dir, 'frame%d.jpg')],
        { stdio: 'pipe' });
      execFileSync(FF, ['-y', '-i', mp4, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', join(dir, 'audio.wav')],
        { stdio: 'pipe' });
      const frames = readdirSync(dir).filter((f) => f.startsWith('frame'));
      assert.equal(frames.length, 3);
      const wavHeader = readFileSync(join(dir, 'audio.wav')).subarray(0, 4).toString();
      assert.equal(wavHeader, 'RIFF');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe('transcribeWav (mocked Groq)', () => {
  it('posts multipart to the Whisper endpoint with the right model', async () => {
    let seen = {};
    const fakeFetch = async (url, opts) => {
      seen = { url, auth: opts.headers.Authorization, method: opts.method, isForm: typeof opts.body?.get === 'function' };
      assert.equal(opts.body.get('model'), WHISPER_MODEL);
      return { ok: true, json: async () => ({ text: 'mock transcript' }) };
    };
    const out = await transcribeWav(Buffer.from('fake-wav'), 'test-key', fakeFetch);
    assert.equal(out, 'mock transcript');
    assert.equal(seen.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(seen.auth, 'Bearer test-key');
    assert.equal(seen.method, 'POST');
    assert.equal(seen.isForm, true);
  });

  it('throws on HTTP error', async () => {
    const fakeFetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(() => transcribeWav(Buffer.from('x'), 'bad-key', fakeFetch), /whisper HTTP 401/);
  });
});

describe('geminiDescribe (mocked Gemini)', () => {
  it('sends inline image data with the API-key header', async () => {
    let seen = {};
    const fakeFetch = async (url, opts) => {
      seen = { url, keyHeader: opts.headers['x-goog-api-key'], body: opts.body };
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'a cat on a sofa' }] } }] }),
      };
    };
    const out = await geminiDescribe(
      [{ text: 'describe' }, { inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } }],
      { geminiKey: 'g-key', geminiModel: 'gemini-2.0-flash', fetchImpl: fakeFetch },
    );
    assert.equal(out, 'a cat on a sofa');
    assert.ok(seen.url.includes('gemini-2.0-flash:generateContent'));
    assert.equal(seen.keyHeader, 'g-key');
    assert.ok(seen.body.includes('inline_data'));
  });
});
