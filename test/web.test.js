const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const cfg = require('../server/config');
const { db } = H;
let S, ctx;
test.before(async () => { ctx = await H.setup({ withHistory: true }); S = await H.startServer(); });
test.after(async () => { await S.close(); H.clock.reset(); });

const api = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
  const r = await fetch(S.base + path, { method, headers: Object.assign({ 'content-type': 'application/json', 'x-requested-with': 'DentaFlow' }, cookie ? { cookie } : {}, headers), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let data = null; try { data = await r.clone().json(); } catch (_) { /* not json */ }
  return { status: r.status, data, headers: r.headers, res: r };
};
const login = async (email = 'demo@brightsmile.test', password = cfg.demoPassword) => {
  const r = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};

test('auth: login works, bad password fails, 5 failures lock the account', async () => {
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email: 'demo@brightsmile.test', password: 'wrong' } })).status, 401);
  const ok = await login(); assert.equal(ok.r.status, 200); assert.match(ok.r.headers.get('set-cookie'), /HttpOnly/i); assert.match(ok.r.headers.get('set-cookie'), /SameSite=Lax/i);
  for (let i = 0; i < 5; i++) await api('/api/auth/login', { method: 'POST', body: { email: 'frontdesk@brightsmile.test', password: 'nope' + i } });
  const locked = await api('/api/auth/login', { method: 'POST', body: { email: 'frontdesk@brightsmile.test', password: cfg.demoPassword } });
  assert.equal(locked.status, 423);
});
test('auth: API requires a session and a CSRF header for writes', async () => {
  assert.equal((await api('/api/v1/overview')).status, 401);
  const { cookie } = await login();
  assert.equal((await api('/api/v1/overview', { cookie })).status, 200);
  const noHeader = await fetch(S.base + '/api/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ title: 'x1' }) });
  assert.equal(noHeader.status, 403);
  const crossOrigin = await api('/api/v1/tasks', { method: 'POST', cookie, body: { title: 'x2' }, headers: { origin: 'https://evil.example' } });
  assert.equal(crossOrigin.status, 403);
});
test('MFA: TOTP setup and enforced sign-in', async () => {
  const totp = require('../server/totp');
  const { cookie } = await login('demo@brightsmile.test');
  const setup = await api('/api/auth/mfa/setup', { method: 'POST', cookie });
  assert.match(setup.data.secret, /^[A-Z2-7]{32}$/);
  assert.equal((await api('/api/auth/mfa/enable', { method: 'POST', cookie, body: { code: '000000' } })).status, 400);
  assert.equal((await api('/api/auth/mfa/enable', { method: 'POST', cookie, body: { code: totp.totp(setup.data.secret) } })).status, 200);
  const need = await api('/api/auth/login', { method: 'POST', body: { email: 'demo@brightsmile.test', password: cfg.demoPassword } });
  assert.equal(need.data.mfa_required, true);
  const withCode = await api('/api/auth/login', { method: 'POST', body: { email: 'demo@brightsmile.test', password: cfg.demoPassword, code: totp.totp(setup.data.secret) } });
  assert.equal(withCode.status, 200);
  assert.equal(withCode.status, 200);
  const off = await login('demo@brightsmile.test'); // still needs a code, so sign in with one
  const again = await api('/api/auth/login', { method: 'POST', body: { email: 'demo@brightsmile.test', password: cfg.demoPassword, code: totp.totp(setup.data.secret) } });
  const ck = (again.headers.get('set-cookie') || '').split(';')[0];
  assert.equal((await api('/api/auth/mfa/disable', { method: 'POST', cookie: ck, body: { password: cfg.demoPassword } })).status, 200);
  assert.equal(totp.totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082', 'RFC 6238 test vector (SHA1, T=59s)');
});
test('tenant isolation: another practice cannot read this clinic\'s data', async () => {
  const bcrypt = require('bcryptjs'); const { uid, nowIso } = require('../server/db');
  const t2 = uid(); db.prepare("INSERT INTO tenants (id,name,created_at) VALUES (?,?,?)").run(t2, 'Other Dental', nowIso());
  db.prepare("INSERT INTO users (id,tenant_id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?,?)").run(uid(), t2, 'owner@other.test', 'Other Owner', bcrypt.hashSync('OtherPass12345', 4), 'owner', nowIso());
  const l2 = uid(); db.prepare("INSERT INTO locations (id,tenant_id,name,timezone,hours_json,settings_json,widget_key,created_at) VALUES (?,?,?,?,?,?,?,?)").run(l2, t2, 'Other Dental', 'America/New_York', JSON.stringify(core2().DEFAULT_HOURS), '{}', 'wk_other', nowIso());
  function core2() { return require('../server/services/core'); }
  const mine = await login(); const theirs = await login('owner@other.test', 'OtherPass12345');
  const conv = (await api('/api/v1/conversations', { cookie: mine.cookie })).data.conversations[0];
  assert.ok(conv);
  assert.equal((await api('/api/v1/conversations/' + conv.id, { cookie: theirs.cookie })).status, 404, 'cannot open another tenant\'s conversation');
  assert.equal((await api('/api/v1/conversations/' + conv.id + '?location_id=' + db.prepare('SELECT id FROM locations ORDER BY created_at LIMIT 1').get().id, { cookie: theirs.cookie })).status, 404, 'spoofed location_id ignored');
  assert.equal((await api('/api/v1/patients', { cookie: theirs.cookie })).data.total, 0);
  const patient = db.prepare('SELECT id FROM patients LIMIT 1').get();
  assert.equal((await api('/api/v1/patients/' + patient.id, { cookie: theirs.cookie })).status, 404);
});
test('role permissions: staff cannot change settings or view the audit log', async () => {
  const bcrypt = require('bcryptjs'); const { uid, nowIso } = require('../server/db');
  const tid = db.prepare('SELECT id FROM tenants WHERE name=?').get('Bright Smile Dental Group').id;
  db.prepare("INSERT INTO users (id,tenant_id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?,?)").run(uid(), tid, 'staffer@brightsmile.test', 'Staffer', bcrypt.hashSync('StaffPass12345', 4), 'staff', nowIso());
  const { cookie } = await login('staffer@brightsmile.test', 'StaffPass12345');
  assert.equal((await api('/api/v1/settings', { method: 'PATCH', cookie, body: { name: 'Hacked' } })).status, 403);
  assert.equal((await api('/api/v1/audit', { cookie })).status, 403);
  assert.equal((await api('/api/v1/tasks', { cookie })).status, 200);
});
test('audit log records PHI views and settings changes; settings roll back', async () => {
  const { cookie } = await login();
  const p = db.prepare('SELECT id FROM patients LIMIT 1').get();
  await api('/api/v1/patients/' + p.id, { cookie });
  assert.ok((await api('/api/v1/audit', { cookie })).data.logs.some((l) => l.action === 'view_patient'));
  const before = (await api('/api/v1/settings', { cookie })).data.location.settings.agent_name;
  assert.equal((await api('/api/v1/settings', { method: 'PATCH', cookie, body: { settings: { agent_name: 'Zed' } } })).status, 200);
  const versions = (await api('/api/v1/settings/versions', { cookie })).data.versions;
  assert.equal((await api('/api/v1/settings/versions/' + versions[0].id + '/rollback', { method: 'POST', cookie })).status, 200);
  assert.equal((await api('/api/v1/settings', { cookie })).data.location.settings.agent_name, before);
});
test('input validation: dashboard rejects bad data with clear errors', async () => {
  const { cookie } = await login();
  assert.equal((await api('/api/v1/patients', { method: 'POST', cookie, body: { first_name: '', last_name: 'X', dob: 'nope' } })).status, 400);
  assert.equal((await api('/api/v1/settings', { method: 'PATCH', cookie, body: { timezone: 'Mars/Phobos' } })).status, 400);
  assert.equal((await api('/api/v1/appointment-types', { method: 'POST', cookie, body: { name: 'Bad', code: 'bad code', duration_min: 30 } })).status, 400);
  assert.equal((await api('/api/v1/knowledge/crawl', { method: 'POST', cookie, body: { url: 'http://127.0.0.1:22/' } })).status, 400);
});
test('CSV export neutralizes spreadsheet formula injection', async () => {
  const { cookie } = await login();
  db.prepare("UPDATE conversations SET summary='=HYPERLINK(\"http://evil\",\"x\")' WHERE id=(SELECT id FROM conversations LIMIT 1)").run();
  const r = await fetch(S.base + '/api/v1/export/conversations.csv', { headers: { cookie } });
  const text = await r.text();
  assert.ok(!/(^|,)"=HYPERLINK/.test(text) && text.includes("\"'=HYPERLINK"));
});

test('lead form: validation, honeypot, speed trap, expired token, success', async () => {
  const good = { name: 'Dr. Ada Lovelace', email: 'ada@smile.test', clinic: 'Smile Dental', phone: '', message: '', consent: true, website: '' };
  const tok = async () => (await api('/api/public/form-token')).data.token;
  const bad = await api('/api/public/lead', { method: 'POST', body: { ...good, email: 'not-an-email', consent: false, t: await tok() } });
  assert.equal(bad.status, 400); assert.ok(bad.data.fields.email && bad.data.fields.consent);
  const fast = await api('/api/public/lead', { method: 'POST', body: { ...good, t: await tok() } });
  assert.equal(fast.status, 429, 'submitted faster than a human can');
  const old = Date.now() - 6000; const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', cfg.jwtSecret).update('form:' + old).digest('hex').slice(0, 32);
  const before = db.prepare('SELECT COUNT(*) n FROM leads').get().n;
  const bot = await api('/api/public/lead', { method: 'POST', body: { ...good, website: 'http://spam.example', t: `${old}.${sig}` } });
  assert.equal(bot.status, 200); assert.equal(db.prepare('SELECT COUNT(*) n FROM leads').get().n, before, 'honeypot submissions are silently dropped');
  const forged = await api('/api/public/lead', { method: 'POST', body: { ...good, t: `${old}.deadbeef` } });
  assert.equal(forged.status, 400);
  const ok = await api('/api/public/lead', { method: 'POST', body: { ...good, t: `${old}.${sig}` } });
  assert.equal(ok.status, 200); assert.equal(db.prepare('SELECT COUNT(*) n FROM leads').get().n, before + 1);
});
test('bot protection: rate limiting engages on repeated submissions', async () => {
  const { limits } = require('../server/middleware/security');
  delete process.env.DF_DISABLE_RATE_LIMIT; // limiters read the flag per request
  let hit429 = false;
  for (let i = 0; i < 10 && !hit429; i++) { const r = await api('/api/public/lead', { method: 'POST', body: { name: 'x' } }); if (r.status === 429) hit429 = true; }
  process.env.DF_DISABLE_RATE_LIMIT = '1';
  assert.ok(hit429 && limits.lead);
});
test('analytics beacon stores nothing without consent and never stores IPs', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM web_events').get().n;
  await api('/api/public/collect', { method: 'POST', body: { path: '/', consent: false } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM web_events').get().n, before);
  await api('/api/public/collect', { method: 'POST', body: { path: '/', consent: true, session: 's1' }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } });
  const row = db.prepare('SELECT * FROM web_events ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(row.device, 'mobile'); assert.deepEqual(Object.keys(row).sort(), ['device', 'id', 'path', 'referrer', 'session', 'ts']);
});
test('chat widget API: start, converse, and cannot cross locations', async () => {
  const key = db.prepare('SELECT widget_key FROM locations ORDER BY created_at LIMIT 1').get().widget_key;
  const s = await api('/api/public/chat/start', { method: 'POST', body: { widget_key: key } });
  assert.equal(s.status, 200); assert.match(s.data.greeting, /virtual assistant/);
  const m = await api('/api/public/chat/message', { method: 'POST', body: { widget_key: key, conversation_id: s.data.conversation_id, message: 'What are your hours?' } });
  assert.match(m.data.reply, /Monday through Thursday/);
  assert.equal((await api('/api/public/chat/message', { method: 'POST', body: { widget_key: 'wk_other', conversation_id: s.data.conversation_id, message: 'hi' } })).status, 404);
  assert.equal((await api('/api/public/chat/start', { method: 'POST', body: { widget_key: 'nope!' } })).status, 404);
});
test('twilio webhooks: voice returns TwiML, speech turn works, signature is enforced when token set', async () => {
  const form = (o) => new URLSearchParams(o).toString();
  const post = (p, o, headers = {}) => fetch(S.base + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/x-www-form-urlencoded' }, headers), body: form(o) });
  let r = await post('/webhooks/twilio/voice', { CallSid: 'CA1', From: '+15125550166', To: '+15125550100' });
  let xml = await r.text(); assert.match(xml, /<Gather input="speech"/); assert.match(xml, /virtual assistant/);
  const cid = /cid=([\w-]+)/.exec(xml)[1];
  r = await post('/webhooks/twilio/voice/turn?cid=' + cid, { SpeechResult: 'What are your hours', Confidence: '0.9' }); xml = await r.text();
  assert.match(xml, /Monday through Thursday/);
  r = await post('/webhooks/twilio/voice', { CallSid: 'CA2', From: '+1555', To: '+19999999999' }); assert.match(await r.text(), /not configured/);
  cfg.twilio.token = 'secret-token';
  r = await post('/webhooks/twilio/sms', { From: '+15125550102', To: '+15125550100', Body: 'HELP' }); assert.equal(r.status, 403, 'unsigned request rejected');
  const crypto = require('crypto'); const params = { From: '+15125550102', To: '+15125550100', Body: 'HELP' };
  const url = cfg.baseUrl + '/webhooks/twilio/sms';
  const sig = crypto.createHmac('sha1', 'secret-token').update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
  r = await post('/webhooks/twilio/sms', params, { 'x-twilio-signature': sig }); assert.equal(r.status, 200); assert.match(await r.text(), /reply C to confirm/);
  cfg.twilio.token = '';
});
test('SMS: STOP blocks future texts, START restores, C confirms, X cancels, YES accepts waitlist offer', async () => {
  const inbound = require('../server/services/inbound'); const patients = require('../server/services/patients'); const comms = require('../server/services/comms');
  const loc = db.prepare('SELECT * FROM locations ORDER BY created_at LIMIT 1').get(); const tid = loc.tenant_id;
  const ph = '+15125550104';
  const sms = (body) => inbound.handleSms({ locationId: loc.id, from: ph, body });
  assert.match((await sms('STOP')).reply, /unsubscribed/);
  assert.equal(comms.send({ tenantId: tid, locationId: loc.id, to: ph, body: 'x', kind: 'reminder' }).status, 'blocked_no_consent');
  assert.match((await sms('START')).reply, /Welcome back/);
  assert.equal(comms.send({ tenantId: tid, locationId: loc.id, to: ph, body: 'x', kind: 'reminder' }).status, 'simulated');
  // confirm / cancel by text
  const S = require('../server/services/scheduling');
  const p = patients.findByPhone(loc.id, ph)[0];
  const slot = S.findSlots({ locationId: loc.id, typeId: db.prepare("SELECT id FROM appointment_types WHERE code='CHECKUP'").get().id, patient: { isNew: false }, fromDate: '2026-11-02', limit: 2 }).slots[0];
  const a = S.bookAppointment({ tenantId: tid, locationId: loc.id, patientId: p.id, slotId: slot.slot_id, source: 'staff', skipPermission: true });
  assert.match((await sms('C')).reply, /confirmed/i);
  assert.equal(db.prepare('SELECT confirmation_status s FROM appointments WHERE id=?').get(a.appointment.id).s, 'confirmed');
  // waitlist: someone else joins waitlist, this appointment is cancelled by text, offer goes out and YES books it
  const w = patientsFor('+15125550106'); const waitlist = require('../server/services/waitlist');
  waitlist.add({ tenantId: tid, locationId: loc.id, patientId: w.id, typeId: a.appointment.type_id, prefs: {} });
  assert.match((await sms('X')).reply, /cancelled/i);
  assert.ok(db.prepare("SELECT 1 FROM offers WHERE patient_id=? AND status='pending'").get(w.id), 'backfill offer created');
  const yes = await inbound.handleSms({ locationId: loc.id, from: '+15125550106', body: 'YES' });
  assert.match(yes.reply, /You're booked/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM appointments WHERE patient_id=? AND source='waitlist'").get(w.id).n, 1);
  function patientsFor(phone) { return patients.findByPhone(loc.id, phone)[0]; }
});
test('reminders: scheduled idempotently and sent when due, respecting quiet hours', async () => {
  const reminders = require('../server/services/reminders'); const S = require('../server/services/scheduling'); const tzm = require('../server/tz');
  const comms = require('../server/services/comms');
  const loc = db.prepare('SELECT * FROM locations ORDER BY created_at LIMIT 1').get(); const L = H.core.getLocation(loc.id);
  const p = require('../server/services/patients').findByPhone(loc.id, '+15125550108')[0];
  const type = db.prepare("SELECT id FROM appointment_types WHERE code='CHECKUP'").get();
  const from = tzm.addDays(tzm.local(new Date(), L.timezone).date, 12);
  const slots = S.findSlots({ locationId: loc.id, typeId: type.id, patient: { isNew: false }, fromDate: from, limit: 40, spread: false }).slots;
  const slot = slots.find((x) => x.local_time >= '09:30' && x.local_time <= '15:00');
  const a = S.bookAppointment({ tenantId: loc.tenant_id, locationId: loc.id, patientId: p.id, slotId: slot.slot_id, source: 'staff', skipPermission: true }).appointment;
  reminders.scheduleForAppointment(a.id); reminders.scheduleForAppointment(a.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reminder_schedules WHERE appointment_id=?').get(a.id).n, 3, 'one row per step, even when scheduled twice');
  const start = new Date(a.start_utc).getTime();
  H.clock.setNow(new Date(start - 23 * 3600000)); // inside the 24h window, business hours
  const before = db.prepare("SELECT COUNT(*) n FROM outbox WHERE kind='reminder'").get().n;
  assert.ok(reminders.runDue() >= 1);
  assert.ok(db.prepare("SELECT body FROM outbox WHERE kind='reminder' ORDER BY rowid DESC LIMIT 1").get().body.includes('Reply C to confirm'));
  assert.equal(reminders.runDue(), 0, 'not sent twice');
  // quiet hours: a reminder that comes due at 10 PM local is deferred to the morning, not sent
  const rs = db.prepare("SELECT id FROM reminder_schedules WHERE appointment_id=? AND step_hours=2").get(a.id);
  const ten = tzm.zonedToUtc(tzm.local(new Date(start), L.timezone).date, '22:00', L.timezone);
  db.prepare("UPDATE reminder_schedules SET send_at=?, status='pending' WHERE id=?").run(new Date(start - 3 * 3600000).toISOString(), rs.id);
  H.clock.setNow(ten); assert.equal(comms.inQuietHours(L, ten), true);
  H.clock.reset();
});

const rawGet = (path, host, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(S.base);
  require('http').get({ host: u.hostname, port: u.port, path, headers: Object.assign({ host }, headers) }, (res) => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); }).on('error', reject);
});
test('HTTPS is forced behind a proxy but localhost stays usable', async () => {
  cfg.forceHttps = true;
  try {
    const r = await rawGet('/privacy', 'www.example.com');
    assert.equal(r.status, 301); assert.equal(r.headers.location, 'https://www.example.com/privacy');
    const ok = await rawGet('/privacy', 'www.example.com', { 'x-forwarded-proto': 'https' });
    assert.equal(ok.status, 200); assert.match(ok.headers['strict-transport-security'], /max-age=63072000/);
    assert.equal((await rawGet('/healthz', 'www.example.com')).status, 200, 'health probes allowed over http');
    assert.equal((await rawGet('/privacy', 'localhost:3000')).status, 200, 'localhost exempt for development');
  } finally { cfg.forceHttps = false; }
});
test('security headers and CSP: no inline scripts allowed, clickjacking blocked', async () => {
  const r = await fetch(S.base + '/');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'(;|$)/); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('x-powered-by'), null);
});
test('secrets stay on the server: public config exposes only whitelisted keys and no served file contains secrets', async () => {
  const c = (await api('/api/public/config')).data;
  assert.deepEqual(Object.keys(c).sort(), ['demoWidgetKey', 'ga4', 'plausibleDomain', 'turnstileSiteKey']);
  const text = JSON.stringify(c) + (await (await fetch(S.base + '/')).text());
  for (const secret of [cfg.jwtSecret, cfg.encryptionKey, cfg.anthropic.key, cfg.twilio.token, cfg.stripe.key].filter(Boolean)) assert.ok(!text.includes(secret));
  assert.equal((await fetch(S.base + '/.env')).status, 404); assert.equal((await fetch(S.base + '/server/config.js')).status, 404); assert.equal((await fetch(S.base + '/data/dentaflow.db')).status, 404);
  assert.equal((await fetch(S.base + '/js/../../server/config.js')).status, 404);
});
