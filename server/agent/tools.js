// The tool layer. The language model (or the offline engine) can only act through these functions.
// Every tool enforces identity, permission, and business rules server-side, so a prompt-injected or
// mistaken model cannot bypass them.
const { db, uid, nowIso, j, parse } = require('../db');
const clock = require('../clock');
const tz = require('../tz');
const core = require('../services/core');
const patients = require('../services/patients');
const scheduling = require('../services/scheduling');
const knowledge = require('../services/knowledge');
const comms = require('../services/comms');
const waitlist = require('../services/waitlist');
const nlu = require('./nlu');

const err = (code, message, extra = {}) => ({ error: { code, message: message || scheduling.MESSAGES[code] || code, ...extra } });
const abs = (iso, loc) => tz.speak(new Date(iso), loc.timezone);
const DAY_NAMES = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };

function setConv(ctx, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  db.prepare(`UPDATE conversations SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => fields[c]), ctx.conv.id);
  Object.assign(ctx.conv, fields);
}
const patientCtxFromState = (ctx) => {
  const st = ctx.state;
  if (st.patient_id) { const p = patients.getPatient(st.patient_id); if (p) return { ...scheduling.patientCtx(p), p }; }
  const dob = st.patient && st.patient.dob;
  return { isNew: st.new_patient !== false, age: dob ? patients.ageOf(dob) : null, p: null };
};
const mobileFor = (ctx) => (ctx.state.patient && ctx.state.patient.mobile) || ctx.conv.from_number || null;

function resolveType(ctx, args) {
  const pc = patientCtxFromState(ctx);
  if (args.appointment_type) {
    const byCode = scheduling.getTypeByCode(ctx.locationId, String(args.appointment_type).toUpperCase());
    if (byCode) return byCode;
    const byName = scheduling.getTypes(ctx.locationId).find((t) => t.name.toLowerCase() === String(args.appointment_type).toLowerCase());
    if (byName) return byName;
    const byText = scheduling.typeFromText(ctx.locationId, args.appointment_type, { isNew: pc.isNew, urgent: false });
    if (byText) return byText;
  }
  if (args.reason) return scheduling.typeFromText(ctx.locationId, args.reason, { isNew: pc.isNew, urgent: !!ctx.state.urgent });
  if (ctx.state.appointment_type_id) return scheduling.getType(ctx.state.appointment_type_id);
  return scheduling.typeFromText(ctx.locationId, '', { isNew: pc.isNew, urgent: !!ctx.state.urgent });
}

function normPrefs(args, ctx) {
  const prefs = { days: [], tod: null, after: null, before: null };
  const days = Array.isArray(args.preferred_days) ? args.preferred_days : [];
  for (const d of days) { const n = typeof d === 'number' ? d : DAY_NAMES[String(d).toLowerCase()]; if (n !== undefined && n >= 0 && n <= 6) prefs.days.push(n); }
  if (['morning', 'afternoon', 'evening'].includes(args.time_of_day)) prefs.tod = args.time_of_day;
  if (/^\d{2}:\d{2}$/.test(args.after || '')) prefs.after = args.after;
  if (/^\d{2}:\d{2}$/.test(args.before || '')) prefs.before = args.before;
  return prefs;
}

// ---------------------------------------------------------------- Tool implementations
const TOOLS = {};
const def = (name, description, properties, required, run) => { TOOLS[name] = { name, description, input_schema: { type: 'object', properties, required: required || [] }, run }; };

def('lookup_patient', 'Find patient records that share the caller\'s phone number. Returns first names only; identity must still be verified with verify_identity.',
  { phone: { type: 'string', description: 'Optional. Defaults to the caller ID.' } }, [], (ctx, a) => {
    const matches = patients.findByPhone(ctx.locationId, a.phone || ctx.conv.from_number);
    return { matches: matches.length, candidates: matches.map((p) => ({ first_name: p.first_name })) };
  });

def('verify_identity', 'Verify a caller\'s identity using full name and date of birth (YYYY-MM-DD). Required before discussing or changing any existing appointment. Maximum two attempts.',
  { first_name: { type: 'string' }, last_name: { type: 'string' }, dob: { type: 'string', description: 'YYYY-MM-DD' } }, ['first_name', 'last_name', 'dob'], (ctx, a) => {
    const st = ctx.state;
    if (st.verified) return { verified: true, first_name: st.patient && st.patient.first_name };
    if ((st.verify_attempts || 0) >= 2) return err('LOCKED', 'Too many attempts. Create a callback task for staff.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.dob || '')) return err('BAD_DOB', 'Date of birth must be YYYY-MM-DD.');
    const known = patients.findByName(ctx.locationId, a.first_name, a.last_name);
    if (!known.length) return { verified: false, reason: 'no_record', note: 'No existing record for that name. Treat as a new patient.' };
    const p = patients.verifyIdentity(ctx.locationId, { first_name: a.first_name, last_name: a.last_name, dob: a.dob });
    if (p) {
      st.verified = true; st.patient_id = p.id; st.new_patient = scheduling.isNewPatient(p);
      st.patient = { ...(st.patient || {}), first_name: p.first_name, last_name: p.last_name, dob: p.dob, mobile: p.phone || (st.patient && st.patient.mobile) };
      setConv(ctx, { verified: 1, patient_id: p.id, new_patient: st.new_patient ? 1 : 0 });
      core.audit({ tenantId: ctx.tenantId, actor: 'agent', action: 'identity_verified', resource: 'patient', resourceId: p.id, detail: { conversation: ctx.conv.id } });
      return { verified: true, first_name: p.first_name };
    }
    st.verify_attempts = (st.verify_attempts || 0) + 1;
    const left = 2 - st.verify_attempts;
    if (left <= 0) {
      comms.createTask({ tenantId: ctx.tenantId, locationId: ctx.locationId, kind: 'callback', urgency: 'normal', conversationId: ctx.conv.id,
        title: `Identity could not be verified: ${a.first_name} ${a.last_name} (${ctx.conv.from_number || 'no number'})`, payload: { reason: 'verification_failed' } });
      return { verified: false, reason: 'dob_mismatch', attempts_left: 0, locked: true };
    }
    return { verified: false, reason: 'dob_mismatch', attempts_left: left };
  });

def('get_clinic_info', 'Answer a question about the practice (hours, location, insurance, services, policies) using approved clinic information only. Never guess; if no answer is returned, offer to have the team follow up.',
  { question: { type: 'string' } }, ['question'], (ctx, a) => {
    const r = knowledge.answer(ctx.loc, a.question, ctx.conv.id);
    return r.text ? { answer: r.text, source: r.source } : { answer: null, note: 'No approved information available. Say the team will follow up and call create_task.' };
  });

def('get_availability', 'Find up to 3 open appointment times that satisfy the clinic\'s rules. Only offer times returned by this tool.',
  {
    appointment_type: { type: 'string', description: 'Type code (e.g. NEW_PT_EXAM, CLEANING, CHECKUP, EMERGENCY_EXAM, CONSULT) or a short description' },
    reason: { type: 'string', description: 'Reason for visit in the caller\'s words (used if appointment_type is unclear)' },
    earliest_date: { type: 'string', description: 'YYYY-MM-DD' }, latest_date: { type: 'string', description: 'YYYY-MM-DD' },
    preferred_days: { type: 'array', items: { type: 'string' } }, time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'any'] },
    after: { type: 'string', description: 'HH:MM' }, before: { type: 'string', description: 'HH:MM' }, relax: { type: 'integer', description: '0 strict, 1 ignore time of day, 2 ignore days too' },
  }, [], (ctx, a) => {
    const type = resolveType(ctx, a);
    if (!type) return err('TYPE_NOT_ALLOWED', 'Could not determine an appointment type.');
    const pc = patientCtxFromState(ctx);
    const today = tz.local(ctx.now(), ctx.loc.timezone).date;
    const r = scheduling.findSlots({
      locationId: ctx.locationId, typeId: type.id, patient: { isNew: pc.isNew, age: pc.age }, fromDate: a.earliest_date || today, toDate: a.latest_date || null,
      prefs: normPrefs(a, ctx), relax: a.relax || 0, spread: !type.is_emergency, now: ctx.now(),
    });
    ctx.state.appointment_type_id = type.id;
    if (!r.slots.length) return { slots: [], count: 0, appointment_type: type.name, code: r.code || 'NO_SLOTS', note: r.code ? r.message : 'No openings match. Offer to relax preferences, join the waitlist, or have staff call back.' };
    ctx.state.offered_slots = r.slots;
    ctx.state.offered_history = [...new Set([...(ctx.state.offered_history || []), ...r.slots.map((s) => s.slot_id)])];
    return { appointment_type: type.name, count: r.slots.length, slots: r.slots.map((s, i) => ({ option: i + 1, slot_id: s.slot_id, when: s.spoken, provider: s.provider_name, duration_min: s.duration_min })) };
  });

def('hold_slot', 'Hold an offered time for two minutes while the caller confirms.', { slot_id: { type: 'string' } }, ['slot_id'], (ctx, a) => {
  if (!(ctx.state.offered_history || []).includes(a.slot_id)) return err('SLOT_NOT_OFFERED', 'Only times returned by get_availability can be held.');
  try {
    const pc = patientCtxFromState(ctx);
    const h = scheduling.holdSlot({ locationId: ctx.locationId, slotId: a.slot_id, conversationId: ctx.conv.id, patient: { isNew: pc.isNew, age: pc.age } });
    ctx.state.hold_token = h.token; ctx.state.chosen_slot_id = a.slot_id;
    return { held: true, when: h.slot.spoken, provider: h.slot.provider_name, expires_in_seconds: h.expires_in };
  } catch (e) { return err(e.code || 'ERROR', e.message); }
});

// Create the patient record (new patients) once we have the required details.
function ensurePatient(ctx, details = {}) {
  const st = ctx.state;
  if (st.patient_id) return { patient: patients.getPatient(st.patient_id) };
  const d = { ...(st.patient || {}), ...details };
  const mobile = d.mobile || ctx.conv.from_number;
  if (!d.first_name || !d.last_name) return err('MISSING_FIELDS', 'First and last name are required.');
  if (!d.dob || !/^\d{4}-\d{2}-\d{2}$/.test(d.dob)) return err('MISSING_FIELDS', 'A valid date of birth is required.');
  if (!mobile) return err('MISSING_FIELDS', 'A mobile phone number is required.');
  const existing = patients.verifyIdentity(ctx.locationId, { first_name: d.first_name, last_name: d.last_name, dob: d.dob });
  let p = existing;
  if (!p) {
    const near = patients.findByName(ctx.locationId, d.first_name, d.last_name);
    p = patients.createPatient({ tenantId: ctx.tenantId, locationId: ctx.locationId, first_name: d.first_name, last_name: d.last_name, dob: d.dob, phone: mobile, email: d.email });
    if (near.length) comms.createTask({ tenantId: ctx.tenantId, locationId: ctx.locationId, kind: 'review', patientId: p.id, conversationId: ctx.conv.id, title: `Possible duplicate patient: ${p.first_name} ${p.last_name}`, payload: { similar_ids: near.map((n) => n.id) } });
  }
  st.patient_id = p.id; st.patient = { first_name: p.first_name, last_name: p.last_name, dob: p.dob, mobile: p.phone || mobile };
  st.new_patient = scheduling.isNewPatient(p);
  setConv(ctx, { patient_id: p.id, new_patient: st.new_patient ? 1 : 0 });
  return { patient: p, created: !existing };
}

def('record_insurance', 'Store the caller\'s insurance carrier (and member ID if given). Creates a verification task for staff. Never promise coverage.',
  { carrier: { type: 'string' }, member_id: { type: 'string' } }, ['carrier'], (ctx, a) => {
    ctx.state.insurance = { carrier: String(a.carrier).slice(0, 80), member_id: a.member_id ? String(a.member_id).slice(0, 40) : null };
    const accepted = (ctx.loc.settings.accepted_insurance || []).some((n) => ctx.state.insurance.carrier.toLowerCase().includes(n.toLowerCase().split(' ')[0]));
    return { recorded: true, in_accepted_list: accepted };
  });

function persistInsurance(ctx, patient) {
  const ins = ctx.state.insurance;
  if (!ins || ctx.state.insurance_saved) return;
  patients.addPolicy({ tenantId: ctx.tenantId, patientId: patient.id, carrier: ins.carrier, member_id: ins.member_id, subscriber: `${patient.first_name} ${patient.last_name}` });
  ctx.state.insurance_saved = true;
  if (!/self|unsure/i.test(ins.carrier)) {
    comms.createTask({ tenantId: ctx.tenantId, locationId: ctx.locationId, kind: 'verify_insurance', patientId: patient.id, conversationId: ctx.conv.id, title: `Verify insurance: ${patient.first_name} ${patient.last_name} (${ins.carrier})`, payload: { carrier: ins.carrier } });
  }
}

def('book_appointment', 'Book a previously offered time. Call only after reading back the details and receiving the caller\'s explicit confirmation. New patients need name, date of birth and mobile number.',
  {
    slot_id: { type: 'string' }, hold_token: { type: 'string' }, confirmed_by_caller: { type: 'boolean' }, reason: { type: 'string' },
    patient: { type: 'object', properties: { first_name: { type: 'string' }, last_name: { type: 'string' }, dob: { type: 'string', description: 'YYYY-MM-DD' }, mobile: { type: 'string' }, email: { type: 'string' } } },
  }, ['slot_id', 'confirmed_by_caller'], (ctx, a) => {
    if (a.confirmed_by_caller !== true) return err('CONFIRMATION_REQUIRED', 'Read the details back and get an explicit yes first.');
    if (!(ctx.state.offered_history || []).includes(a.slot_id)) return err('SLOT_NOT_OFFERED', 'Only times returned by get_availability can be booked.');
    const ep = ensurePatient(ctx, a.patient || {});
    if (ep.error) return ep;
    const patient = ep.patient;
    const holdToken = a.hold_token || ctx.state.hold_token || null;
    try {
      const { appointment, idempotent } = scheduling.bookAppointment({
        tenantId: ctx.tenantId, locationId: ctx.locationId, patientId: patient.id, slotId: a.slot_id, source: 'agent', conversationId: ctx.conv.id,
        reason: a.reason || ctx.state.reason || null, idempotencyKey: `${ctx.conv.id}:${a.slot_id}`, holdToken, actor: 'agent',
      });
      ctx.state.appointment_id = appointment.id;
      ctx.state.hold_token = null;
      setConv(ctx, { outcome: 'booked', patient_id: patient.id });
      if (!idempotent) {
        patients.recordConsent({ tenantId: ctx.tenantId, patientId: patient.id, phone: patient.phone, purpose: 'transactional', status: 'granted', source: `booking:${ctx.conv.channel}` });
        persistInsurance(ctx, patient);
        const isNew = scheduling.isNewPatient(patient);
        const body = `${ctx.loc.name}: you're booked for ${appointment.type_name} with ${appointment.provider_name}, ${abs(appointment.start_utc, ctx.loc)}.${ctx.loc.address ? ' ' + ctx.loc.address + '.' : ''}${isNew ? ' Please arrive 10 minutes early and bring your photo ID and insurance card.' : ''} Reply C to confirm, R to reschedule, X to cancel. Reply STOP to opt out.`;
        if (ctx.conv.channel !== 'sms') comms.send({ tenantId: ctx.tenantId, locationId: ctx.locationId, patientId: patient.id, to: patient.phone, body, kind: 'booking_confirmation', conversationId: ctx.conv.id });
        else comms.send({ tenantId: ctx.tenantId, locationId: ctx.locationId, patientId: patient.id, to: patient.phone, body: 'Saved. We will text you reminders before your visit.', kind: 'booking_confirmation', conversationId: ctx.conv.id });
      }
      return { booked: true, appointment: { id: appointment.id, type: appointment.type_name, provider: appointment.provider_name, when: abs(appointment.start_utc, ctx.loc) }, sms_confirmation_sent: ctx.conv.channel !== 'sms' };
    } catch (e) {
      if (e instanceof scheduling.SchedError) return err(e.code, e.message);
      throw e;
    }
  });

