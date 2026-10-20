/**
 * index.js — entrypoint (`npm start`).
 *
 * Boots: env validation -> SQLite stores -> brain (Groq + knowledge) ->
 * handover store -> WhatsApp channel -> handover-aware agent -> webhook server.
 */
import 'dotenv/config';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryClient, knowledgeClient, handoverClient } from './store.js';
import { initBrain } from './brain.js';
import { HandoverStore, normalizePhone } from './handover.js';
import { createChannel, createServer } from './whatsapp.js';
import { createHandoverAgent } from './agent-wrapper.js';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function ffmpegAvailable() {
  if (existsSync(join(ROOT, 'vendor', 'ffmpeg'))) return true;
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return true;
  try {
    const installer = createRequire(import.meta.url)('@ffmpeg-installer/ffmpeg');
    if (installer?.path && existsSync(installer.path)) return true;
  } catch {
    /* not installed */
  }
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: ${name} is not set. See .env.sample — copy it to .env locally or set vars in the Botkeep panel.`);
    process.exit(1);
  }
  return v;
}

async function main() {
  // ---- required env ----
  required('WHATSAPP_PHONE_NUMBER_ID');
  required('WHATSAPP_ACCESS_TOKEN');
  required('VERIFY_TOKEN');
  required('APP_SECRET');
  required('GROQ_API_KEY');
  const ownerNumber = normalizePhone(required('OWNER_PHONE_NUMBER'));
  if (!ownerNumber) {
    console.error('FATAL: OWNER_PHONE_NUMBER must contain digits (e.g. 923001234567).');
    process.exit(1);
  }

  // ---- optional env (warn, don't die) ----
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[warn] GEMINI_API_KEY not set — image/video analysis disabled (voice notes still work via Groq).');
  }
  if (!ffmpegAvailable()) {
    console.warn('[warn] no ffmpeg found (vendor/ffmpeg or system) — voice/video analysis disabled.');
  }

  // ---- stores ----
  const handover = new HandoverStore(handoverClient);
  await handover.init();

  // ---- brain ----
  const brain = await initBrain({
    memoryClient,
    knowledgeClient,
    systemPromptPath: join(ROOT, 'config', 'system-prompt.txt'),
    knowledgeDir: join(ROOT, 'knowledge'),
  });

  // ---- channel + agent + server ----
  const channel = createChannel();
  const agent = createHandoverAgent({
    channel,
    brain,
    handover,
    mediaCtx: {
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
      groqKey: process.env.GROQ_API_KEY,
      geminiKey: process.env.GEMINI_API_KEY || null,
      geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest', // 2.0-flash retired by Google (404, Oct 2026); the alias tracks the current Flash
    },
    ownerNumber,
    memoryClient,
  });

  const server = createServer({ channel, agent });
  const port = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
  server.listen(port, () => {
    console.log(`[bot] listening on :${port} — webhook path /webhook`);
    console.log(`[bot] owner: +${ownerNumber} | model: ${brain.modelId}`);
  });

  const shutdown = () => {
    console.log('[bot] shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
