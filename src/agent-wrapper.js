/**
 * agent-wrapper.js — the Agent implementation handed to the webhook server.
 *
 * Pipeline per inbound message:
 *   1. Owner commands (from OWNER_PHONE_NUMBER): resume|pause|status
 *   2. Handover state check — handed-over chats get silence (no reply)
 *   3. Media -> text (voice notes, images, videos) via media.js
 *   4. Human-request keywords / sensitive topics -> handover
 *   5. Brain reply (Groq) -> memory persisted
 *   6. [[HANDOVER]] token from the brain -> take a note + alert owner,
 *      but KEEP CHATTING (never pause from here — pause is step 4 only)
 *   7. Send reply via the WhatsApp channel
 *
 * Nothing here throws to the webhook server: every step degrades to a safe
 * fallback reply instead of crashing the process.
 */
import {
  HandoverStore,
  wantsHuman,
  hasSensitiveTopic,
  parseOwnerCommand,
  normalizePhone,
  CUSTOMER_HANDOVER_REPLY,
  CUSTOMER_RESUME_REPLY,
  ownerHandoverAlert,
} from './handover.js';
import { HANDOVER_TOKEN, think, rememberTurn, recallRecent } from './brain.js';
import { mediaToText } from './media.js';
import { sendText } from './whatsapp.js';

const MEDIA_KINDS = new Set(['voice', 'audio', 'image', 'video', 'document', 'location']);

const FALLBACK_REPLY =
  'Maazrat, is waqt jawab dene mein dikkat ho rahi hai. Thodi der baad dobara koshish karein. 🙏';

// Brain wanted to bail (token) but the customer never explicitly asked for a
// human in THIS message: keep the chat alive, take the note, alert the owner —
// do NOT hand over. Per the owner (Oct 20): the bot keeps chatting; handover
// happens only on an explicit "mujh se baat karni hai" in the current message
// (step 4) — never from stale conversation context.
const TAKE_MESSAGE_REPLY =
  'Ye baat main ne note kar li hai aur Junaid tak pahuncha di hai — wo khud aap ko is ka jawab de dega. Tab tak, aap kuch aur batayein? 😊';

