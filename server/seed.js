// Demo data: a fully configured clinic ("Bright Smile Dental") so the product is usable the moment it starts.
const bcrypt = require('bcryptjs');
const { db, uid, nowIso, j, parse } = require('./db');
const cfg = require('./config');
const clock = require('./clock');
const tz = require('./tz');
const crypto = require('./crypto');
const core = require('./services/core');
const patientsSvc = require('./services/patients');
const scheduling = require('./services/scheduling');
const knowledge = require('./services/knowledge');
const waitlist = require('./services/waitlist');

const DEMO_EMAIL = 'demo@brightsmile.test';

function resetAll() {
  db.pragma('foreign_keys = OFF');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const t of tables) db.exec(`DELETE FROM "${t.name}"`);
  db.pragma('foreign_keys = ON');
}

function hasData() { return !!db.prepare('SELECT 1 FROM tenants LIMIT 1').get(); }

function seedCore() {
  const tenantId = uid();
  db.prepare('INSERT INTO tenants (id,name,plan,status,baa_signed_at,created_at) VALUES (?,?,?,?,?,?)').run(tenantId, 'Bright Smile Dental Group', 'growth', 'active', nowIso(), nowIso());
  const hash = bcrypt.hashSync(cfg.demoPassword, 10);
  const mkUser = (email, name, role) => db.prepare('INSERT INTO users (id,tenant_id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?,?)').run(uid(), tenantId, email, name, hash, role, nowIso());
  mkUser(DEMO_EMAIL, 'Dr. Anita Patel', 'owner');
  mkUser('frontdesk@brightsmile.test', 'Jordan Rivera', 'staff');

  const locId = uid();
  const settings = {
    ...core.DEFAULT_SETTINGS,
    transfer_number: '+15125550142',
    emergency_policy: { ...core.DEFAULT_SETTINGS.emergency_policy, on_call_number: '+15125550199' },
    notify_phones: [], notify_emails: ['manager@brightsmile.test'],
  };
  db.prepare('INSERT INTO locations (id,tenant_id,name,address,phone,timezone,hours_json,settings_json,widget_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(locId, tenantId, 'Bright Smile Dental', '1200 Maple Avenue, Suite 4, Austin, TX 78701', '(512) 555-0142', 'America/Chicago', j(core.DEFAULT_HOURS), j(settings), 'wk_' + crypto.randomToken(12), nowIso());
  db.prepare('INSERT INTO phone_numbers (id,location_id,e164,channel,routing_mode,forward_to,status) VALUES (?,?,?,?,?,?,?)').run(uid(), locId, '+15125550100', 'voice', 'always', '+15125550142', 'active');

  const full = [['08:00', '12:00'], ['13:00', '17:00']];
  const fri = [['08:00', '12:00']];
  const sched = (days, blocks, friBlocks) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, days.includes(d) ? (d === 'fri' ? friBlocks : blocks) : []]));
  const provider = (name, type, accepts, schedule) => { const id = uid(); db.prepare('INSERT INTO providers (id,location_id,name,type,accepts_new,schedule_json,active) VALUES (?,?,?,?,?,?,1)').run(id, locId, name, type, accepts ? 1 : 0, j(schedule)); return id; };
  const patel = provider('Dr. Patel', 'dentist', true, sched(['mon', 'tue', 'wed', 'thu', 'fri'], full, fri));
  const lee = provider('Dr. Lee', 'dentist', true, sched(['tue', 'wed', 'thu', 'fri'], [['09:00', '12:00'], ['13:00', '17:00']], fri));
  const kim = provider('Sarah Kim, RDH', 'hygienist', true, sched(['mon', 'tue', 'wed', 'thu', 'fri'], full, fri));

  const type = (code, name, dur, o = {}) => db.prepare(`INSERT INTO appointment_types (id,location_id,code,name,duration_min,buffer_min,allowed_provider_types,new_patient_only,existing_only,min_age,max_age,lead_time_min,is_emergency,agent_permissions,value_estimate,keywords)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(uid(), locId, code, name, dur, o.buffer || 0, j(o.types || ['dentist']), o.newOnly ? 1 : 0, o.existingOnly ? 1 : 0, o.minAge ?? null, o.maxAge ?? null, o.lead ?? 120, o.emergency ? 1 : 0,
    j(o.perm || { book: true, reschedule: true, cancel: true }), o.value || 0, j(o.keywords || []));
  type('NEW_PT_EXAM', 'New Patient Exam & X-rays', 60, { newOnly: true, value: 285, keywords: [] });
  type('CLEANING', 'Cleaning & Exam', 60, { types: ['hygienist'], existingOnly: true, value: 195, keywords: ['cleaning', 'hygiene', 'prophy', 'teeth cleaning', 'dental cleaning'] });
  type('CHECKUP', 'Checkup & Exam', 30, { existingOnly: true, value: 120, keywords: ['checkup', 'check-up', 'check up', 'exam', 'examination', 'x-ray', 'xray', 'x-rays'] });
  type('EMERGENCY_EXAM', 'Emergency Exam', 30, { emergency: true, lead: 0, value: 250, keywords: ['emergency'] });
  type('CONSULT', 'Treatment / Cosmetic Consultation', 30, { value: 80, keywords: ['whitening', 'consult', 'consultation', 'invisalign', 'braces', 'implant', 'implants', 'veneers', 'cosmetic', 'second opinion'] });
  type('FILLING', 'Filling', 60, { existingOnly: true, value: 220, keywords: ['filling', 'cavity'] });
  type('ROOT_CANAL', 'Root Canal', 90, { existingOnly: true, value: 900, perm: { book: false, reschedule: false, cancel: true }, keywords: ['root canal'] });
  return { tenantId, locId, patel, lee, kim };
}

function seedKnowledge(tenantId, locationId) {
  const doc = (title, content, source_type = 'text') => knowledge.addDoc({ tenantId, locationId, title, content, source_type });
  doc('New patient information', `New patients are always welcome. Your first visit includes a comprehensive exam, digital x-rays, and a conversation with the dentist about your goals. Please arrive 10 minutes early and bring a photo ID, your insurance card, and a list of any medications you take.\n\nThe new patient exam and x-rays visit takes about one hour.`);
  doc('Services', `We offer general dentistry including cleanings and exams, fillings, crowns, root canals, and extractions. Cosmetic services include professional teeth whitening, veneers, and Invisalign clear aligners. We also place and restore dental implants and treat gum disease.\n\nWe see children as well as adults. Kids are welcome from age two.`);
  doc('Pricing and financing', `Fees depend on the treatment, and we give you a written estimate before any work begins. We accept major credit cards, HSA and FSA cards, and offer monthly payment plans through CareCredit for approved applicants. We do not quote prices over the phone because every mouth is different.`);
  doc('Parking and directions', `We are located at 1200 Maple Avenue, Suite 4. Free parking is available in the lot behind the building, and the entrance is on the north side next to the pharmacy. We are one block from the Maple Avenue bus stop.`);
  doc('Sedation', `We offer nitrous oxide (laughing gas) for anxious patients. Please let us know ahead of time if you would like to use it so we can plan for your visit.`);
  doc('Do you offer teeth whitening?', 'Yes, we offer professional in-office whitening and take-home whitening trays. A short consultation is the best way to choose the right option for you.', 'canonical');
  doc('Cancellation and late policy', `We ask for at least 24 hours notice if you need to cancel or reschedule so that we can offer the time to another patient. Late cancellations and missed appointments may be charged a fee, and our team will review each situation.`);
  doc('What about COVID safety?', 'Our team follows standard infection control protocols. We sterilize all instruments and disinfect each treatment room between patients.', 'canonical');
}

const PEOPLE = [
  ['James', 'Carter', '1975-03-22', '+15125550101', 'cleaning', true],
  ['Emily', 'Chen', '1990-07-14', '+15125550102', 'cleaning', true],
  ['Robert', 'Johnson', '1962-11-02', '+15125550103', 'checkup', false],
  ['Aisha', 'Khan', '1985-01-30', '+15125550104', null, true],
  ['Daniel', 'Garcia', '1998-09-09', '+15125550105', 'cleaning', false],
  ['Olivia', 'Martinez', '2001-05-18', '+15125550106', null, true],
  ['Michael', 'Brown', '1979-12-05', '+15125550107', 'filling', false],
  ['Sophia', 'Nguyen', '1993-04-27', '+15125550108', 'cleaning', true],
  ['William', 'Davis', '1955-08-19', '+15125550109', null, false],
  ['Hannah', 'Wilson', '2010-02-11', '+15125550110', 'checkup', true],
  ['Grace', 'Thompson', '1988-06-03', '+15125550111', 'cleaning', true],
  ['Ethan', 'Walker', '1971-10-21', '+15125550112', null, false],
];

function seedPatients(core_) {
  const { tenantId, locId } = core_;
  const loc = core.getLocation(locId);
  const today = tz.local(clock.now(), loc.timezone).date;
  const out = [];
  PEOPLE.forEach(([first, last, dob, phone, upcoming, marketing], i) => {
    const lastVisit = tz.addDays(today, -(120 + i * 17));
    const recallDue = tz.addDays(today, -(i % 4 === 0 ? 40 : i % 4 === 1 ? 10 : -20 - i));
    const p = patientsSvc.createPatient({ tenantId, locationId: locId, first_name: first, last_name: last, dob, phone, last_visit: lastVisit, recall_due: recallDue, email: `${first}.${last}@example.test`.toLowerCase() });
    patientsSvc.recordConsent({ tenantId, patientId: p.id, phone, purpose: 'transactional', status: 'granted', source: 'seed' });
    if (marketing) patientsSvc.recordConsent({ tenantId, patientId: p.id, phone, purpose: 'marketing', status: 'granted', source: 'seed' });
    out.push({ p, upcoming });
  });
  return out;
}

function seedAppointments(core_, people) {
  const { tenantId, locId } = core_;
  const loc = core.getLocation(locId);
  const today = tz.local(clock.now(), loc.timezone).date;
  const types = Object.fromEntries(scheduling.getTypes(locId).map((t) => [t.code, t]));
  const provs = scheduling.getProviders(locId);
  const hyg = provs.find((p) => p.type === 'hygienist'); const dentist = provs.find((p) => p.type === 'dentist');
  // upcoming appointments (validated through the real scheduling engine)
  const codes = { cleaning: 'CLEANING', checkup: 'CHECKUP', filling: 'FILLING' };
  let n = 0;
  for (const { p, upcoming } of people) {
    if (!upcoming) continue;
    const code = codes[upcoming];
    const r = scheduling.findSlots({ locationId: locId, typeId: types[code].id, patient: { isNew: false, age: patientsSvc.ageOf(p.dob) }, fromDate: tz.addDays(today, 2 + n), limit: 6, spread: false });
    const slot = r.slots[Math.min(n % 3, r.slots.length - 1)];
    if (!slot) continue;
    try {
      const { appointment } = scheduling.bookAppointment({ tenantId, locationId: locId, patientId: p.id, slotId: slot.slot_id, source: n % 2 ? 'agent' : 'staff', actor: 'seed', reason: upcoming, skipPermission: true });
      if (n % 3 === 0) scheduling.confirmAppointment(appointment.id, 'seed');
    } catch (e) { /* skip conflicts */ }
    n++;
  }
  // history for analytics: completed / no-show visits across the past 4 weeks
  const ins = db.prepare(`INSERT INTO appointments (id,tenant_id,location_id,patient_id,provider_id,type_id,start_utc,end_utc,block_end_utc,status,source,confirmation_status,reason,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let k = 0;
  for (let d = 1; d <= 28; d++) {
    const date = tz.addDays(today, -d);
    const wd = tz.weekdayOf(date);
    if (wd === 0 || wd === 6) continue;
    for (let s = 0; s < 3; s++) {
      const { p } = people[(k + s) % people.length];
      const t = s === 0 ? types.CLEANING : s === 1 ? types.CHECKUP : types.FILLING;
      const prov = t.code === 'CLEANING' ? hyg : dentist;
      const start = tz.zonedToUtc(date, ['09:00', '10:30', '14:00'][s], loc.timezone);
      const end = new Date(start.getTime() + t.duration_min * 60000);
      const status = (k + s) % 11 === 0 ? 'no_show' : 'completed';
      const bookedAt = new Date(start.getTime() - (3 + s) * 86400000);
      ins.run(uid(), tenantId, locId, p.id, prov.id, t.id, start.toISOString(), end.toISOString(), end.toISOString(), status, (k + s) % 2 ? 'agent' : 'staff', 'confirmed', 'seed', bookedAt.toISOString());
    }
    k++;
  }
}

// Realistic call history, generated by driving the real agent engine with scripted callers
async function seedConversations(core_) {
  const conversations = require('./services/conversations');
  const { locId } = core_;
  const loc = core.getLocation(locId);
  const realNow = Date.now();
  const scripts = [
    { daysAgo: 6, hour: 19, channel: 'voice', from: '+15125550177', lines: ['Hi I need to book a cleaning', 'Maria Lopez', 'April 12th 1988', 'Delta Dental', 'Thursday afternoon', '1', 'yes', 'no thanks'] },
    { daysAgo: 5, hour: 12, channel: 'voice', from: '+15125550101', lines: ['I need to reschedule my appointment', 'James Carter', 'March 22 1975', 'next week mornings', 'first one', 'yes', "that's all"] },
    { daysAgo: 5, hour: 7, channel: 'voice', from: '+15125550166', lines: ['What time do you open?', 'do you take Cigna insurance', 'no thank you'] },
    { daysAgo: 4, hour: 21, channel: 'voice', from: '+15125550155', lines: ['I have a really bad toothache and my face is swollen', 'Priya Shah', '11/03/1992', 'the first one', 'yes', 'no thanks'] },
    { daysAgo: 3, hour: 10, channel: 'chat', from: null, lines: ['Hello, do you offer teeth whitening?', 'where do you park', 'thanks'] },
    { daysAgo: 3, hour: 14, channel: 'voice', from: '+15125550103', lines: ['I want to cancel my appointment', 'Robert Johnson', '11/02/1962', 'yes', 'no'] },
    { daysAgo: 2, hour: 18, channel: 'voice', from: '+15125550133', lines: ['I am having trouble breathing and my throat is swelling'] },
    { daysAgo: 2, hour: 9, channel: 'voice', from: '+15125550144', lines: ['Can I speak to a real person'] },
    { daysAgo: 1, hour: 16, channel: 'voice', from: '+15125550188', lines: ['Hi I would like to book an appointment, I am a new patient', 'Tom Baker', 'January 8 1983', 'Aetna', 'Tuesday or Thursday', '2', 'yes', 'no'] },
    { daysAgo: 1, hour: 20, channel: 'sms', from: '+15125550102', lines: ['Hi can I get my cleaning moved', 'Emily Chen', 'July 14 1990', 'any time next week', '1', 'yes', 'thanks'] },
  ];
  for (const s of scripts) {
    try {
      const at = new Date(realNow - s.daysAgo * 86400000);
      const local = tz.local(at, loc.timezone);
      clock.setNow(tz.zonedToUtc(local.date, `${String(s.hour).padStart(2, '0')}:05`, loc.timezone));
      const { conversation } = conversations.start({ locationId: locId, channel: s.channel, externalId: `seed-${Math.random()}`, from: s.from });
      for (const line of s.lines) {
        clock.shiftMs(0); const cur = clock.now(); clock.setNow(new Date(cur.getTime() + 25000));
        const r = await conversations.turn({ conversationId: conversation.id, text: line });
        if (r.ended) break;
      }
      clock.setNow(new Date(clock.now().getTime() + 20000));
      conversations.finalize(conversation.id, 'seed');
    } catch (e) { console.error('[seed] script failed:', e.message); }
  }
  clock.reset();
  // Appointments that were booked under the simulated past clock and are now behind us are history
  db.prepare("UPDATE appointments SET status='completed' WHERE status IN ('booked','confirmed') AND start_utc < ?").run(new Date().toISOString());
  db.prepare("UPDATE reminder_schedules SET status='skipped' WHERE status='pending' AND send_at < ?").run(new Date().toISOString());
}

// Fast path used by tests: clinic + catalog + knowledge + patients, with no scripted call history
function seedCoreForTests() {
  const c = seedCore();
  seedKnowledge(c.tenantId, c.locId);
  const people = seedPatients(c);
  return Object.assign({}, c, { people });
}

async function seedDemo({ reset = false } = {}) {
  if (reset) resetAll();
  else if (hasData()) return false;
  const c = seedCore();
  seedKnowledge(c.tenantId, c.locId);
  const people = seedPatients(c);
  seedAppointments(c, people);
  const waitType = scheduling.getTypeByCode(c.locId, 'CLEANING');
  const emily = people.find(({ p }) => p.first_name === 'Emily');
  if (emily) waitlist.add({ tenantId: c.tenantId, locationId: c.locId, patientId: emily.p.id, typeId: waitType.id, prefs: { days: [2, 4], tod: 'afternoon' } });
  await seedConversations(c);
  // demo tasks for a lived-in dashboard are created by the scripted conversations above
  core.audit({ tenantId: c.tenantId, actor: 'system', action: 'demo_seeded' });
  return true;
}

module.exports = { seedDemo, hasData, resetAll, seedCoreForTests, DEMO_EMAIL };

if (require.main === module) {
  seedDemo({ reset: process.argv.includes('--reset') }).then((ok) => {
    console.log(ok ? `Demo data created. Login: ${DEMO_EMAIL} / ${cfg.demoPassword}` : 'Database already has data (use --reset to rebuild).');
    process.exit(0);
  });
}
