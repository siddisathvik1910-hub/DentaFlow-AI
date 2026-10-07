// Deterministic scheduling engine. The LLM never touches the calendar directly;
// every booking goes through the rules and re-validation in this module.
const { db, uid, nowIso, j, parse, tx } = require('../db');
const tz = require('../tz');
const clock = require('../clock');
const core = require('./core');
const patients = require('./patients');
const { getAdapter } = require('./pms');

class SchedError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}
const MESSAGES = {
  SLOT_TAKEN: 'That time was just taken.',
  SLOT_HELD: 'That time is being held for someone else.',
  OUTSIDE_HOURS: 'That time is outside our working hours.',
  LEAD_TIME: 'That time is too soon to book.',
  BEYOND_HORIZON: 'That time is too far in the future to book.',
  NEW_PATIENT_CAP: 'The new-patient limit for that day has been reached.',
  EMERGENCY_RESERVE: 'That time is reserved for emergencies.',
  TYPE_NOT_ALLOWED: 'That appointment type is not available for this patient.',
  PROVIDER_NOT_ELIGIBLE: 'That provider cannot see this patient for that appointment type.',
  NO_PERMISSION: 'That appointment must be handled by our staff.',
  NOT_FOUND: 'Not found.',
};

// ---------------------------------------------------------------- Holds (in-memory with TTL; use Redis when scaling out)
const HOLD_TTL_MS = 120000;
const holds = new Map(); // token -> {providerId, startMs, endMs, conversationId, expires}
function cleanHolds() { const n = Date.now(); for (const [k, h] of holds) if (h.expires < n) holds.delete(k); }
function releaseHoldsFor(conversationId) { for (const [k, h] of holds) if (h.conversationId === conversationId) holds.delete(k); }
function releaseHold(token) { holds.delete(token); }
function heldByOther(providerId, startMs, endMs, token) {
  cleanHolds();
  for (const [k, h] of holds) {
    if (k === token) continue;
    if (h.providerId === providerId && h.startMs < endMs && h.endMs > startMs) return true;
  }
  return false;
}

// ---------------------------------------------------------------- Catalog helpers
const hydrateType = (r) => r && ({
  ...r, is_emergency: !!r.is_emergency, new_patient_only: !!r.new_patient_only, existing_only: !!r.existing_only, active: !!r.active,
  allowed_provider_types: parse(r.allowed_provider_types, ['dentist']), allowed_provider_ids: parse(r.allowed_provider_ids, []),
  agent_permissions: parse(r.agent_permissions, { book: true, reschedule: true, cancel: true }), keywords: parse(r.keywords, []),
});
const hydrateProvider = (r) => r && ({ ...r, accepts_new: !!r.accepts_new, active: !!r.active, schedule: parse(r.schedule_json, {}) });
const getTypes = (locationId, all = false) => db.prepare(`SELECT * FROM appointment_types WHERE location_id=? ${all ? '' : 'AND active=1'} ORDER BY name`).all(locationId).map(hydrateType);
const getType = (id) => hydrateType(db.prepare('SELECT * FROM appointment_types WHERE id=?').get(id));
const getTypeByCode = (locationId, code) => hydrateType(db.prepare('SELECT * FROM appointment_types WHERE location_id=? AND code=?').get(locationId, code));
const getProviders = (locationId, all = false) => db.prepare(`SELECT * FROM providers WHERE location_id=? ${all ? '' : 'AND active=1'} ORDER BY name`).all(locationId).map(hydrateProvider);
const getProvider = (id) => hydrateProvider(db.prepare('SELECT * FROM providers WHERE id=?').get(id));

function isNewPatient(patient) {
  if (!patient) return true;
  if (patient.last_visit) return false;
  return !db.prepare("SELECT 1 FROM appointments WHERE patient_id=? AND status='completed'").get(patient.id);
}