function requireVerified(ctx) {
  if (!ctx.state.verified || !ctx.state.patient_id) return err('NOT_VERIFIED', 'Identity has not been verified. Ask for full name and date of birth, then call verify_identity.');
  return null;
}

def('list_appointments', 'List the verified caller\'s upcoming appointments.', {}, [], (ctx) => {
  const nv = requireVerified(ctx); if (nv) return nv;
  const list = scheduling.listForPatient(ctx.state.patient_id);
  ctx.state.known_appointments = list.map((a) => a.id);
  return { count: list.length, appointments: list.map((a) => ({ id: a.id, type: a.type_name, provider: a.provider_name, when: abs(a.start_utc, ctx.loc), confirmed: a.confirmation_status === 'confirmed' })) };
});

function ownAppointment(ctx, id) {
  const a = scheduling.getAppointment(id);
  if (!a || a.patient_id !== ctx.state.patient_id) return null;
  return a;
}

def('reschedule_appointment', 'Move a verified caller\'s appointment to a new offered time. Requires explicit confirmation.',
  { appointment_id: { type: 'string' }, new_slot_id: { type: 'string' }, hold_token: { type: 'string' }, confirmed_by_caller: { type: 'boolean' } }, ['appointment_id', 'new_slot_id', 'confirmed_by_caller'], (ctx, a) => {
    const nv = requireVerified(ctx); if (nv) return nv;
    if (a.confirmed_by_caller !== true) return err('CONFIRMATION_REQUIRED');
    const old = ownAppointment(ctx, a.appointment_id);
    if (!old) return err('NOT_FOUND', 'That appointment was not found for this caller.');
    if (!(ctx.state.offered_history || []).includes(a.new_slot_id)) return err('SLOT_NOT_OFFERED');
    try {
      const { appointment } = scheduling.rescheduleAppointment({ appointmentId: old.id, newSlotId: a.new_slot_id, actor: 'agent', conversationId: ctx.conv.id, idempotencyKey: `${ctx.conv.id}:r:${old.id}:${a.new_slot_id}`, holdToken: a.hold_token || ctx.state.hold_token });
      const p = patients.getPatient(ctx.state.patient_id);
      ctx.state.appointment_id = appointment.id; ctx.state.hold_token = null;
      setConv(ctx, { outcome: 'rescheduled' });
      if (p && p.phone && ctx.conv.channel !== 'sms') comms.send({ tenantId: ctx.tenantId, locationId: ctx.locationId, patientId: p.id, to: p.phone, body: `${ctx.loc.name}: your appointment is now ${abs(appointment.start_utc, ctx.loc)} with ${appointment.provider_name}. Reply C to confirm or X to cancel.`, kind: 'booking_confirmation', conversationId: ctx.conv.id });
      return { rescheduled: true, appointment: { id: appointment.id, type: appointment.type_name, provider: appointment.provider_name, when: abs(appointment.start_utc, ctx.loc) } };
    } catch (e) { if (e instanceof scheduling.SchedError) return err(e.code, e.message); throw e; }
  });

