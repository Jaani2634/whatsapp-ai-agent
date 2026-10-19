/**
 * handover.js — human-handover state machine (SQLite via @libsql/client).
 *
 * Per-chat states: 'bot_active' (default) | 'handed_over'.
 *
 * Triggers (checked in agent-wrapper.js, in order):
 *   1. Owner commands:  `resume <number>` / `pause <number>` / `status`
 *      (only honoured when sent from OWNER_PHONE_NUMBER).
 *   2. Chat already handed over -> bot stays silent.
 *   3. Customer asks for a human (keywords, EN + Roman Urdu) -> handover.
 *   4. Sensitive topic configured in HANDOVER_SENSITIVE_TOPICS -> handover.
 *   5. Brain emits the [[HANDOVER]] token (can't answer / customer asked) -> handover.
 *
 * On handover: state flips, the customer gets a Roman Urdu auto-reply, and the
 * owner gets a WhatsApp message with a summary + recent turns.
 * On resume: state flips back, customer is notified the bot is back.
 */

export const STATES = { BOT_ACTIVE: 'bot_active', HANDED_OVER: 'handed_over' };

// Customer asks for a human — English + Roman Urdu/Urdu (latin script).
const HUMAN_PATTERNS = [
  /\bhuman\b/i,
  /\bagent\b/i,
  /\boperator\b/i,
  /\breal person\b/i,
  /\binsan\b/i, // انسان
  /numa[yi]+nda/i, // نمائندہ (numainda / numayinda / numaainda)
  /asli\s*banda/i, // اصلی بندہ
  /kisi\s*(se|sy)\s*baat/i, // "kisi se baat karni hai"
  /\bcall\s*(kar|karo|karein|krein|krdo|krdein)\b/i, // "call karo"
  /phone\s*(kar|karo|karein|pe\s*baat)/i,
  /manager\s*(se|sy)\s*(baat|milna)/i,
  /malik\s*(se|sy)\s*baat/i,
];

function defaultSensitiveTopics() {
  const raw = process.env.HANDOVER_SENSITIVE_TOPICS || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function wantsHuman(text) {
  if (!text) return false;
  return HUMAN_PATTERNS.some((re) => re.test(text));
}

export function hasSensitiveTopic(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return defaultSensitiveTopics().some((t) => lower.includes(t));
}

export function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

export class HandoverStore {
  constructor(client) {
    this.client = client;
  }

  async init() {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS chat_state (
        contact_id   TEXT PRIMARY KEY,
        state        TEXT NOT NULL DEFAULT '${STATES.BOT_ACTIVE}',
        reason       TEXT,
        summary      TEXT,
        handed_over_at INTEGER,
        updated_at   INTEGER NOT NULL
      )
    `);
  }

  async get(contactId) {
    const rs = await this.client.execute({
      sql: 'SELECT state, reason, summary, handed_over_at FROM chat_state WHERE contact_id = ?',
      args: [contactId],
    });
    if (rs.rows.length === 0) return { state: STATES.BOT_ACTIVE, reason: null, summary: null, handedOverAt: null };
    const r = rs.rows[0];
    return { state: r.state, reason: r.reason, summary: r.summary, handedOverAt: r.handed_over_at };
  }

  async isHandedOver(contactId) {
    return (await this.get(contactId)).state === STATES.HANDED_OVER;
  }

  async handover(contactId, reason, summary = null) {
    const now = Date.now();
    await this.client.execute({
      sql: `INSERT INTO chat_state (contact_id, state, reason, summary, handed_over_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(contact_id) DO UPDATE SET
              state=excluded.state, reason=excluded.reason, summary=excluded.summary,
              handed_over_at=excluded.handed_over_at, updated_at=excluded.updated_at`,
      args: [contactId, STATES.HANDED_OVER, reason, summary, now, now],
    });
  }

  async resume(contactId) {
    await this.client.execute({
      sql: `INSERT INTO chat_state (contact_id, state, reason, summary, handed_over_at, updated_at)
            VALUES (?, '${STATES.BOT_ACTIVE}', NULL, NULL, NULL, ?)
            ON CONFLICT(contact_id) DO UPDATE SET
              state='${STATES.BOT_ACTIVE}', reason=NULL, summary=NULL,
              handed_over_at=NULL, updated_at=excluded.updated_at`,
      args: [contactId, Date.now()],
    });
  }

  async listHandedOver() {
    const rs = await this.client.execute(
      `SELECT contact_id, reason, handed_over_at FROM chat_state WHERE state = '${STATES.HANDED_OVER}' ORDER BY handed_over_at DESC`,
    );
    return rs.rows.map((r) => ({ contactId: r.contact_id, reason: r.reason, handedOverAt: r.handed_over_at }));
  }
}

/** Parse owner commands: "resume <number>", "pause <number>", "status", "notes". */
export function parseOwnerCommand(text) {
  const m = /^\s*(resume|pause|status|notes)\b\s*([+\d][\d\s-]*)?\s*$/i.exec(text || '');
  if (!m) return null;
  if ((m[1].toLowerCase() === 'resume' || m[1].toLowerCase() === 'pause') && !m[2]) return null;
  return { action: m[1].toLowerCase(), target: normalizePhone(m[2] || '') || null };
}

export const CUSTOMER_HANDOVER_REPLY =
  'Aapki baat hamare numainde tak pahuncha di hai. Wo jald aap se rabta karega. Shukriya! 🙏';

export const CUSTOMER_RESUME_REPLY =
  'Assalam-o-Alaikum! Main wapas aa gaya hoon — batayein, main aapki kya madad kar sakta hoon?';

export function ownerHandoverAlert({ customerNumber, reason, recentTurns }) {
  const lines = (recentTurns || []).map(
    (t) => `${t.role === 'agent' ? '🤖 Bot' : '👤 Customer'}: ${(t.text || '').slice(0, 300)}`,
  );
  return [
    '🔔 *Handover alert*',
    `Customer: +${customerNumber}`,
    `Reason: ${reason}`,
    '',
    'Recent messages:',
    ...lines.slice(-6),
    '',
    `Reply here with: resume ${customerNumber}`,
  ].join('\n');
}