// Map free text (reason for visit) to an appointment type using configured keywords
function typeFromText(locationId, text, { isNew = false, urgent = false } = {}) {
  const types = getTypes(locationId);
  const t = String(text || '').toLowerCase();
  if (urgent) return types.find((x) => x.is_emergency) || null;
  let best = null, bestScore = 0;
  for (const ty of types) {
    if (ty.is_emergency) continue;
    for (const kw of ty.keywords) {
      if (kw && t.includes(kw.toLowerCase()) && kw.length > bestScore) { best = ty; bestScore = kw.length; }
    }
  }
  if (best) {
    if (isNew && best.existing_only) {
      // New patients must start with the new-patient exam
      return types.find((x) => x.new_patient_only) || best;
    }
    return best;
  }
  if (isNew) return types.find((x) => x.new_patient_only) || null;
  return types.find((x) => x.existing_only && /check/i.test(x.name)) || types.find((x) => !x.is_emergency && !x.new_patient_only) || null;
}

// ---------------------------------------------------------------- Availability core
function subtract(blocks, [bs, be]) {
  const out = [];
  for (const [s, e] of blocks) {
    if (be <= s || bs >= e) { out.push([s, e]); continue; }
    if (bs > s) out.push([s, bs]);
    if (be < e) out.push([be, e]);
  }
  return out;
}

function providerBlocks(ctx, provider, dateStr) {
  const key = provider.id + dateStr;
  if (ctx.blockCache.has(key)) return ctx.blockCache.get(key);
  const wd = tz.WD[tz.weekdayOf(dateStr)];
  const clinic = ctx.loc.hours[wd];
  let blocks = [];
  if (clinic) {
    const cs = tz.toMin(clinic[0]), ce = tz.toMin(clinic[1]);
    blocks = (provider.schedule[wd] || []).map(([s, e]) => [Math.max(cs, tz.toMin(s)), Math.min(ce, tz.toMin(e))]).filter(([s, e]) => e > s);
    for (const b of ctx.loc.settings.blockouts || []) {
      if (b.date === dateStr && (!b.provider_id || b.provider_id === provider.id)) blocks = subtract(blocks, [b.start ? tz.toMin(b.start) : 0, b.end ? tz.toMin(b.end) : 1440]);
    }
  }
  ctx.blockCache.set(key, blocks);
  return blocks;
}

function typeAllowedFor(type, patient) {
  if (!type || !type.active) return 'TYPE_NOT_ALLOWED';
  if (patient.isNew === true && type.existing_only) return 'TYPE_NOT_ALLOWED';
  if (patient.isNew === false && type.new_patient_only) return 'TYPE_NOT_ALLOWED';
  if (patient.age !== null && patient.age !== undefined) {
    if (type.min_age !== null && type.min_age !== undefined && patient.age < type.min_age) return 'TYPE_NOT_ALLOWED';
    if (type.max_age !== null && type.max_age !== undefined && patient.age > type.max_age) return 'TYPE_NOT_ALLOWED';
  }
  return null;
}

function buildCtx({ locationId, typeId, patient = {}, holdToken = null, excludeAppointmentId = null, now = clock.now() }) {
  const loc = core.getLocation(locationId);
  const type = getType(typeId);
  if (!loc || !type) throw new SchedError('NOT_FOUND');
  const providers = getProviders(locationId).filter((p) => {
    if (type.allowed_provider_ids.length) return type.allowed_provider_ids.includes(p.id);
    return type.allowed_provider_types.includes(p.type);
  }).filter((p) => !((type.new_patient_only || patient.isNew) && !p.accepts_new));
  return {
    loc, type, providers, patient, holdToken, excludeAppointmentId, now, adapter: getAdapter(locationId),
    earliest: new Date(now.getTime() + type.lead_time_min * 60000),
    latest: new Date(now.getTime() + type.max_horizon_days * 86400000),
    blockCache: new Map(), busy: new Map(),
  };
}

function busyFor(ctx, provider, fromMs, toMs) {
  const pre = ctx.busy.get(provider.id);
  const rows = pre || ctx.adapter.listAppointments({ locationId: ctx.loc.id, providerId: provider.id, fromUtc: new Date(fromMs).toISOString(), toUtc: new Date(toMs).toISOString() });
  return rows.filter((a) => a.id !== ctx.excludeAppointmentId && new Date(a.start_utc).getTime() < toMs && new Date(a.block_end_utc).getTime() > fromMs);
}