def('cancel_appointment', 'Cancel a verified caller\'s appointment. Requires explicit confirmation. Do not waive fees or negotiate policy.',
  { appointment_id: { type: 'string' }, reason: { type: 'string' }, confirmed_by_caller: { type: 'boolean' } }, ['appointment_id', 'confirmed_by_caller'], (ctx, a) => {
    const nv = requireVerified(ctx); if (nv) return nv;
    if (a.confirmed_by_caller !== true) return err('CONFIRMATION_REQUIRED');
    const appt = ownAppointment(ctx, a.appointment_id);
    if (!appt) return err('NOT_FOUND', 'That appointment was not found for this caller.');
    try {
      const hoursOut = (new Date(appt.start_utc) - ctx.now()) / 3600000;
      scheduling.cancelAppointment({ appointmentId: appt.id, actor: 'agent', reason: a.reason || 'Patient request' });
      setConv(ctx, { outcome: 'cancelled' });
      const late = hoursOut < 24;
      if (late) comms.createTask({ tenantId: ctx.tenantId, locationId: ctx.locationId, kind: 'late_cancel', patientId: appt.patient_id, conversationId: ctx.conv.id, title: `Late cancellation (<24h): ${appt.patient_name}, ${abs(appt.start_utc, ctx.loc)}`, payload: { appointment_id: appt.id } });
      const p = patients.getPatient(appt.patient_id);
      if (p && p.phone && ctx.conv.channel !== 'sms') comms.send({ tenantId: ctx.tenantId, locationId: ctx.locationId, patientId: p.id, to: p.phone, body: `${ctx.loc.name}: your ${appt.type_name} on ${abs(appt.start_utc, ctx.loc)} has been cancelled. Reply with a message or call us to rebook.`, kind: 'cancellation', conversationId: ctx.conv.id });
      return { cancelled: true, late_cancellation: late, policy: late ? ctx.loc.settings.cancellation_policy : null };
    } catch (e) { if (e instanceof scheduling.SchedError) return err(e.code, e.message); throw e; }
  });

