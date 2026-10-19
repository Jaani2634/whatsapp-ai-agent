/**
 * Handover state machine + keyword/command tests.
 * Run: npm test
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import {
  HandoverStore,
  STATES,
  wantsHuman,
  hasSensitiveTopic,
  parseOwnerCommand,
  normalizePhone,
  ownerHandoverAlert,
} from '../src/handover.js';

describe('HandoverStore', () => {
  let store;
  before(async () => {
    store = new HandoverStore(createClient({ url: ':memory:' }));
    await store.init();
  });

  it('defaults to bot_active for unknown chats', async () => {
    const s = await store.get('923001234567');
    assert.equal(s.state, STATES.BOT_ACTIVE);
    assert.equal(await store.isHandedOver('923001234567'), false);
  });

  it('handover flips state with reason + summary', async () => {
    await store.handover('923001234567', 'customer_asked_for_human', 'asked about prices');
    const s = await store.get('923001234567');
    assert.equal(s.state, STATES.HANDED_OVER);
    assert.equal(s.reason, 'customer_asked_for_human');
    assert.equal(s.summary, 'asked about prices');
    assert.equal(await store.isHandedOver('923001234567'), true);
  });

  it('resume flips back to bot_active', async () => {
    await store.resume('923001234567');
    const s = await store.get('923001234567');
    assert.equal(s.state, STATES.BOT_ACTIVE);
    assert.equal(await store.isHandedOver('923001234567'), false);
  });

  it('listHandedOver only lists handed-over chats', async () => {
    await store.handover('923000000001', 'sensitive_topic');
    await store.handover('923000000002', 'brain_could_not_answer');
    await store.resume('923000000002');
    const list = await store.listHandedOver();
    const ids = list.map((h) => h.contactId);
    assert.ok(ids.includes('923000000001'));
    assert.ok(!ids.includes('923000000002'));
  });

  it('state survives re-init (table persists)', async () => {
    const store2 = new HandoverStore(store.client);
    await store2.init();
    assert.equal(await store2.isHandedOver('923000000001'), true);
  });
});

describe('wantsHuman keywords', () => {
  const positives = [
    'can I talk to a human please',
    'connect me to an agent',
    'I want to speak to the operator',
    'koi insan hai?',
    'numainda se baat karni hai',
    'numayinda chahiye',
    'asli banda lao',
    'kisi se baat karni hai mujhe',
    'call karo mujhe',
    'phone pe baat karni hai',
    'manager se baat karwao',
  ];
  for (const t of positives) {
    it(`detects: "${t}"`, () => assert.equal(wantsHuman(t), true));
  }
  const negatives = ['humanity is great', 'yeh kitne ka hai?', 'shukriya', 'ok', ''];
  for (const t of negatives) {
    it(`ignores: "${t}"`, () => assert.equal(wantsHuman(t), false));
  }
});

describe('sensitive topics', () => {
  it('matches configured topics only', () => {
    process.env.HANDOVER_SENSITIVE_TOPICS = 'refund,chargeback';
    assert.equal(hasSensitiveTopic('I want a refund please'), true);
    assert.equal(hasSensitiveTopic('yeh kitne ka hai?'), false);
    delete process.env.HANDOVER_SENSITIVE_TOPICS;
    assert.equal(hasSensitiveTopic('I want a refund please'), false);
  });
});

describe('owner commands', () => {
  it('parses resume/pause/status/notes', () => {
    assert.deepEqual(parseOwnerCommand('resume 923001234567'), { action: 'resume', target: '923001234567' });
    assert.deepEqual(parseOwnerCommand('pause +92 300 1234567'), { action: 'pause', target: '923001234567' });
    assert.deepEqual(parseOwnerCommand('status'), { action: 'status', target: null });
    assert.deepEqual(parseOwnerCommand('notes'), { action: 'notes', target: null });
    assert.equal(parseOwnerCommand('hello ji'), null);
    assert.equal(parseOwnerCommand('resume'), null);
    assert.equal(parseOwnerCommand('pause'), null);
  });

  it('normalizePhone strips formatting', () => {
    assert.equal(normalizePhone('+92 300-1234567'), '923001234567');
  });

  it('owner alert contains summary + resume command', () => {
    const alert = ownerHandoverAlert({
      customerNumber: '923001234567',
      reason: 'customer_asked_for_human',
      recentTurns: [
        { role: 'user', text: 'price kya hai?' },
        { role: 'agent', text: 'Rs 500' },
      ],
    });
    assert.ok(alert.includes('+923001234567'));
    assert.ok(alert.includes('resume 923001234567'));
    assert.ok(alert.includes('price kya hai?'));
  });
});