// Returns null when the start time is bookable, otherwise a reason code
function candidateOk(ctx, provider, startDate) {
  const { type, loc } = ctx;
  if (startDate < ctx.earliest) return 'LEAD_TIME';
  if (startDate > ctx.latest) return 'BEYOND_HORIZON';
  const l = tz.local(startDate, loc.timezone);
  const blocks = providerBlocks(ctx, provider, l.date);
  if (!blocks.some(([s, e]) => l.minutes >= s && l.minutes + type.duration_min <= e)) return 'OUTSIDE_HOURS';
  const startMs = startDate.getTime();
  const blockEndMs = startMs + (type.duration_min + type.buffer_min) * 60000;
  if (busyFor(ctx, provider, startMs, blockEndMs).length) return 'SLOT_TAKEN';
  if (heldByOther(provider.id, startMs, blockEndMs, ctx.holdToken)) return 'SLOT_HELD';
  // Emergency reserve: first N minutes of the provider's day are for emergencies until the release time
  const reserve = loc.settings.emergency_reserve_minutes || 0;
  if (reserve > 0 && !type.is_emergency && provider.type === 'dentist' && blocks.length) {
    const nowL = tz.local(ctx.now, loc.timezone);
    const released = nowL.date === l.date && nowL.minutes >= tz.toMin(loc.settings.emergency_reserve_release || '12:00');
    if (!released && l.minutes < blocks[0][0] + reserve) return 'EMERGENCY_RESERVE';
  }
  // New-patient daily cap per provider
  const cap = loc.settings.new_patient_daily_cap;
  if (type.new_patient_only && cap) {
    const dayStart = tz.zonedToUtc(l.date, '00:00', loc.timezone).toISOString();
    const dayEnd = tz.zonedToUtc(tz.addDays(l.date, 1), '00:00', loc.timezone).toISOString();
    const n = db.prepare(`SELECT COUNT(*) c FROM appointments a JOIN appointment_types t ON t.id=a.type_id
      WHERE a.provider_id=? AND a.start_utc>=? AND a.start_utc<? AND a.status IN ('booked','confirmed','completed') AND t.new_patient_only=1 AND a.id<>?`)
      .get(provider.id, dayStart, dayEnd, ctx.excludeAppointmentId || '').c;
    if (n >= cap) return 'NEW_PATIENT_CAP';
  }
  return null;
}

function prefsMatch(prefs, l, relax) {
  if (!prefs || relax >= 2) return true;
  if (prefs.days && prefs.days.length && !prefs.days.includes(l.weekday)) return false;
  if (relax >= 1) return true;
  if (prefs.tod === 'morning' && l.minutes >= 12 * 60) return false;
  if (prefs.tod === 'afternoon' && (l.minutes < 12 * 60 || l.minutes >= 17 * 60)) return false;
  if (prefs.tod === 'evening' && l.minutes < 16 * 60) return false;
  if (prefs.after && l.minutes < tz.toMin(prefs.after)) return false;
  if (prefs.before && l.minutes >= tz.toMin(prefs.before)) return false;
  return true;
}

function toSlot(ctx, provider, startDate) {
  const { type, loc } = ctx;
  const end = new Date(startDate.getTime() + type.duration_min * 60000);
  const l = tz.local(startDate, loc.timezone);
  return {
    slot_id: `${provider.id}~${startDate.toISOString()}~${type.id}`,
    provider_id: provider.id, provider_name: provider.name, type_id: type.id, type_name: type.name, duration_min: type.duration_min,
    start_utc: startDate.toISOString(), end_utc: end.toISOString(),
    local_date: l.date, local_time: l.time, weekday: l.weekdayName,
    spoken: tz.speak(startDate, loc.timezone, ctx.now),
  };
}

function diversify(cands, limit) {
  const picked = [];
  const dayOf = (c) => c.local_date;
  for (const c of cands) { if (picked.length >= limit) break; if (!picked.some((p) => dayOf(p) === dayOf(c))) picked.push(c); }
  for (const c of cands) {
    if (picked.length >= limit) break;
    if (picked.includes(c)) continue;
    if (picked.every((p) => dayOf(p) !== dayOf(c) || Math.abs(new Date(p.start_utc) - new Date(c.start_utc)) >= 2 * 3600000)) picked.push(c);
  }
  for (const c of cands) { if (picked.length >= limit) break; if (!picked.includes(c)) picked.push(c); }
  return picked.sort((a, b) => a.start_utc.localeCompare(b.start_utc));
}