def('join_waitlist', 'Add the caller to the waitlist for an earlier or different time. They will be texted if a matching slot opens.',
  { appointment_type: { type: 'string' }, preferred_days: { type: 'array', items: { type: 'string' } }, time_of_day: { type: 'string' } }, [], (ctx, a) => {
    const type = resolveType(ctx, a);
    if (!type) return err('TYPE_NOT_ALLOWED');
    const ep = ensurePatient(ctx, {});
    if (ep.error) return ep;
    const prefs = normPrefs(a, ctx);
    waitlist.add({ tenantId: ctx.tenantId, locationId: ctx.locationId, patientId: ep.patient.id, typeId: type.id, prefs });
    patients.recordConsent({ tenantId: ctx.tenantId, patientId: ep.patient.id, phone: ep.patient.phone, purpose: 'transactional', status: 'granted', source: 'waitlist' });
    ctx.state.waitlisted = true;
    if (!ctx.conv.outcome) setConv(ctx, { outcome: 'waitlisted' });
    return { waitlisted: true, appointment_type: type.name };
  });

def('create_task', 'Create a task for the front-desk team (callback, message, review). Use when you cannot complete something or the caller needs a human follow-up.',
  { kind: { type: 'string', enum: ['callback', 'message', 'review', 'other'] }, title: { type: 'string' }, urgency: { type: 'string', enum: ['normal', 'high'] } }, ['kind', 'title'], (ctx, a) => {
    const id = comms.createTask({
      tenantId: ctx.tenantId, locationId: ctx.locationId, kind: a.kind || 'callback', urgency: a.urgency === 'high' ? 'high' : 'normal', patientId: ctx.state.patient_id || null,
      conversationId: ctx.conv.id, title: String(a.title).slice(0, 200), payload: { caller: ctx.conv.from_number, name: ctx.state.patient ? `${ctx.state.patient.first_name || ''} ${ctx.state.patient.last_name || ''}`.trim() : null },
    });
    if (!ctx.conv.outcome) setConv(ctx, { outcome: 'callback' });
    return { task_created: true, task_id: id };
  });

