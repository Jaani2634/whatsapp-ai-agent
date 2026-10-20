/**
 * whatsapp.js — Cloud API channel setup + small send helpers.
 *
 * Uses @wappy_ai/whatsapp's createWhatsAppChannel (handles Meta's real API
 * quirks: session window, retries, rich-message fallbacks) and its
 * createWebhookServer (GET handshake + X-Hub-Signature-256 verification).
 */
import { systemClock } from '@wappy_ai/core';
import { createWhatsAppChannel, createWebhookServer } from '@wappy_ai/whatsapp';

export function createChannel() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN must be set');
  }
  return createWhatsAppChannel({ phoneNumberId, accessToken, clock: systemClock });
}

export async function sendText(channel, to, text) {
  return channel.send(to, { text });
}

/**
 * Direct Graph API send that BYPASSES the channel's session-window guard.
 *
 * Why this exists (bug found Oct 20): the SDK's send() checks an IN-MEMORY
 * 24h-window tracker. Every restart wipes it, so after a restart the bot
 * believed the owner "hadn't messaged in 24h" and silently QUEUED the
 * handover alert — no error, no delivery. Owner alerts must never depend
 * on that tracker: they go straight to Meta. If Meta itself rejects
 * (e.g. the owner's real 24h window is closed), the caller gets a visible
 * { status: 'failed', reason } instead of silence.
 */
export async function sendDirectText(to, text, fetchImpl = fetch) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    return { status: 'failed', reason: 'WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN not set' };
  }
  try {
    const res = await fetchImpl(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(to).replace(/\D/g, ''),
        type: 'text',
        text: { body: text },
      }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.messages?.[0]?.id) {
      return { status: 'sent', messageId: data.messages[0].id };
    }
    const reason = data?.error?.message || `graph HTTP ${res.status}`;
    return { status: 'failed', reason };
  } catch (err) {
    return { status: 'failed', reason: err.message };
  }
}

export function createServer({ channel, agent }) {
  const verifyToken = process.env.VERIFY_TOKEN;
  const appSecret = process.env.APP_SECRET;
  if (!verifyToken || !appSecret) {
    throw new Error('VERIFY_TOKEN and APP_SECRET must be set (Meta webhook handshake + signature verification)');
  }
  return createWebhookServer({
    verifyToken,
    appSecret,
    channel,
    agent,
    path: '/webhook',
    onError: (err) => console.error('[webhook] error:', err?.message || err),
  });
}