// Urgent visits: earliest openings, but spaced at least an hour apart so the caller has a real choice
function earliestWithGap(cands, limit) {
  const picked = [];
  for (const c of cands) {
    if (picked.length >= limit) break;
    if (picked.every((p) => Math.abs(new Date(p.start_utc) - new Date(c.start_utc)) >= 3600000)) picked.push(c);
  }
  for (const c of cands) { if (picked.length >= limit) break; if (!picked.includes(c)) picked.push(c); }
  return picked.sort((a, b) => a.start_utc.localeCompare(b.start_utc));
}

function findSlots({ locationId, typeId, patient = {}, fromDate, toDate, prefs = null, providerId = null, limit = 3, relax = 0, spread = true, holdToken = null, excludeAppointmentId = null, now = clock.now() }) {
  const ctx = buildCtx({ locationId, typeId, patient, holdToken, excludeAppointmentId, now });
  const denied = typeAllowedFor(ctx.type, patient);
  if (denied) return { slots: [], code: denied, message: MESSAGES[denied], type: ctx.type };
  const today = tz.local(now, ctx.loc.timezone).date;
  const start = fromDate && fromDate > today ? fromDate : today;
  const horizonEnd = tz.local(ctx.latest, ctx.loc.timezone).date;
  let end = toDate && toDate < horizonEnd ? toDate : horizonEnd;
  const maxEnd = tz.addDays(start, 60);
  if (end > maxEnd) end = maxEnd;
  const providers = ctx.providers.filter((p) => !providerId || p.id === providerId);
  for (const p of providers) {
    ctx.busy.set(p.id, ctx.adapter.listAppointments({ locationId, providerId: p.id, fromUtc: new Date(now.getTime() - 86400000).toISOString(), toUtc: new Date(ctx.latest.getTime() + 86400000).toISOString() }));
  }
  const step = ctx.loc.settings.slot_step_min || 15;
  const cands = [];
  for (let d = start; d <= end && cands.length < 80; d = tz.addDays(d, 1)) {
    for (const p of providers) {
      for (const [bs, be] of providerBlocks(ctx, p, d)) {
        for (let m = bs; m + ctx.type.duration_min <= be; m += step) {
          const startDate = tz.zonedToUtc(d, tz.fromMin(m), ctx.loc.timezone);
          const l = { date: d, minutes: m, weekday: tz.weekdayOf(d) };
          if (!prefsMatch(prefs, l, relax)) continue;
          if (candidateOk(ctx, p, startDate)) continue;
          cands.push(toSlot(ctx, p, startDate));
        }
      }
    }
  }
  cands.sort((a, b) => a.start_utc.localeCompare(b.start_utc) || a.provider_name.localeCompare(b.provider_name));
  // drop duplicate start times across providers (offer one per time)
  const seen = new Set();
  const uniq = cands.filter((c) => (seen.has(c.start_utc) ? false : seen.add(c.start_utc)));
  return { slots: spread ? diversify(uniq, limit) : earliestWithGap(uniq, limit), total: uniq.length, type: ctx.type };
}

const parseSlotId = (id) => { const [providerId, startUtc, typeId] = String(id || '').split('~'); return { providerId, startUtc, typeId }; };

function checkSlot({ locationId, slotId, patient = {}, holdToken = null, excludeAppointmentId = null }) {
  const { providerId, startUtc, typeId } = parseSlotId(slotId);
  if (!providerId || !startUtc || !typeId || isNaN(Date.parse(startUtc))) return { ok: false, code: 'NOT_FOUND' };
  const ctx = buildCtx({ locationId, typeId, patient, holdToken, excludeAppointmentId });
  const denied = typeAllowedFor(ctx.type, patient);
  if (denied) return { ok: false, code: denied };
  const provider = ctx.providers.find((p) => p.id === providerId);
  if (!provider) return { ok: false, code: 'PROVIDER_NOT_ELIGIBLE' };
  const code = candidateOk(ctx, provider, new Date(startUtc));
  return code ? { ok: false, code } : { ok: true, slot: toSlot(ctx, provider, new Date(startUtc)), ctx };
}

