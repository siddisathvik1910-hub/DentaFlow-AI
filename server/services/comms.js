// Tasks, outbound messaging (SMS) and emergency triage.
const { db, uid, nowIso, j, parse } = require('../db');
const cfg = require('../config');
const clock = require('../clock');
const tz = require('../tz');
const core = require('./core');
const patients = require('./patients');

// ---------------------------------------------------------------- Tasks
function createTask({ tenantId, locationId, kind, title, urgency = 'normal', patientId = null, conversationId = null, payload = null, dueAt = null }) {
  // De-duplicate identical open tasks for the same conversation
  if (conversationId) {
    const dup = db.prepare("SELECT id FROM tasks WHERE conversation_id=? AND kind=? AND title=? AND status='open'").get(conversationId, kind, title);
    if (dup) return dup.id;
  }
  const id = uid();
  db.prepare(`INSERT INTO tasks (id,tenant_id,location_id,kind,status,urgency,patient_id,conversation_id,title,payload_json,due_at,created_at)
              VALUES (?,?,?,?, 'open',?,?,?,?,?,?,?)`)
    .run(id, tenantId, locationId, kind, urgency, patientId, conversationId, title, payload ? j(payload) : null, dueAt, nowIso());
  core.emit(tenantId, 'task.created', { id, kind, title, urgency });
  if (urgency === 'urgent') notifyStaff(tenantId, locationId, `URGENT: ${title}`);
  return id;
}

function notifyStaff(tenantId, locationId, text) {
  const loc = core.getLocation(locationId);
  for (const phone of loc.settings.notify_phones || []) {
    send({ tenantId, locationId, to: phone, body: `[DentaFlow] ${text}`, kind: 'staff_alert', purpose: 'staff', skipConsent: true });
  }
  for (const email of loc.settings.notify_emails || []) {
    db.prepare("INSERT INTO outbox (id,tenant_id,location_id,channel,to_addr,body,kind,status,provider,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(uid(), tenantId, locationId, 'email', email, `[DentaFlow] ${text}`, 'staff_alert', 'simulated', 'simulated', nowIso());
  }
}

// ---------------------------------------------------------------- Messaging
const QUIET_START = 21 * 60; // 9 PM local
const QUIET_END = 8 * 60;    // 8 AM local
function inQuietHours(loc, at = clock.now()) {
  const m = tz.local(at, loc.timezone).minutes;
  return m >= QUIET_START || m < QUIET_END;
}

// Sends via Twilio when configured, otherwise records a simulated message so everything is testable offline.
function send({ tenantId, locationId, patientId = null, to, body, kind = 'message', purpose = 'transactional', conversationId = null, skipConsent = false, from = null }) {
  const phone = core.normalizePhone(to);
  const id = uid();
  const rec = (status, provider, extra = {}) => {
    db.prepare(`INSERT INTO outbox (id,tenant_id,location_id,patient_id,channel,to_addr,body,kind,status,provider,provider_sid,error,conversation_id,created_at)
                VALUES (?,?,?,?, 'sms',?,?,?,?,?,?,?,?,?)`)
      .run(id, tenantId, locationId, patientId, phone, body, kind, status, provider, extra.sid || null, extra.error || null, conversationId, nowIso());
    core.emit(tenantId, 'message.sent', { id, kind, status });
    return { id, status, ...extra };
  };
  if (!phone) return rec('failed', 'none', { error: 'no phone number' });
  if (!skipConsent && !patients.canText(phone, purpose)) return rec('blocked_no_consent', 'none', { error: 'recipient opted out or no consent' });
  core.recordUsage(tenantId, conversationId, 'sms', 1);
  if (cfg.twilio.sid && cfg.twilio.token && (from || cfg.twilio.from)) {
    // Fire-and-forget; status updated when the provider responds
    twilioSend(phone, body, from || cfg.twilio.from).then((r) => {
      db.prepare('UPDATE outbox SET status=?, provider_sid=?, error=? WHERE id=?').run(r.ok ? 'sent' : 'failed', r.sid || null, r.error || null, id);
    }).catch((e) => db.prepare('UPDATE outbox SET status=?, error=? WHERE id=?').run('failed', String(e.message).slice(0, 200), id));
    return rec('queued', 'twilio');
  }
  return rec('simulated', 'simulated');
}

async function twilioSend(to, body, from) {
  const auth = Buffer.from(`${cfg.twilio.sid}:${cfg.twilio.token}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio.sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, sid: data.sid, error: res.ok ? null : (data.message || `HTTP ${res.status}`) };
}

// ---------------------------------------------------------------- Triage
const NEG = /\b(no|not|without|never|don'?t have|doesn'?t|isn'?t|aren'?t)\b/i;
function negated(text, index) {
  const before = text.slice(Math.max(0, index - 28), index);
  const lastWords = before.split(/[.,;!?]/).pop();
  return NEG.test(lastWords.split(/\s+/).slice(-3).join(' '));
}
const RED = [
  ['breathing', /(can'?t|cannot|trouble|difficulty|hard to|struggling to|short of)\s+breath(e|ing)/i],
  ['swallowing', /(can'?t|cannot|trouble|difficulty|hard to|unable to)\s+swallow/i],
  ['airway_swelling', /(swelling|swollen).{0,40}(eye|neck|throat|tongue)|(throat|tongue).{0,20}(closing|swelling|swollen)/i],
  ['uncontrolled_bleeding', /(bleeding|blood).{0,30}(won'?t|will not|not|isn'?t|can'?t).{0,10}stop|bleeding (a lot|heavily|badly)|uncontrolled bleeding/i],
  ['facial_trauma', /(car accident|hit in the face|facial trauma|broke(n)? (my )?jaw|jaw (is )?broken|fell and hit)/i],
  ['unconscious', /unconscious|passed out|seizure|chest pain|heart attack/i],
];
const URGENT = [
  ['knocked_out_tooth', /knocked.?out|avulsed|tooth (came|fell) out/i],
  ['severe_pain', /severe pain|excruciating|unbearable|agony|worst pain|killing me|can'?t sleep.{0,20}(pain|tooth)/i],
  ['swelling', /\b(swelling|swollen|abscess|pus)\b/i],
  ['broken_tooth', /(broken|chipped|cracked|snapped|broke)\b.{0,12}\b(tooth|teeth)|\b(tooth|teeth)\b.{0,12}\b(broke|chipped|cracked|snapped)/i],
  ['lost_crown', /lost (a |my |the )?(crown|filling|cap)|(crown|filling) (fell|came) out/i],
  ['bleeding', /\bbleeding\b/i],
  ['toothache', /\b(toothache|tooth ?ache|tooth pain|my tooth hurts|tooth hurts|gum pain|jaw pain|in pain)\b/i],
];
function triage(text) {
  const t = String(text || '');
  for (const [rule, re] of RED) {
    const m = re.exec(t);
    if (m && !negated(t, m.index)) return { level: 'life_threatening', rule };
  }
  for (const [rule, re] of URGENT) {
    const m = re.exec(t);
    if (m && !negated(t, m.index)) return { level: 'urgent', rule };
  }
  return { level: null, rule: null };
}

module.exports = { createTask, notifyStaff, send, inQuietHours, triage };
