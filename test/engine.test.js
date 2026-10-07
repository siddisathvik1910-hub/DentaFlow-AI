const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const tz = require('../server/tz');
const nlu = require('../server/agent/nlu');
const comms = require('../server/services/comms');
const scheduling = require('../server/services/scheduling');
const patients = require('../server/services/patients');
const knowledge = require('../server/services/knowledge');
const core = require('../server/services/core');
const { db } = H;

let ctx;
test.before(async () => { H.pinClock(); ctx = await H.setup(); });
test.after(() => H.clock.reset());

test('time zones: local <-> UTC conversion is DST-safe', () => {
  const d = tz.zonedToUtc('2026-10-05', '09:00', 'America/Chicago'); // CDT = UTC-5
  assert.equal(d.toISOString(), '2026-10-05T14:00:00.000Z');
  const w = tz.zonedToUtc('2026-12-07', '09:00', 'America/Chicago'); // CST = UTC-6
  assert.equal(w.toISOString(), '2026-12-07T15:00:00.000Z');
  assert.equal(tz.local(d, 'America/Chicago').time, '09:00');
});

test('NLU: dates of birth in many spoken and written forms', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  for (const t of ['April 12th, 1988', '04/12/1988', '1988-04-12', 'twelve april 1988', 'april twelfth nineteen eighty eight']) assert.equal(nlu.extractDOB(t, now), '1988-04-12', t);
  assert.equal(nlu.extractDOB('13/45/1988', now), null);
});
test('NLU: names, intents, insurance, preferences', () => {
  assert.deepEqual(nlu.extractName('Maria Lopez', true), { first: 'Maria', last: 'Lopez' });
  assert.deepEqual(nlu.extractName("Hi I'm Maria Lopez and I need a cleaning"), { first: 'Maria', last: 'Lopez' });
  assert.equal(nlu.extractName('what are your hours', true), null);
  assert.equal(nlu.detectIntent('I need to book a cleaning'), 'book');
  assert.equal(nlu.detectIntent('I want to cancel my appointment'), 'cancel');
  assert.equal(nlu.detectIntent('can I move my appointment'), 'reschedule');
  assert.equal(nlu.detectIntent('what time do you open?'), 'faq');
  assert.equal(nlu.extractInsurance('I have Delta Dental').carrier, 'Delta Dental');
  assert.equal(nlu.extractInsurance('no insurance').carrier, 'Self-pay');
  const p = nlu.extractPrefs('Thursday afternoon after 3', new Date('2026-10-05T15:00:00Z'), 'America/Chicago');
  assert.deepEqual(p.days, [4]); assert.equal(p.tod, 'afternoon'); assert.equal(p.after, '15:00');
});

test('triage: red flags, urgent, negation, and normal text', () => {
  assert.equal(comms.triage("I can't breathe and my throat is swelling").level, 'life_threatening');
  assert.equal(comms.triage('my tongue is swelling and I can\'t swallow').level, 'life_threatening');
  assert.equal(comms.triage('the bleeding won\'t stop').level, 'life_threatening');
  assert.equal(comms.triage('I have a bad toothache').level, 'urgent');
  assert.equal(comms.triage('my tooth got knocked out').level, 'urgent');
  assert.equal(comms.triage('I broke a tooth yesterday').level, 'urgent');
  assert.equal(comms.triage('I have no trouble breathing, just a cleaning please').level, null);
  assert.equal(comms.triage('I need a cleaning next week').level, null);
});