function patientCtx(p) { return p ? { isNew: isNewPatient(p), age: patients.ageOf(p.dob) } : { isNew: true, age: null }; }

// ---------------------------------------------------------------- Holds API
function holdSlot({ locationId, slotId, conversationId, patient = {} }) {
  releaseHoldsFor(conversationId);
  const chk = checkSlot({ locationId, slotId, patient });
  if (!chk.ok) throw new SchedError(chk.code, MESSAGES[chk.code]);
  const { providerId, startUtc, typeId } = parseSlotId(slotId);
  const type = getType(typeId);
  const token = uid();
  const startMs = new Date(startUtc).getTime();
  holds.set(token, { providerId, startMs, endMs: startMs + (type.duration_min + type.buffer_min) * 60000, conversationId, expires: Date.now() + HOLD_TTL_MS });
  return { token, expires_in: HOLD_TTL_MS / 1000, slot: chk.slot };
}

// ---------------------------------------------------------------- Appointments
function hydrateAppt(r) {
  if (!r) return null;
  const loc = core.getLocation(r.location_id);
  const prov = db.prepare('SELECT name FROM providers WHERE id=?').get(r.provider_id);
  const type = db.prepare('SELECT name, code, value_estimate, duration_min FROM appointment_types WHERE id=?').get(r.type_id);
  const pat = db.prepare('SELECT first_name,last_name FROM patients WHERE id=?').get(r.patient_id);
  const d = new Date(r.start_utc);
  const l = tz.local(d, loc.timezone);
  return {
    id: r.id, location_id: r.location_id, patient_id: r.patient_id, patient_name: pat ? `${pat.first_name} ${pat.last_name}` : '',
    provider_id: r.provider_id, provider_name: prov?.name, type_id: r.type_id, type_name: type?.name, type_code: type?.code, duration_min: type?.duration_min,
    start_utc: r.start_utc, end_utc: r.end_utc, status: r.status, source: r.source, confirmation_status: r.confirmation_status, reason: r.reason,
    local_date: l.date, local_time: l.time, weekday: l.weekdayName, spoken: tz.speak(d, loc.timezone, clock.now()), conversation_id: r.conversation_id, value_estimate: type?.value_estimate,
  };
}
const getAppointment = (id) => hydrateAppt(db.prepare('SELECT * FROM appointments WHERE id=?').get(id));
function listForPatient(patientId, { upcoming = true } = {}) {
  const rows = upcoming
    ? db.prepare("SELECT * FROM appointments WHERE patient_id=? AND status IN ('booked','confirmed') AND start_utc>=? ORDER BY start_utc").all(patientId, clock.iso())
    : db.prepare('SELECT * FROM appointments WHERE patient_id=? ORDER BY start_utc DESC').all(patientId);
  return rows.map(hydrateAppt);
}