def('transfer_call', 'Transfer the caller to a human. During open hours on a phone call this connects to the front desk; otherwise a callback task is created.',
  { reason: { type: 'string' } }, ['reason'], (ctx, a) => {
    const s = ctx.loc.settings;
    const dest = s.transfer_number || ctx.loc.phone;
    const staffed = core.isOpenNow(ctx.loc, ctx.now()) || s.transfer_only_in_hours === false;
    setConv(ctx, { handoff: 1 });
    ctx.state.handoff_reason = String(a.reason || '').slice(0, 200);
    if (ctx.conv.channel === 'voice' && dest && staffed) {
      ctx.state.transfer = { to: dest };
      setConv(ctx, { outcome: 'handoff' });
      return { transferred: true, note: 'Tell the caller you are connecting them now.' };
    }
    comms.createTask({
      tenantId: ctx.tenantId, locationId: ctx.locationId, kind: 'callback', urgency: 'high', patientId: ctx.state.patient_id || null, conversationId: ctx.conv.id,
      title: `Caller asked for a person: ${a.reason || 'no reason given'}${ctx.conv.from_number ? ' (' + ctx.conv.from_number + ')' : ''}`, payload: { caller: ctx.conv.from_number },
    });
    setConv(ctx, { outcome: 'callback' });
    return { transferred: false, callback_task_created: true, note: staffed ? 'No live transfer is available on this channel; staff will call back.' : `The office is closed. Hours: ${core.hoursSpoken(ctx.loc)}. A callback task was created.` };
  });

