/**
 * store.js — SQLite (LibSQL) database clients.
 *
 * Three separate concerns, three files (matches wappy-kit's own "one focused
 * store per concern" posture):
 *   data/memory.db    — conversation turns (via @wappy_ai/harness createLibsqlMemory)
 *   data/knowledge.db — business knowledge chunks (via @wappy_ai/harness createKnowledge, BM25)
 *   data/handover.db  — per-chat handover state (custom, see handover.js)
 *
 * Botkeep's storage persists across restarts, so handovers and memory survive
 * a process restart. All paths are relative to the project root and
 * configurable via env for flexibility.
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');

mkdirSync(DATA_DIR, { recursive: true });

function fileUrl(name) {
  return 'file:' + join(DATA_DIR, name);
}

export const memoryClient = createClient({ url: process.env.MEMORY_DB_URL || fileUrl('memory.db') });
export const knowledgeClient = createClient({ url: process.env.KNOWLEDGE_DB_URL || fileUrl('knowledge.db') });
export const handoverClient = createClient({ url: process.env.HANDOVER_DB_URL || fileUrl('handover.db') });

export const DATA_DIR_PATH = DATA_DIR;
