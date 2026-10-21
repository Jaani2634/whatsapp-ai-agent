/**
 * Signup "seedha link" flow tests (dialog URL + redirect callback).
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignupDialogUrl, createSignupFlow } from '../src/signup-link.js';

function fakeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body || '';
    },
  };
}

describe('buildSignupDialogUrl', () => {
  it('carries the config id, coexistence extras and the /signup-done redirect', () => {
    const url = buildSignupDialogUrl({
      state: 'abc123',
      origin: 'https://7a9ngx.bot-keep.xyz',
    });
    assert.match(url, /^https:\/\/www\.facebook\.com\/v21\.0\/dialog\/oauth\?/);
    assert.match(url, /config_id=2098823957505970/);
    assert.match(url, /response_type=code/);
    assert.match(url, /state=abc123/);
    const decoded = decodeURIComponent(url);
    assert.match(decoded, /whatsapp_business_app_onboarding/);
    assert.match(decoded, /sessionInfoVersion/);
    assert.match(decoded, /redirect_uri=https:\/\/7a9ngx\.bot-keep\.xyz\/signup-done/);
  });
});

describe('createSignupFlow.handleDone', () => {
  it('stores the code, notifies the owner and shows the code on a matching callback', async () => {
    const saved = [];
    const notes = [];
    const flow = createSignupFlow({
      saveCode: (c) => saved.push(c),
      notify: async (t) => notes.push(t),
    });
    const dialog = flow.dialogUrl('https://7a9ngx.bot-keep.xyz');
    const state = new URL(dialog).searchParams.get('state');
    const res = fakeRes();
    await flow.handleDone(
      new URL(`https://x/signup-done?code=CODE42&state=${state}`),
      res,
    );
    assert.deepEqual(saved, ['CODE42']);
    assert.equal(notes.length, 1);
    assert.equal(res.status, 200);
    assert.match(res.body, /CODE42/);
  });

  it('rejects a callback whose state does not match (code is not stored)', async () => {
    const saved = [];
    const flow = createSignupFlow({ saveCode: (c) => saved.push(c) });
    flow.dialogUrl('https://7a9ngx.bot-keep.xyz');
    const res = fakeRes();
    await flow.handleDone(
      new URL('https://x/signup-done?code=CODE42&state=WRONG'),
      res,
    );
    assert.deepEqual(saved, []);
    assert.match(res.body, /purana/);
  });

  it('shows an error page (and stores nothing) when Facebook returns an error', async () => {
    const saved = [];
    const flow = createSignupFlow({ saveCode: (c) => saved.push(c) });
    flow.dialogUrl('https://7a9ngx.bot-keep.xyz');
    const res = fakeRes();
    await flow.handleDone(
      new URL('https://x/signup-done?error=access_denied&error_description=User+stopped'),
      res,
    );
    assert.deepEqual(saved, []);
    assert.match(res.body, /User stopped/);
  });
});
