/**
 * Signup "seedha link" flow (no JS SDK, no popup):
 *   GET /signup2     -> 302 to the Facebook Login-for-Business dialog URL
 *                       (full-page redirect, config_id + coexistence extras)
 *   GET /signup-done -> Facebook redirects here with ?code=... after the flow.
 *                       The code is saved + the owner is alerted, and the page
 *                       shows the code so it can also be passed on manually.
 *
 * Why: the JS-SDK popup flow keeps dying on the owner's phone (FB "zero"
 * free-mode 404, incognito cookie blocks, dead dialog pages). A plain
 * full-page OAuth redirect has none of those moving parts.
 */
import { randomBytes } from 'node:crypto';

export const SIGNUP_APP_ID = '1788187335823696';
export const SIGNUP_CONFIG_ID = '2098823957505970';
const STATE_TTL_MS = 15 * 60 * 1000;

export function buildSignupDialogUrl({ state, origin }) {
  const extras = encodeURIComponent(
    JSON.stringify({
      setup: {},
      featureType: 'whatsapp_business_app_onboarding',
      sessionInfoVersion: '3',
    }),
  );
  const redirect = encodeURIComponent(`${origin}/signup-done`);
  return (
    `https://www.facebook.com/v21.0/dialog/oauth?client_id=${SIGNUP_APP_ID}` +
    `&config_id=${SIGNUP_CONFIG_ID}&response_type=code` +
    `&override_default_response_type=true&redirect_uri=${redirect}` +
    `&state=${encodeURIComponent(state)}&extras=${extras}`
  );
}

function pageShell(title, body) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#0b141a;color:#e9edef;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:520px;width:92%;background:#111b21;border-radius:16px;padding:28px}
code{display:block;background:#202c33;border-radius:10px;padding:14px;font-size:15px;word-break:break-all;margin-top:12px}
p{color:#aebac1;line-height:1.5}</style></head>
<body><div class="card">${body}</div></body></html>`;
}

export function signupFinishHtml(code) {
  return pageShell(
    'Signup code mil gaya',
    `<h1>✅ Ho gaya!</h1>
     <p>Facebook ka flow mukammal ho gaya. Ye code Gimi ko bhej dein
        (aksar ye khud hi Gimi tak pohonch jata hai — screenshot bhi kaafi hai):</p>
     <code>${code}</code>
     <p>Baaki kaam — token aur bot ki settings — Gimi khud karega.</p>`,
  );
}

export function signupErrorHtml(message) {
  return pageShell(
    'Signup masla',
    `<h1>⚠️ Kuch masla huwa</h1><p>${message}</p>
     <p>Is screen ka screenshot Gimi ko bhej dein.</p>`,
  );
}

/**
 * @param {{ saveCode: (code: string) => void,
 *           notify?: (text: string) => Promise<unknown>,
 *           now?: () => number }} deps
 */
export function createSignupFlow({ saveCode, notify, now = Date.now }) {
  let pending = null;
  return {
    dialogUrl(origin) {
      pending = { state: randomBytes(8).toString('hex'), at: now() };
      return buildSignupDialogUrl({ state: pending.state, origin });
    },
    async handleDone(url, res) {
      const send = (html) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      };
      const err =
        url.searchParams.get('error_description') || url.searchParams.get('error');
      if (err) {
        console.error('[signup] flow returned error:', err);
        return send(signupErrorHtml(`Facebook ne flow rok diya: ${err}`));
      }
      const code = url.searchParams.get('code');
      if (!code) {
        return send(signupErrorHtml('Facebook se code nahi mila — flow adhoora raha.'));
      }
      const state = url.searchParams.get('state');
      if (!pending || state !== pending.state || now() - pending.at > STATE_TTL_MS) {
        console.warn('[signup] callback with unknown/expired state — code not stored');
        return send(
          signupErrorHtml(
            'Ye link purana ho gaya tha. Gimi ko bata dein — wo naya link bhej dega.',
          ),
        );
      }
      pending = null;
      try {
        saveCode(code);
      } catch (e) {
        console.error('[signup] could not save code:', e.message);
      }
      console.log('[signup] coexistence code received via redirect flow');
      if (notify) {
        try {
          await notify(
            '✅ WhatsApp coexistence: signup code mil gaya hai. Token exchange shuru kar raha hoon.',
          );
        } catch {
          /* the alert is best-effort; the code is saved regardless */
        }
      }
      return send(signupFinishHtml(code));
    },
  };
}
