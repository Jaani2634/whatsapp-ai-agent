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