test('scheduling: slots respect hours, rules, and provider eligibility', () => {
  const clean = scheduling.getTypeByCode(ctx.locId, 'CLEANING');
  const r = scheduling.findSlots({ locationId: ctx.locId, typeId: clean.id, patient: { isNew: false, age: 40 }, limit: 6, spread: false });
  assert.ok(r.slots.length >= 3);
  const loc = core.getLocation(ctx.locId);
  for (const s of r.slots) {
    assert.equal(s.provider_name.includes('Kim'), true, 'cleanings only with the hygienist');
    const l = tz.local(new Date(s.start_utc), loc.timezone);
    assert.ok(l.weekday >= 1 && l.weekday <= 5, 'weekday only');
    assert.ok(l.minutes >= 8 * 60 && l.minutes + 60 <= 17 * 60);
    assert.ok(!(l.minutes >= 12 * 60 && l.minutes < 13 * 60) && !(l.minutes < 12 * 60 && l.minutes + 60 > 12 * 60), 'no overlap with lunch');
  }
});
test('scheduling: new patients cannot book existing-only types; existing patients cannot book new-patient exams', () => {
  const clean = scheduling.getTypeByCode(ctx.locId, 'CLEANING');
  const exam = scheduling.getTypeByCode(ctx.locId, 'NEW_PT_EXAM');
  assert.equal(scheduling.findSlots({ locationId: ctx.locId, typeId: clean.id, patient: { isNew: true } }).slots.length, 0);
  assert.equal(scheduling.findSlots({ locationId: ctx.locId, typeId: exam.id, patient: { isNew: false } }).slots.length, 0);
});
test('scheduling: emergency reserve hides early-morning dentist slots from regular types but not emergencies', () => {
  const chk = scheduling.getTypeByCode(ctx.locId, 'CHECKUP');
  const em = scheduling.getTypeByCode(ctx.locId, 'EMERGENCY_EXAM');
  const loc = core.getLocation(ctx.locId);
  const reg = scheduling.findSlots({ locationId: ctx.locId, typeId: chk.id, patient: { isNew: false }, fromDate: '2026-10-07', toDate: '2026-10-07', limit: 50, spread: false });
  assert.ok(reg.slots.every((s) => tz.local(new Date(s.start_utc), loc.timezone).time >= '08:30'), 'regular visits skip the first 30 reserved minutes');
  const e = scheduling.findSlots({ locationId: ctx.locId, typeId: em.id, patient: { isNew: false }, fromDate: '2026-10-07', toDate: '2026-10-07', limit: 50, spread: false });
  assert.ok(e.slots.some((s) => tz.local(new Date(s.start_utc), loc.timezone).time === '08:00'));
});

test('booking: write-time re-validation prevents double booking and is idempotent', () => {
  const p = patients.createPatient({ tenantId: ctx.tenantId, locationId: ctx.locId, first_name: 'Test', last_name: 'Booker', dob: '1990-01-01', phone: '+15125550900', last_visit: '2026-01-01' });
  const q = patients.createPatient({ tenantId: ctx.tenantId, locationId: ctx.locId, first_name: 'Other', last_name: 'Person', dob: '1991-02-02', phone: '+15125550901', last_visit: '2026-01-01' });
  const chk = scheduling.getTypeByCode(ctx.locId, 'CHECKUP');
  const slot = scheduling.findSlots({ locationId: ctx.locId, typeId: chk.id, patient: { isNew: false }, limit: 3 }).slots[0];
  const a = scheduling.bookAppointment({ tenantId: ctx.tenantId, locationId: ctx.locId, patientId: p.id, slotId: slot.slot_id, idempotencyKey: 'k1' });
  const again = scheduling.bookAppointment({ tenantId: ctx.tenantId, locationId: ctx.locId, patientId: p.id, slotId: slot.slot_id, idempotencyKey: 'k1' });
  assert.equal(again.idempotent, true); assert.equal(again.appointment.id, a.appointment.id);
  assert.throws(() => scheduling.bookAppointment({ tenantId: ctx.tenantId, locationId: ctx.locId, patientId: q.id, slotId: slot.slot_id, idempotencyKey: 'k2' }), (e) => e.code === 'SLOT_TAKEN');
  // overlapping time with a different provider is fine, same provider overlap is not
  const still = scheduling.findSlots({ locationId: ctx.locId, typeId: chk.id, patient: { isNew: false }, limit: 40, spread: false }).slots;
  assert.ok(!still.some((s) => s.provider_id === slot.provider_id && s.start_utc === slot.start_utc));
});
test('booking: holds protect a slot from other conversations and expire on release', () => {
  const chk = scheduling.getTypeByCode(ctx.locId, 'CHECKUP');
  const slot = scheduling.findSlots({ locationId: ctx.locId, typeId: chk.id, patient: { isNew: false }, fromDate: '2026-10-08', limit: 3 }).slots[0];
  const h1 = scheduling.holdSlot({ locationId: ctx.locId, slotId: slot.slot_id, conversationId: 'c1', patient: { isNew: false } });
  assert.throws(() => scheduling.holdSlot({ locationId: ctx.locId, slotId: slot.slot_id, conversationId: 'c2', patient: { isNew: false } }), (e) => e.code === 'SLOT_HELD');
  scheduling.releaseHold(h1.token);
  assert.ok(scheduling.holdSlot({ locationId: ctx.locId, slotId: slot.slot_id, conversationId: 'c2', patient: { isNew: false } }).token);
  scheduling.releaseHoldsFor('c2');
});
test('booking: staff-only types are refused for the agent but allowed for staff', () => {
  const rc = scheduling.getTypeByCode(ctx.locId, 'ROOT_CANAL');
  const p = db.prepare("SELECT id FROM patients WHERE first_name='Test'").get();
  const slot = scheduling.findSlots({ locationId: ctx.locId, typeId: rc.id, patient: { isNew: false }, limit: 2 }).slots[0];
  assert.ok(slot);
  assert.throws(() => scheduling.bookAppointment({ tenantId: ctx.tenantId, locationId: ctx.locId, patientId: p.id, slotId: slot.slot_id, source: 'agent' }), (e) => e.code === 'NO_PERMISSION');
  assert.ok(scheduling.bookAppointment({ tenantId: ctx.tenantId, locationId: ctx.locId, patientId: p.id, slotId: slot.slot_id, source: 'staff', skipPermission: true }).appointment.id);
});