export function createHandoverAgent({ channel, brain, handover, mediaCtx, ownerNumber, memoryClient }) {
  async function doHandover(customerNumber, reason) {
    const recent = await recallRecent(brain, customerNumber, 6);
    const summary = recent
      .map((t) => `${t.role === 'agent' ? 'Bot' : 'Customer'}: ${(t.text || '').slice(0, 200)}`)
      .join('\n');
    await handover.handover(customerNumber, reason, summary);
    // 1) customer auto-reply (Roman Urdu)
    await sendText(channel, customerNumber, CUSTOMER_HANDOVER_REPLY).catch((e) =>
      console.warn('[handover] customer auto-reply failed:', e.message),
    );
    // 2) owner alert with summary + resume command
    const alert = ownerHandoverAlert({ customerNumber, reason, recentTurns: recent });
    await sendText(channel, ownerNumber, alert).catch((e) =>
      console.warn('[handover] owner alert failed:', e.message),
    );
    console.log(`[handover] ${customerNumber} -> human (reason: ${reason})`);
  }

  async function handleOwnerCommand(from, text) {
    const cmd = parseOwnerCommand(text);
    if (!cmd) return null; // not a command — owner chat is command-only (see below)
    if (cmd.action === 'status') {
      const list = await handover.listHandedOver();
      const body =
        list.length === 0
          ? 'Koi handed-over chat nahi hai. Sab chats par bot active hai. ✅'
          : `Handed-over chats (${list.length}):\n` +
            list.map((h) => `• +${h.contactId} — ${h.reason}`).join('\n');
      await sendText(channel, from, body);
      return { status: 'sent', reason: 'owner_status' };
    }
    if (cmd.action === 'notes') {
      // Recent customer messages (last 24h) across all chats — the bot's
      // message-taking log. Memory turns are timestamped per message.
      const since = Date.now() - 24 * 3600 * 1000;
      let rows = [];
      try {
        const rs = await memoryClient.execute({
          sql: `SELECT contactId, text, timestamp FROM turns WHERE role = 'user' AND timestamp > ? ORDER BY timestamp DESC LIMIT 15`,
          args: [since],
        });
        rows = rs.rows;
      } catch (err) {
        console.warn('[notes] query failed:', err.message);
      }
      const body =
        rows.length === 0
          ? 'Pichlay 24 ghanton mein koi naya message nahi. 📭'
          : 'Pichlay 24 ghanton ke messages:\n' +
            rows
              .map((r) => {
                const t = new Date(Number(r.timestamp));
                const hh = String(t.getHours()).padStart(2, '0');
                const mm = String(t.getMinutes()).padStart(2, '0');
                return `• +${r.contactId} (${hh}:${mm}): ${(r.text || '').slice(0, 160)}`;
              })
              .join('\n');
      await sendText(channel, from, body);
      return { status: 'sent', reason: 'owner_notes' };
    }
    if (!cmd.target) {
      await sendText(channel, from, 'Number missing. Masalan: resume 923001234567');
      return { status: 'sent', reason: 'owner_bad_command' };
    }
    if (cmd.action === 'resume') {
      await handover.resume(cmd.target);
      await sendText(channel, from, `✅ Bot wapas active: +${cmd.target}`);
      await sendText(channel, cmd.target, CUSTOMER_RESUME_REPLY).catch(() => {});
      console.log(`[handover] resumed bot for ${cmd.target} (by owner)`);
      return { status: 'sent', reason: 'owner_resume' };
    }
    if (cmd.action === 'pause') {
      await handover.handover(cmd.target, 'paused_by_owner', null);
      await sendText(channel, from, `⏸️ Bot paused for +${cmd.target}. Wapas ke liye: resume ${cmd.target}`);
      console.log(`[handover] paused bot for ${cmd.target} (by owner)`);
      return { status: 'sent', reason: 'owner_pause' };
    }
    return null;
  }

  return {
    /** Implements @wappy_ai/core's Agent interface. */
    async handle(message) {
      const from = normalizePhone(message.contactId);
      try {
        // 1) Owner commands
        if (from === ownerNumber && message.text) {
          const cmdResult = await handleOwnerCommand(from, message.text);
          if (cmdResult) return cmdResult;
          // Owner sent a non-command text: don't run the customer brain on it.
          return { status: 'sent', reason: 'owner_non_command_ignored' };
        }

        // 2) Handover state — silence while a human owns the chat
        if (await handover.isHandedOver(from)) {
          return { status: 'sent', reason: 'handed_over_silent' };
        }

        // 3) Media -> text
        let userText = (message.text || '').trim();
        if (!userText && message.media && MEDIA_KINDS.has(message.media.kind)) {
          try {
            userText = await mediaToText(message, mediaCtx);
            console.log(`[media] ${from} ${message.media.kind} -> ${userText.slice(0, 80)}...`);
          } catch (err) {
            console.warn('[media] pipeline failed:', err.message);
            userText = `[${message.media.kind} received but could not be processed]`;
          }
        }
        if (!userText) return { status: 'sent', reason: 'empty_message' };

        await rememberTurn(brain, { contactId: from, role: 'user', text: userText });

        // 4) Explicit human request / sensitive topic -> handover before the brain
        if (wantsHuman(userText)) {
          await doHandover(from, 'customer_asked_for_human');
          return { status: 'sent', reason: 'handover' };
        }
        if (hasSensitiveTopic(userText)) {
          await doHandover(from, 'sensitive_topic');
          return { status: 'sent', reason: 'handover' };
        }

        // 5) Brain
        let replyText;
        try {
          replyText = await think(brain, { contactId: from, userText });
        } catch (err) {
          console.error('[brain] failed:', err.message);
          await sendText(channel, from, FALLBACK_REPLY);
          return { status: 'sent', reason: 'brain_error_fallback' };
        }
        if (!replyText) {
          await sendText(channel, from, FALLBACK_REPLY);
          return { status: 'sent', reason: 'empty_reply_fallback' };
        }

        // 6) Brain wanted to hand over — but step 4 already handled explicit
        // requests in THIS message. A token here means "I can't answer /
        // stale context" → take a note, alert the owner, KEEP CHATTING.
        // The chat is never paused from here.
        if (replyText.includes(HANDOVER_TOKEN)) {
          const cleaned = replyText.replaceAll(HANDOVER_TOKEN, '').trim();
          const noteReply = cleaned || TAKE_MESSAGE_REPLY;
          console.log(`[note] ${from} brain bailed; note taken, chat stays active`);
          await sendText(
            channel,
            ownerNumber,
            `📝 Note: +${from} ne kaha: "${userText.slice(0, 200)}"\nBot is ka jawab nahi de paya — baat note karke chat jaari rakhi hai. (Poori list: notes)`,
          ).catch((e) => console.warn('[note] owner alert failed:', e.message));
          await rememberTurn(brain, { contactId: from, role: 'agent', text: noteReply });
          const noteResult = await sendText(channel, from, noteReply);
          return { ...noteResult, reason: 'note_taken' };
        }

        // 7) Send
        await rememberTurn(brain, { contactId: from, role: 'agent', text: replyText });
        const result = await sendText(channel, from, replyText);
        return result;
      } catch (err) {
        console.error('[agent] unexpected error:', err.message);
        return { status: 'failed', reason: err.message };
      }
    },
  };
}

export { HandoverStore };