def('send_sms', 'Text the caller the clinic address and hours.', { template: { type: 'string', enum: ['clinic_info'] } }, ['template'], (ctx) => {
  const to = mobileFor(ctx);
  if (!to) return err('NO_PHONE', 'No mobile number is available.');
  const r = comms.send({ tenantId: ctx.tenantId, locationId: ctx.locationId, patientId: ctx.state.patient_id || null, to, kind: 'clinic_info', conversationId: ctx.conv.id,
    body: `${ctx.loc.name}${ctx.loc.address ? ', ' + ctx.loc.address : ''}${ctx.loc.phone ? '. Phone ' + ctx.loc.phone : ''}. Hours: ${core.hoursSpoken(ctx.loc)}.` });
  return { sent: r.status !== 'blocked_no_consent', status: r.status };
});

def('flag_emergency', 'Flag a dental or medical emergency. Use level "life_threatening" for breathing/swallowing difficulty, uncontrolled bleeding, spreading facial swelling or major trauma; "urgent" for severe pain, knocked-out/broken tooth, swelling. This cannot be undone.',
  { level: { type: 'string', enum: ['life_threatening', 'urgent'] }, details: { type: 'string' } }, ['level'], (ctx, a) => applyTriage(ctx, { level: a.level, rule: 'model_flag', text: a.details || '' }));

