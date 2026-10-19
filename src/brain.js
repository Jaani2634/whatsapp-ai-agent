/**
 * brain.js — the agent's brain.
 *
 * Why custom instead of @wappy_ai/harness's createAgent: the harness hardcodes
 * its system prompt (SCOPE_GUARDRAIL + FORMAT_REASONING + GROUNDING_HONESTY, see
 * its agent.js) with no hook for a business persona. This bot's whole point is a
 * config-driven persona (config/system-prompt.txt) + business knowledge
 * (knowledge/), so the brain is a small, explicit loop on the Vercel AI SDK:
 *
 *   history (LibSQL) + knowledge recall (BM25, LibSQL) + system prompt
 *     -> Groq (OpenAI-compatible) -> reply text
 *
 * It still uses wappy-kit's pieces where they fit: createLibsqlMemory and
 * createKnowledge from @wappy_ai/harness, MessageChannel from @wappy_ai/whatsapp.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createLibsqlMemory, createKnowledge } from '@wappy_ai/harness';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_MODEL_ID = 'openai/gpt-oss-120b'; // verified live via Groq API 2026-10-19

function newTurnId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Handover contract with the model: the system prompt instructs it to emit
 * exactly [[HANDOVER]] (and nothing else) when the customer asks for a human
 * or the question can't be answered from business knowledge. The wrapper
 * (agent-wrapper.js) intercepts that token and runs the handover flow instead
 * of sending the reply.
 */
export const HANDOVER_TOKEN = '[[HANDOVER]]';

export async function initBrain({ memoryClient, knowledgeClient, systemPromptPath, knowledgeDir }) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error('GROQ_API_KEY is not set');
  const modelId = process.env.MODEL_ID || DEFAULT_MODEL_ID;

  const groq = createOpenAI({
    // GROQ_BASE_URL override exists for integration testing (points at a
    // local forward-proxy in tests); production default is Groq's endpoint.
    baseURL: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    apiKey: groqKey,
  });
  // NOTE: groq.chat(...) — NOT groq(...). The provider's default model
  // function targets OpenAI's Responses API, which Groq's OpenAI-compatible
  // endpoint rejects ("property 'input' is unsupported"). .chat() uses the
  // classic /chat/completions API. Verified end-to-end 2026-10-19.
  const model = groq.chat(modelId);

  const memory = createLibsqlMemory({ client: memoryClient });
  const knowledge = createKnowledge({ client: knowledgeClient });

  // Ingest every .md file in knowledge/ (re-ingest replaces that source's chunks).
  // Skipped: *.example.md templates and files starting with <!-- PLACEHOLDER -->.
  // TODO comments *inside* a real file are fine — the system prompt forbids
  // quoting them; they're the owner's private reminders.
  let ingestedChunks = 0;
  if (existsSync(knowledgeDir)) {
    for (const file of readdirSync(knowledgeDir).filter((f) => f.endsWith('.md'))) {
      if (file.toLowerCase() === 'readme.md' || file.endsWith('.example.md')) continue;
      const text = readFileSync(join(knowledgeDir, file), 'utf8');
      if (text.trimStart().startsWith('<!-- PLACEHOLDER')) continue;
      if (!text.trim()) continue;
      ingestedChunks += await knowledge.ingest(file, text);
    }
  }

  let systemPrompt;
  try {
    systemPrompt = readFileSync(systemPromptPath, 'utf8');
  } catch {
    throw new Error(`system prompt not found at ${systemPromptPath}`);
  }

  console.log(`[brain] model=${modelId} knowledge_chunks=${ingestedChunks}`);
  return { model, modelId, memory, knowledge, systemPrompt };
}

function toAiMessages(turns) {
  return turns
    .filter((t) => t.text && (t.role === 'user' || t.role === 'agent'))
    .slice(-20)
    .map((t) => ({
      role: t.role === 'agent' ? 'assistant' : 'user',
      content: t.text,
    }));
}

export async function think(brain, { contactId, userText }) {
  const history = await brain.memory.load(contactId).catch(() => []);
  const recalled = await brain.knowledge.recall(userText, { topK: 4 }).catch(() => []);
  const knowledgeText = recalled.map((c) => c.text).join('\n\n---\n\n');

  const system = knowledgeText
    ? `${brain.systemPrompt}\n\n## Business knowledge (use this to answer; never invent beyond it)\n${knowledgeText}`
    : brain.systemPrompt;

  const messages = [...toAiMessages(history), { role: 'user', content: userText }];

  const { text } = await generateText({
    model: brain.model,
    system,
    messages,
    maxOutputTokens: 800,
    temperature: 0.7,
  });
  return (text || '').trim();
}

export async function rememberTurn(brain, { contactId, role, text }) {
  await brain.memory
    .append({
      id: newTurnId(),
      contactId,
      role, // 'user' | 'agent'
      text,
      timestamp: Date.now(),
    })
    .catch((err) => console.warn('[brain] memory append failed:', err.message));
}

export async function recallRecent(brain, contactId, limit = 6) {
  const history = await brain.memory.load(contactId).catch(() => []);
  return history.slice(-limit);
}

export { ROOT };