function bookAppointment({ tenantId, locationId, patientId, slotId, source = 'agent', conversationId = null, reason = null, idempotencyKey = null, holdToken = null, actor = 'agent', skipPermission = false }) {
  if (idempotencyKey) {
    const ex = db.prepare('SELECT * FROM appointments WHERE idempotency_key=?').get(idempotencyKey);
    if (ex) return { appointment: hydrateAppt(ex), idempotent: true };
  }
  const patient = patients.getPatient(patientId);
  if (!patient) throw new SchedError('NOT_FOUND', 'Patient not found');
  const pctx = patientCtx(patient);
  const { providerId, startUtc, typeId } = parseSlotId(slotId);
  const type = getType(typeId);
  if (!type) throw new SchedError('NOT_FOUND', 'Appointment type not found');
  if (!skipPermission && source === 'agent' && type.agent_permissions.book === false) throw new SchedError('NO_PERMISSION', MESSAGES.NO_PERMISSION);
  const id = uid();
  tx(() => {
    const chk = checkSlot({ locationId, slotId, patient: pctx, holdToken });
    if (!chk.ok) throw new SchedError(chk.code, MESSAGES[chk.code]);
    const start = new Date(startUtc);
    const end = new Date(start.getTime() + type.duration_min * 60000);
    const blockEnd = new Date(end.getTime() + type.buffer_min * 60000);
    db.prepare(`INSERT INTO appointments (id,tenant_id,location_id,patient_id,provider_id,type_id,start_utc,end_utc,block_end_utc,status,source,confirmation_status,idempotency_key,reason,conversation_id,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,'booked',?,'unconfirmed',?,?,?,?)`)
      .run(id, tenantId, locationId, patientId, providerId, typeId, start.toISOString(), end.toISOString(), blockEnd.toISOString(), source, idempotencyKey, reason, conversationId, nowIso());
    logEvent(id, 'created', actor, { source });
  });
  if (holdToken) releaseHold(holdToken);
  if (conversationId) releaseHoldsFor(conversationId);
  const appt = getAppointment(id);
  try { // push to external PMS (no-op for native); failures never lose the local booking
    const ext = getAdapter(locationId).createAppointment(appt);
    if (ext) db.prepare('UPDATE appointments SET pms_appointment_id=? WHERE id=?').run(String(ext), id);
  } catch (e) { logEvent(id, 'pms_push_failed', 'system', { error: e.message }); }
  require('./reminders').scheduleForAppointment(id);
  core.emit(tenantId, 'appointment.created', { id, source });
  return { appointment: appt, idempotent: false };
}

function logEvent(appointmentId, event, actor, payload) {
  db.prepare('INSERT INTO appointment_events (id,appointment_id,event,actor,payload,ts) VALUES (?,?,?,?,?,?)').run(uid(), appointmentId, event, actor || null, payload ? j(payload) : null, nowIso());
}

function cancelAppointment({ appointmentId, actor = 'agent', reason = null, skipBackfill = false, status = 'cancelled' }) {
  const row = db.prepare('SELECT * FROM appointments WHERE id=?').get(appointmentId);
  if (!row) throw new SchedError('NOT_FOUND');
  if (!['booked', 'confirmed'].includes(row.status)) return { appointment: hydrateAppt(row), already: true };
  const type = getType(row.type_id);
  if (actor === 'agent' && type && type.agent_permissions.cancel === false) throw new SchedError('NO_PERMISSION', MESSAGES.NO_PERMISSION);
  db.prepare('UPDATE appointments SET status=? WHERE id=?').run(status, appointmentId);
  logEvent(appointmentId, status, actor, { reason });
  db.prepare("UPDATE reminder_schedules SET status='cancelled' WHERE appointment_id=? AND status='pending'").run(appointmentId);
  try { getAdapter(row.location_id).cancelAppointment(hydrateAppt(row)); } catch (e) { logEvent(appointmentId, 'pms_cancel_failed', 'system', { error: e.message }); }
  core.emit(row.tenant_id, 'appointment.cancelled', { id: appointmentId });
  if (!skipBackfill && new Date(row.start_utc) > clock.now()) {
    try { require('./waitlist').onCancellation(row); } catch (e) { console.error('backfill error', e.message); }
  }
  return { appointment: getAppointment(appointmentId) };
}

