// Twilio webhooks. Voice uses <Gather input="speech"> turn-taking, so a real phone number works with only
// Twilio credentials. (For lowest latency, swap this for a streaming voice gateway; the orchestrator is unchanged.)
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const cfg = require('../config');
const core = require('../services/core');
const conversations = require('../services/conversations');
const inbound = require('../services/inbound');

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '100kb' }));

// Validate X-Twilio-Signature when an auth token is configured
function twilioAuth(req, res, next) {
  if (!cfg.twilio.token) return next(); // development / simulator
  const url = cfg.baseUrl + req.originalUrl;
  const params = req.body || {};
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', cfg.twilio.token).update(data).digest('base64');
  const given = String(req.headers['x-twilio-signature'] || '');
  const ok = expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  if (!ok) return res.status(403).type('text/plain').send('Invalid signature');
  next();
}
router.use(twilioAuth);

const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const xml = (res, body) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
const VOICE = 'Polly.Joanna';
const say = (t) => `<Say voice="${VOICE}">${x(t)}</Say>`;
const gather = (cid, prompt) => `<Gather input="speech" action="/webhooks/twilio/voice/turn?cid=${encodeURIComponent(cid)}" method="POST" speechTimeout="auto" language="en-US" actionOnEmptyResult="true" hints="appointment, cleaning, checkup, toothache, insurance, reschedule, cancel">${say(prompt)}</Gather>`;

function locationForNumber(to) {
  const row = db.prepare("SELECT * FROM phone_numbers WHERE e164=? AND status='active'").get(core.normalizePhone(to));
  if (!row) return null;
  return { number: row, loc: core.getLocation(row.location_id) };
}

function startAgent(res, loc, callSid, from) {
  const { conversation, greeting } = conversations.start({ locationId: loc.id, channel: 'voice', externalId: callSid, from });
  return xml(res, gather(conversation.id, greeting || conversations.greeting(loc, 'voice')) + say("I didn't hear anything. Please call back any time. Goodbye."));
}

router.post('/voice', (req, res) => {
  const { CallSid, From, To } = req.body || {};
  const found = locationForNumber(To);
  if (!found) return xml(res, say('Sorry, this number is not configured. Goodbye.') + '<Hangup/>');
  const { number, loc } = found;
  const mode = number.routing_mode || loc.settings.routing_mode || 'always';
  const dest = number.forward_to || loc.settings.transfer_number;
  const open = core.isOpenNow(loc);
  if (dest && ((mode === 'after_hours' && open) || mode === 'overflow')) {
    const ring = mode === 'overflow' ? loc.settings.overflow_ring_seconds || 15 : 25;
    return xml(res, `<Dial timeout="${ring}" action="/webhooks/twilio/voice/fallback?loc=${loc.id}" method="POST"><Number>${x(dest)}</Number></Dial>`);
  }
  return startAgent(res, loc, CallSid, From);
});

// Office did not answer (overflow) or hung up: hand the call to the agent
router.post('/voice/fallback', (req, res) => {
  const { DialCallStatus, CallSid, From } = req.body || {};
  if (DialCallStatus === 'completed') return xml(res, '<Hangup/>');
  const loc = core.getLocation(req.query.loc);
  if (!loc) return xml(res, '<Hangup/>');
  return startAgent(res, loc, CallSid, From);
});

router.post('/voice/turn', async (req, res) => {
  const cid = String(req.query.cid || '');
  const conv = conversations.getConversation(cid);
  if (!conv) return xml(res, say('Sorry, something went wrong. Goodbye.') + '<Hangup/>');
  const speech = String((req.body || {}).SpeechResult || '').trim();
  const confidence = parseFloat((req.body || {}).Confidence || '') || null;
  try {
    if (!speech) {
      const st = JSON.parse(conv.state_json || '{}');
      st.empty = (st.empty || 0) + 1;
      db.prepare('UPDATE conversations SET state_json=? WHERE id=?').run(JSON.stringify(st), cid);
      if (st.empty >= 3) { conversations.finalize(cid, 'silence'); return xml(res, say("I'm having trouble hearing you. Please call back any time. Goodbye.") + '<Hangup/>'); }
      return xml(res, gather(cid, st.empty === 1 ? "Sorry, I didn't catch that. How can I help you?" : 'Are you still there? You can tell me what you need.'));
    }
    const r = await conversations.turn({ conversationId: cid, text: speech, confidence });
    if (r.transfer && r.transfer.to) return xml(res, say(r.reply) + `<Dial timeout="25">${x(r.transfer.to)}</Dial>` + say('Sorry, nobody is available right now. We will call you back. Goodbye.'));
    if (r.ended) return xml(res, say(r.reply) + '<Hangup/>');
    return xml(res, gather(cid, r.reply) + say('Goodbye.'));
  } catch (e) {
    console.error('[voice turn]', e);
    return xml(res, say("I'm sorry, I'm having a technical problem. Our team will call you back. Goodbye.") + '<Hangup/>');
  }
});

router.post('/voice/status', (req, res) => {
  const { CallSid, CallStatus } = req.body || {};
  if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(CallStatus)) {
    const c = db.prepare("SELECT id FROM conversations WHERE external_id=? AND channel='voice' AND status='active'").get(CallSid);
    if (c) conversations.finalize(c.id, 'hangup');
  }
  res.sendStatus(204);
});

router.post('/sms', async (req, res) => {
  const { From, To, Body } = req.body || {};
  const found = locationForNumber(To);
  if (!found) return xml(res, '');
  try {
    const r = await inbound.handleSms({ locationId: found.loc.id, from: From, body: Body });
    return xml(res, r.reply ? `<Message>${x(r.reply)}</Message>` : '');
  } catch (e) { console.error('[sms]', e); return xml(res, '<Message>Sorry, something went wrong. Please call the office.</Message>'); }
});

module.exports = router;
