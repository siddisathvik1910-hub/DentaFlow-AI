// Shared test setup: isolated temp database per test file, demo clinic seeded, app served on a random port.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dentaflow-test-'));
process.env.DATA_DIR = dir;
process.env.DF_DISABLE_RATE_LIMIT = process.env.DF_DISABLE_RATE_LIMIT || '1';
process.env.ANTHROPIC_API_KEY = '';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.NODE_ENV = 'test';

const clock = require('../server/clock');
const { db } = require('../server/db');
const seed = require('../server/seed');
const core = require('../server/services/core');
const conversations = require('../server/services/conversations');

async function setup({ withHistory = false } = {}) {
  if (withHistory) await seed.seedDemo({ reset: true });
  else {
    // fast seed: catalog + patients + knowledge, no scripted history
    seed.resetAll();
    const c = seed.seedCoreForTests();
    return c;
  }
  const t = db.prepare('SELECT * FROM tenants LIMIT 1').get();
  const loc = db.prepare('SELECT * FROM locations LIMIT 1').get();
  return { tenantId: t.id, locId: loc.id };
}

async function startServer() {
  const { createApp } = require('../server/index');
  const app = createApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

// Run a scripted conversation; returns {conv, replies}
async function converse(locId, lines, { channel = 'voice', from = '+15125550888' } = {}) {
  const { conversation, greeting } = conversations.start({ locationId: locId, channel, externalId: 'test-' + Math.random(), from });
  const replies = [greeting];
  let last;
  for (const line of lines) {
    last = await conversations.turn({ conversationId: conversation.id, text: line });
    replies.push(last.reply);
    if (last.ended) break;
  }
  const conv = conversations.getConversation(conversation.id);
  return { id: conversation.id, conv, replies, last, state: JSON.parse(conv.state_json) };
}

// Pin the clock to a known Monday morning inside business hours (clinic is America/Chicago)
function pinClock(iso = '2026-10-05T14:00:00Z') { clock.setNow(new Date(iso)); } // Mon 9:00 AM CDT

module.exports = { dir, db, clock, core, setup, startServer, converse, pinClock, conversations, seed };
