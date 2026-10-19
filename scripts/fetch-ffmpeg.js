/**
 * fetch-ffmpeg.js — downloads a static ffmpeg binary into vendor/.
 *
 * Runs automatically as an npm `postinstall` hook (also manually via
 * `npm run fetch-ffmpeg`). Botkeep deploys from a GitHub import and runs
 * `npm install`, so this keeps the repo lean (~75 MB binary stays out of git)
 * while guaranteeing the media pipeline has ffmpeg at runtime.
 *
 * Source: johnvansickle.com static builds (x86_64). If the download fails
 * (offline CI, unsupported arch), the script warns instead of failing the
 * install — src/media.js then falls back to a system `ffmpeg` on PATH, or
 * disables media analysis with a clear log line.
 */
import { existsSync, mkdirSync, copyFileSync, chmodSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
const DEST = join(VENDOR, 'ffmpeg');

const BUILDS = {
  x64: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
};

async function main() {
  if (existsSync(DEST)) {
    console.log('[ffmpeg] vendor/ffmpeg already present, skipping download.');
    return;
  }
  const arch = process.arch;
  const url = BUILDS[arch];
  if (!url) {
    console.warn(`[ffmpeg] WARNING: no static build for arch "${arch}". Install a system ffmpeg or place a binary at vendor/ffmpeg. Media analysis will be degraded.`);
    return;
  }
  mkdirSync(VENDOR, { recursive: true });
  const tmpFile = join(tmpdir(), `ffmpeg-static-${Date.now()}.tar.xz`);
  const tmpDir = join(tmpdir(), `ffmpeg-static-${Date.now()}`);
  try {
    console.log(`[ffmpeg] downloading static build for ${arch} ...`);
    const res = await fetch(url, { headers: { 'User-Agent': 'curl/8.5.0' } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    writeFileSync(tmpFile, Buffer.from(await res.arrayBuffer()));
    mkdirSync(tmpDir, { recursive: true });
    execFileSync('tar', ['-xJf', tmpFile, '-C', tmpDir]);
    const extracted = readdirSync(tmpDir).find((d) => d.startsWith('ffmpeg-'));
    if (!extracted) throw new Error('unexpected archive layout');
    copyFileSync(join(tmpDir, extracted, 'ffmpeg'), DEST);
    chmodSync(DEST, 0o755);
    console.log('[ffmpeg] installed to vendor/ffmpeg');
  } catch (err) {
    console.warn(`[ffmpeg] WARNING: download failed (${err.message}). Install a system ffmpeg or place a binary at vendor/ffmpeg. Media analysis will be degraded.`);
  } finally {
    rmSync(tmpFile, { force: true });
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

main();