test('identity: DOB must match, fuzzy names tolerated, wrong DOB rejected', () => {
  assert.ok(patients.verifyIdentity(ctx.locId, { first_name: 'James', last_name: 'Carter', dob: '1975-03-22' }));
  assert.ok(patients.verifyIdentity(ctx.locId, { first_name: 'Jaems', last_name: 'Cartter', dob: '1975-03-22' }), 'tolerates one-letter transcription errors');
  assert.equal(patients.verifyIdentity(ctx.locId, { first_name: 'James', last_name: 'Carter', dob: '1975-03-23' }), null);
});
test('PHI is encrypted at rest', () => {
  const raw = db.prepare("SELECT dob_enc, phone_enc, email_enc, phone_hash FROM patients WHERE last_name='Carter'").get();
  assert.ok(raw.dob_enc.startsWith('v1:') && !raw.dob_enc.includes('1975'));
  assert.ok(!String(raw.phone_enc).includes('5125550101') && !String(raw.phone_hash).includes('5125550101'));
});

test('knowledge: structured facts, pinned answers and "I do not know" with unanswered logging', () => {
  const loc = core.getLocation(ctx.locId);
  assert.match(knowledge.answer(loc, 'what are your hours?').text, /Monday through Thursday: 8 AM to 5 PM/);
  assert.match(knowledge.answer(loc, 'do you take cigna insurance').text, /Cigna/);
  assert.match(knowledge.answer(loc, 'Do you offer teeth whitening?').text, /whitening/i);
  assert.match(knowledge.answer(loc, 'where can I park').text, /parking/i);
  const before = db.prepare('SELECT COUNT(*) n FROM unanswered_questions').get().n;
  assert.equal(knowledge.answer(loc, 'do you sell cryptocurrency mining rigs').text, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM unanswered_questions').get().n, before + 1);
});
test('knowledge: crawler refuses private and loopback addresses (SSRF protection)', async () => {
  for (const u of ['http://127.0.0.1:3000/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'ftp://example.com/', 'file:///etc/passwd']) {
    await assert.rejects(() => knowledge.assertPublicUrl(u), undefined, u);
  }
});
