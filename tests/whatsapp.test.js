/**
 * sendDirectText tests — the owner-alert path that bypasses the channel's
 * in-memory session-window guard (bug: alerts silently queued after every
 * restart). Run: npm test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendDirectText } from '../src/whatsapp.js';

describe('sendDirectText (owner alerts, direct Graph send)', () => {
  const saved = { id: process.env.WHATSAPP_PHONE_NUMBER_ID, tok: process.env.WHATSAPP_ACCESS_TOKEN };
  before(() => {
    process.env.WHATSAPP_PHONE_NUMBER_ID = '1363224640214900';
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
  });
  after(() => {
    if (saved.id === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = saved.id;
    if (saved.tok === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = saved.tok;
  });

  it('sends to the Graph messages endpoint and reports sent + messageId', async () => {
    let seen = null;
    const fetchImpl = async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.123' }] }) };
    };
    const r = await sendDirectText('+92 371-6248783', 'alert test', fetchImpl);
    assert.equal(r.status, 'sent');
    assert.equal(r.messageId, 'wamid.123');
    assert.ok(seen.url.endsWith('/1363224640214900/messages'));
    const body = JSON.parse(seen.opts.body);
    assert.equal(body.to, '923716248783');
    assert.equal(body.text.body, 'alert test');
    assert.equal(seen.opts.headers.Authorization, 'Bearer test-token');
  });

  it('surfaces Meta errors as failed + reason (never throws, never silent)', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Re-engagement message required', code: 131047 } }),
    });
    const r = await sendDirectText('923716248783', 'x', fetchImpl);
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /Re-engagement/);
  });

  it('network failure becomes failed + reason', async () => {
    const fetchImpl = async () => {
      throw new Error('socket hangup');
    };
    const r = await sendDirectText('923716248783', 'x', fetchImpl);
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /socket hangup/);
  });
});