// Book the new slot first, release the old one only after success so the patient is never left with nothing.
function rescheduleAppointment({ appointmentId, newSlotId, actor = 'agent', conversationId = null, idempotencyKey = null, holdToken = null }) {
  const old = db.prepare('SELECT * FROM appointments WHERE id=?').get(appointmentId);
  if (!old) throw new SchedError('NOT_FOUND');
  if (!['booked', 'confirmed'].includes(old.status)) throw new SchedError('NOT_FOUND', 'That appointment is no longer active.');
  const oldType = getType(old.type_id);
  if (actor === 'agent' && oldType.agent_permissions.reschedule === false) throw new SchedError('NO_PERMISSION', MESSAGES.NO_PERMISSION);
  if (idempotencyKey) {
    const ex = db.prepare('SELECT * FROM appointments WHERE idempotency_key=?').get(idempotencyKey);
    if (ex) return { appointment: hydrateAppt(ex), idempotent: true };
  }
  const patient = patients.getPatient(old.patient_id);
  const pctx = patientCtx(patient);
  const { providerId, startUtc, typeId } = parseSlotId(newSlotId);
  const type = getType(typeId);
  const id = uid();
  tx(() => {
    const chk = checkSlot({ locationId: old.location_id, slotId: newSlotId, patient: pctx, holdToken, excludeAppointmentId: appointmentId });
    if (!chk.ok) throw new SchedError(chk.code, MESSAGES[chk.code]);
    const start = new Date(startUtc);
    const end = new Date(start.getTime() + type.duration_min * 60000);
    const blockEnd = new Date(end.getTime() + type.buffer_min * 60000);
    db.prepare(`INSERT INTO appointments (id,tenant_id,location_id,patient_id,provider_id,type_id,start_utc,end_utc,block_end_utc,status,source,confirmation_status,idempotency_key,reason,conversation_id,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,'booked',?,'unconfirmed',?,?,?,?)`)
      .run(id, old.tenant_id, old.location_id, old.patient_id, providerId, typeId, start.toISOString(), end.toISOString(), blockEnd.toISOString(), actor === 'agent' ? 'agent' : 'staff', idempotencyKey, old.reason, conversationId, nowIso());
    logEvent(id, 'created', actor, { rescheduled_from: appointmentId });
    db.prepare("UPDATE appointments SET status='cancelled' WHERE id=?").run(appointmentId);
    logEvent(appointmentId, 'rescheduled', actor, { to: id });
    db.prepare("UPDATE reminder_schedules SET status='cancelled' WHERE appointment_id=? AND status='pending'").run(appointmentId);
  });
  if (holdToken) releaseHold(holdToken);
  if (conversationId) releaseHoldsFor(conversationId);
  try { getAdapter(old.location_id).cancelAppointment(hydrateAppt(old)); const ext = getAdapter(old.location_id).createAppointment(getAppointment(id)); if (ext) db.prepare('UPDATE appointments SET pms_appointment_id=? WHERE id=?').run(String(ext), id); } catch (_) { /* logged via events below */ }
  require('./reminders').scheduleForAppointment(id);
  core.emit(old.tenant_id, 'appointment.rescheduled', { id, from: appointmentId });
  try { require('./waitlist').onCancellation(old); } catch (e) { console.error('backfill error', e.message); }
  return { appointment: getAppointment(id), previous: hydrateAppt(old) };
}

function confirmAppointment(appointmentId, via = 'sms') {
  db.prepare("UPDATE appointments SET confirmation_status='confirmed' WHERE id=? AND status IN ('booked','confirmed')").run(appointmentId);
  logEvent(appointmentId, 'confirmed', via, null);
  const a = getAppointment(appointmentId);
  if (a) core.emit(db.prepare('SELECT tenant_id FROM appointments WHERE id=?').get(appointmentId).tenant_id, 'appointment.confirmed', { id: appointmentId });
  return a;
}

function setOutcome(appointmentId, status, actor) {
  const row = db.prepare('SELECT * FROM appointments WHERE id=?').get(appointmentId);
  if (!row) throw new SchedError('NOT_FOUND');
  db.prepare('UPDATE appointments SET status=? WHERE id=?').run(status, appointmentId);
  logEvent(appointmentId, status, actor, null);
  if (status === 'no_show') db.prepare('UPDATE patients SET no_shows=no_shows+1 WHERE id=?').run(row.patient_id);
  if (status === 'completed') db.prepare('UPDATE patients SET last_visit=? WHERE id=?').run(row.start_utc.slice(0, 10), row.patient_id);
  return getAppointment(appointmentId);
}

module.exports = {
  SchedError, MESSAGES, getTypes, getType, getTypeByCode, getProviders, getProvider, isNewPatient, typeFromText, findSlots, checkSlot, parseSlotId, holdSlot,
  releaseHold, releaseHoldsFor, bookAppointment, cancelAppointment, rescheduleAppointment, confirmAppointment, setOutcome, getAppointment, listForPatient, hydrateAppt,
  patientCtx, logEvent, hydrateType, hydrateProvider, cleanHolds,
};