// Shared by the orchestrator (deterministic triage) and the flag_emergency tool
function applyTriage(ctx, { level, rule, text }) {
  const st = ctx.state;
  st.triage = st.triage || {};
  const first = !st.triage[level];
  st.triage[level] = true;
  if (first) {
    db.prepare('INSERT INTO triage_events (id,tenant_id,conversation_id,level,rule,action,ts) VALUES (?,?,?,?,?,?,?)')
      .run(uid(), ctx.tenantId, ctx.conv.id, level, rule, level === 'life_threatening' ? 'directed_to_911' : 'emergency_flow', nowIso());
    comms.createTask({
      tenantId: ctx.tenantId, locationId: ctx.locationId, kind: 'emergency', urgency: 'urgent', patientId: st.patient_id || null, conversationId: ctx.conv.id,
      title: `${level === 'life_threatening' ? 'POSSIBLE MEDICAL EMERGENCY' : 'Urgent dental issue'}: ${String(text).slice(0, 120)}${ctx.conv.from_number ? ' (' + ctx.conv.from_number + ')' : ''}`, payload: { level, rule, caller: ctx.conv.from_number },
    });
    core.emit(ctx.tenantId, 'emergency', { conversation_id: ctx.conv.id, level });
  }
  setConv(ctx, { urgency: level });
  const pol = ctx.loc.settings.emergency_policy;
  if (level === 'life_threatening') {
    st.ended = true; st.step = 'ESCALATE';
    setConv(ctx, { outcome: 'emergency_911', handoff: 1 });
    return { level, script: pol.script_life, ended: true };
  }
  st.urgent = true;
  const open = core.isOpenNow(ctx.loc, ctx.now());
  return { level, script: pol.script_urgent, on_call_number: !open && pol.on_call_number ? pol.on_call_number : null, note: 'Offer the earliest emergency exam slot via get_availability.' };
}

def('end_conversation', 'End the call or chat once the caller has no further needs and you have said goodbye.', {}, [], (ctx) => {
  ctx.state.ended = true;
  return { ended: true };
});

function toolDefs() { return Object.values(TOOLS).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })); }

// Executes a tool with logging, timing and error containment
function runTool(ctx, name, args = {}) {
  const t0 = Date.now();
  let result, status = 'ok';
  try {
    if (!TOOLS[name]) result = err('UNKNOWN_TOOL', `Unknown tool ${name}`);
    else result = TOOLS[name].run(ctx, args || {});
    if (result && result.error) status = 'error';
  } catch (e) {
    console.error(`[tool ${name}]`, e);
    result = err('TOOL_FAILURE', 'Something went wrong. Offer to have the team follow up.');
    status = 'error';
  }
  try {
    db.prepare('INSERT INTO tool_calls (id,conversation_id,name,args_json,result_json,status,latency_ms,ts) VALUES (?,?,?,?,?,?,?,?)')
      .run(uid(), ctx.conv.id, name, j(redactArgs(args)), j(result).slice(0, 4000), status, Date.now() - t0, nowIso());
  } catch (_) { /* logging must never break a call */ }
  return result;
}
// Do not persist DOB/phone in tool logs
function redactArgs(a) {
  const c = JSON.parse(JSON.stringify(a || {}));
  const scrub = (o) => { if (o && typeof o === 'object') for (const k of Object.keys(o)) { if (['dob', 'mobile', 'phone', 'email', 'member_id'].includes(k)) o[k] = '[redacted]'; else scrub(o[k]); } };
  scrub(c); return c;
}

module.exports = { TOOLS, toolDefs, runTool, applyTriage, ensurePatient, setConv, requireVerified, resolveType, patientCtxFromState, mobileFor, abs, persistInsurance };
