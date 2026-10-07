const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { db, uid, nowIso, j, parse } = require('../db');
const cfg = require('../config');
const clock = require('../clock');
const tz = require('../tz');
const { encrypt } = require('../crypto');
const sec = require('../middleware/security');
const core = require('../services/core');
const patientsSvc = require('../services/patients');
const scheduling = require('../services/scheduling');
const knowledge = require('../services/knowledge');
const comms = require('../services/comms');
const waitlist = require('../services/waitlist');
const campaigns = require('../services/campaigns');
const analytics = require('../services/analytics');
const conversations = require('../services/conversations');
const inbound = require('../services/inbound');
const { getAdapter } = require('../services/pms');

const router = express.Router();
router.use(sec.limits.api, sec.requireAuth, sec.csrfGuard);

const handleErr = (req, res, e) => {
  if (e instanceof scheduling.SchedError) return res.status(409).json({ error: e.message, code: e.code });
  if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message });
  console.error('[api]', req.method, req.path, e);
  return res.status(500).json({ error: 'Something went wrong.' });
};
// Handles both sync throws (validation errors) and rejected promises with the same error mapping
const wrap = (fn) => (req, res, next) => {
  try { Promise.resolve(fn(req, res, next)).catch((e) => handleErr(req, res, e)); } catch (e) { handleErr(req, res, e); }
};
const validate = (schema, data) => { const r = schema.safeParse(data || {}); if (!r.success) throw Object.assign(new Error(r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')), { status: 400 }); return r.data; };
const audit = (req, action, resource, resourceId, detail) => core.audit({ tenantId: req.user.tenant_id, actor: req.user.email, action, resource, resourceId, ip: req.ip, detail });
const canManage = sec.requireRole('owner', 'manager');

// Resolve the active location (tenant-scoped; never trust a client-supplied id without checking ownership)
router.use((req, res, next) => {
  const locs = core.listLocations(req.user.tenant_id);
  if (!locs.length) return res.status(409).json({ error: 'No location configured' });
  const wanted = req.query.location_id || req.headers['x-location-id'];
  req.loc = locs.find((l) => l.id === wanted) || locs[0];
  req.locs = locs;
  next();
});
const own = (req, table, id) => db.prepare(`SELECT * FROM ${table} WHERE id=? AND location_id=?`).get(id, req.loc.id);

// ---------------------------------------------------------------- session / overview
router.get('/me', wrap((req, res) => {
  const tenant = db.prepare('SELECT id,name,plan FROM tenants WHERE id=?').get(req.user.tenant_id);
  res.json({
    user: req.user, tenant, locations: req.locs.map((l) => ({ id: l.id, name: l.name, timezone: l.timezone })), location: { id: req.loc.id, name: req.loc.name, timezone: req.loc.timezone, widget_key: req.loc.widget_key },
    features: { agent_engine: cfg.anthropic.key ? 'claude' : 'builtin', sms_provider: cfg.twilio.sid ? 'twilio' : 'simulated', voice_provider: cfg.twilio.sid ? 'twilio' : 'browser-simulator', billing: !!cfg.stripe.key, base_url: cfg.baseUrl },
  });
}));

router.get('/overview', wrap((req, res) => {
  const loc = req.loc;
  const today = tz.local(clock.now(), loc.timezone).date;
  const dayStart = tz.zonedToUtc(today, '00:00', loc.timezone).toISOString();
  const dayEnd = tz.zonedToUtc(tz.addDays(today, 1), '00:00', loc.timezone).toISOString();
  const attention = db.prepare("SELECT * FROM tasks WHERE location_id=? AND status='open' AND urgency IN ('urgent','high') ORDER BY CASE urgency WHEN 'urgent' THEN 0 ELSE 1 END, created_at DESC LIMIT 12").all(loc.id);
  const live = db.prepare("SELECT id,channel,intent,started_at,from_number,state_json FROM conversations WHERE location_id=? AND status='active' ORDER BY started_at DESC LIMIT 10").all(loc.id)
    .map((c) => { const st = parse(c.state_json, {}); return { id: c.id, channel: c.channel, intent: c.intent, started_at: c.started_at, name: st.patient && st.patient.first_name ? st.patient.first_name : null }; });
  const todays = db.prepare("SELECT id FROM appointments WHERE location_id=? AND start_utc>=? AND start_utc<? AND status IN ('booked','confirmed','completed') ORDER BY start_utc").all(loc.id, dayStart, dayEnd).map((a) => scheduling.getAppointment(a.id));
  const recent = db.prepare('SELECT id,channel,intent,outcome,summary,urgency,after_hours,started_at,status FROM conversations WHERE location_id=? ORDER BY started_at DESC LIMIT 8').all(loc.id);
  res.json({ kpi: analytics.summary(loc.id, 7), attention, live, today_appointments: todays, recent, open_tasks: db.prepare("SELECT COUNT(*) n FROM tasks WHERE location_id=? AND status='open'").get(loc.id).n, is_open: core.isOpenNow(loc) });
}));

// ---------------------------------------------------------------- conversations
router.get('/conversations', wrap((req, res) => {
  const { outcome, channel, q, urgency } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const where = ['location_id=?']; const args = [req.loc.id];
  if (outcome) { where.push('outcome=?'); args.push(outcome); }
  if (channel) { where.push('channel=?'); args.push(channel); }
  if (urgency) { where.push('urgency=?'); args.push(urgency); }
  if (q) { where.push('(summary LIKE ? OR intent LIKE ? OR from_number LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT id,channel,from_number,intent,outcome,summary,urgency,handoff,after_hours,new_patient,qa_score,status,started_at,ended_at,engine,feedback FROM conversations WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) n FROM conversations WHERE ${where.join(' AND ')}`).get(...args).n;
  res.json({ conversations: rows, total });
}));
router.get('/conversations/:id', wrap((req, res) => {
  const c = db.prepare('SELECT id FROM conversations WHERE id=? AND location_id=?').get(req.params.id, req.loc.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  audit(req, 'view_conversation', 'conversation', c.id);
  res.json(conversations.detail(c.id));
}));
router.post('/conversations/:id/feedback', wrap((req, res) => {
  const b = validate(z.object({ rating: z.enum(['up', 'down']), note: z.string().max(500).optional() }), req.body);
  if (!own(req, 'conversations', req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE conversations SET feedback=? WHERE id=?').run(j(b), req.params.id);
  res.json({ ok: true });
}));
router.post('/conversations/:id/end', wrap((req, res) => {
  if (!own(req, 'conversations', req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(conversations.finalize(req.params.id, 'staff_ended'));
}));
router.get('/export/conversations.csv', canManage, wrap((req, res) => {
  const rows = db.prepare('SELECT started_at,channel,intent,outcome,urgency,handoff,after_hours,qa_score,summary FROM conversations WHERE location_id=? ORDER BY started_at DESC LIMIT 5000').all(req.loc.id);
  audit(req, 'export_conversations', 'conversation', null, { rows: rows.length });
  const esc = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }; // neutralize CSV formula injection
  const head = 'started_at,channel,intent,outcome,urgency,handoff,after_hours,qa_score,summary';
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="conversations.csv"').send([head, ...rows.map((r) => Object.values(r).map(esc).join(','))].join('\n'));
}));

// ---------------------------------------------------------------- tasks
router.get('/tasks', wrap((req, res) => {
  const status = req.query.status || 'open';
  const rows = db.prepare(`SELECT t.*, p.first_name, p.last_name FROM tasks t LEFT JOIN patients p ON p.id=t.patient_id WHERE t.location_id=? ${status === 'all' ? '' : 'AND t.status=?'} ORDER BY CASE t.urgency WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, t.created_at DESC LIMIT 300`)
    .all(...(status === 'all' ? [req.loc.id] : [req.loc.id, status]));
  res.json({ tasks: rows.map((t) => ({ ...t, payload: parse(t.payload_json, null), patient_name: t.first_name ? `${t.first_name} ${t.last_name}` : null })) });
}));
router.post('/tasks', wrap((req, res) => {
  const b = validate(z.object({ title: z.string().min(2).max(200), kind: z.enum(['callback', 'message', 'review', 'other']).default('other'), urgency: z.enum(['normal', 'high', 'urgent']).default('normal') }), req.body);
  res.json({ id: comms.createTask({ tenantId: req.user.tenant_id, locationId: req.loc.id, kind: b.kind, title: b.title, urgency: b.urgency }) });
}));
router.patch('/tasks/:id', wrap((req, res) => {
  const b = validate(z.object({ status: z.enum(['open', 'in_progress', 'done', 'dismissed']).optional(), notes: z.string().max(1000).optional(), assignee_id: z.string().nullable().optional() }), req.body);
  const t = own(req, 'tasks', req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE tasks SET status=?, notes=?, assignee_id=?, resolved_at=? WHERE id=?').run(b.status || t.status, b.notes ?? t.notes, b.assignee_id === undefined ? t.assignee_id : b.assignee_id, ['done', 'dismissed'].includes(b.status) ? nowIso() : (b.status ? null : t.resolved_at), t.id);
  core.emit(req.user.tenant_id, 'task.updated', { id: t.id });
  res.json({ ok: true });
}));
router.post('/tasks/:id/run-eligibility', wrap((req, res) => {
  // Phase-2 hook: swap this deterministic mock for a dental clearinghouse eligibility (270/271) call
  const t = own(req, 'tasks', req.params.id);
  if (!t || t.kind !== 'verify_insurance' || !t.patient_id) return res.status(400).json({ error: 'Not an insurance verification task' });
  const pol = db.prepare('SELECT * FROM insurance_policies WHERE patient_id=? ORDER BY created_at DESC LIMIT 1').get(t.patient_id);
  const accepted = (req.loc.settings.accepted_insurance || []).some((n) => String(pol?.carrier || '').toLowerCase().includes(n.toLowerCase().split(' ')[0]));
  const result = { simulated: true, status: accepted ? 'active_in_network' : 'out_of_network_or_unknown', note: 'Simulated result. Connect a clearinghouse for real eligibility.' };
  if (pol) db.prepare('UPDATE insurance_policies SET status=?, verified_at=?, result_json=? WHERE id=?').run(accepted ? 'verified' : 'needs_review', nowIso(), j(result), pol.id);
  res.json(result);
}));

// ---------------------------------------------------------------- appointments & availability
router.get('/appointments', wrap((req, res) => {
  const from = req.query.from ? tz.zonedToUtc(req.query.from, '00:00', req.loc.timezone).toISOString() : new Date(clock.now().getTime() - 86400000).toISOString();
  const to = req.query.to ? tz.zonedToUtc(tz.addDays(req.query.to, 1), '00:00', req.loc.timezone).toISOString() : new Date(clock.now().getTime() + 30 * 86400000).toISOString();
  const rows = db.prepare('SELECT id FROM appointments WHERE location_id=? AND start_utc>=? AND start_utc<? ORDER BY start_utc LIMIT 500').all(req.loc.id, from, to);
  res.json({ appointments: rows.map((r) => scheduling.getAppointment(r.id)) });
}));
router.get('/availability', wrap((req, res) => {
  const type = scheduling.getType(String(req.query.type_id || ''));
  if (!type || type.location_id !== req.loc.id) return res.status(404).json({ error: 'Unknown appointment type' });
  let patient = { isNew: null, age: null };
  if (req.query.patient_id) { const p = patientsSvc.getPatient(req.query.patient_id); if (p && p.location_id === req.loc.id) patient = scheduling.patientCtx(p); }
  const r = scheduling.findSlots({ locationId: req.loc.id, typeId: type.id, patient, fromDate: req.query.from, toDate: req.query.to, limit: Math.min(parseInt(req.query.limit || '12', 10), 40), spread: false });
  res.json({ slots: r.slots, code: r.code || null, message: r.message || null });
}));
router.post('/appointments', wrap((req, res) => {
  const b = validate(z.object({ patient_id: z.string(), slot_id: z.string(), reason: z.string().max(200).optional() }), req.body);
  const p = patientsSvc.getPatient(b.patient_id);
  if (!p || p.location_id !== req.loc.id) return res.status(404).json({ error: 'Patient not found' });
  const r = scheduling.bookAppointment({ tenantId: req.user.tenant_id, locationId: req.loc.id, patientId: p.id, slotId: b.slot_id, source: 'staff', actor: req.user.email, reason: b.reason || null, skipPermission: true });
  audit(req, 'create_appointment', 'appointment', r.appointment.id);
  res.json(r);
}));
router.post('/appointments/:id/cancel', wrap((req, res) => {
  if (!own(req, 'appointments', req.params.id)) return res.status(404).json({ error: 'Not found' });
  const r = scheduling.cancelAppointment({ appointmentId: req.params.id, actor: req.user.email, reason: (req.body || {}).reason || 'Cancelled by staff' });
  audit(req, 'cancel_appointment', 'appointment', req.params.id);
  res.json(r);
}));
router.post('/appointments/:id/confirm', wrap((req, res) => { if (!own(req, 'appointments', req.params.id)) return res.status(404).json({ error: 'Not found' }); res.json(scheduling.confirmAppointment(req.params.id, req.user.email)); }));
router.post('/appointments/:id/outcome', wrap((req, res) => {
  const b = validate(z.object({ status: z.enum(['completed', 'no_show']) }), req.body);
  if (!own(req, 'appointments', req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(scheduling.setOutcome(req.params.id, b.status, req.user.email));
}));
router.post('/appointments/:id/reschedule', wrap((req, res) => {
  const b = validate(z.object({ slot_id: z.string() }), req.body);
  if (!own(req, 'appointments', req.params.id)) return res.status(404).json({ error: 'Not found' });
  res.json(scheduling.rescheduleAppointment({ appointmentId: req.params.id, newSlotId: b.slot_id, actor: req.user.email }));
}));

// ---------------------------------------------------------------- patients
const patientSchema = z.object({
  first_name: z.string().trim().min(1).max(60), last_name: z.string().trim().min(1).max(60), dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  phone: z.string().max(30).regex(/^[\d\s()+.-]*$/, 'Digits only').optional().or(z.literal('')), email: z.string().email().max(200).optional().or(z.literal('')),
});
router.get('/patients', wrap((req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let rows = db.prepare("SELECT * FROM patients WHERE location_id=? AND status='active' ORDER BY last_name, first_name LIMIT 1000").all(req.loc.id);
  if (q) rows = rows.filter((r) => `${r.first_name} ${r.last_name}`.toLowerCase().includes(q));
  res.json({ patients: rows.slice(0, 100).map((r) => patientsSvc.hydrate(r, { full: false })), total: rows.length });
}));
router.get('/patients/:id', wrap((req, res) => {
  const p = patientsSvc.getPatient(req.params.id);
  if (!p || p.location_id !== req.loc.id) return res.status(404).json({ error: 'Not found' });
  audit(req, 'view_patient', 'patient', p.id);
  const convs = db.prepare('SELECT id,channel,intent,outcome,summary,started_at FROM conversations WHERE patient_id=? ORDER BY started_at DESC LIMIT 20').all(p.id);
  res.json({ patient: p, appointments: scheduling.listForPatient(p.id, { upcoming: false }).slice(0, 30), conversations: convs, insurance: patientsSvc.listPolicies(p.id),
    consent: { transactional: patientsSvc.consentStatus(p.phone, 'transactional'), marketing: patientsSvc.consentStatus(p.phone, 'marketing') } });
}));
router.post('/patients', wrap((req, res) => {
  const b = validate(patientSchema, req.body);
  const p = patientsSvc.createPatient({ tenantId: req.user.tenant_id, locationId: req.loc.id, ...b, phone: b.phone || null, email: b.email || null });
  if (p.phone) patientsSvc.recordConsent({ tenantId: req.user.tenant_id, patientId: p.id, phone: p.phone, purpose: 'transactional', status: 'granted', source: 'staff_entry' });
  audit(req, 'create_patient', 'patient', p.id);
  res.json({ patient: p });
}));
router.patch('/patients/:id', wrap((req, res) => {
  const b = validate(patientSchema.partial().extend({ do_not_contact: z.boolean().optional() }), req.body);
  const p = patientsSvc.getPatient(req.params.id);
  if (!p || p.location_id !== req.loc.id) return res.status(404).json({ error: 'Not found' });
  audit(req, 'update_patient', 'patient', p.id);
  res.json({ patient: patientsSvc.updatePatient(p.id, b) });
}));
router.post('/patients/:id/consent', wrap((req, res) => {
  const b = validate(z.object({ purpose: z.enum(['transactional', 'marketing']), status: z.enum(['granted', 'revoked']), source: z.string().max(80).optional() }), req.body);
  const p = patientsSvc.getPatient(req.params.id);
  if (!p || p.location_id !== req.loc.id || !p.phone) return res.status(404).json({ error: 'Patient not found or no phone' });
  patientsSvc.recordConsent({ tenantId: req.user.tenant_id, patientId: p.id, phone: p.phone, purpose: b.purpose, status: b.status, source: b.source || `staff:${req.user.email}` });
  audit(req, 'consent_change', 'patient', p.id, b);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- providers & appointment types (rules)
const scheduleSchema = z.record(z.array(z.tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)])));
router.get('/providers', wrap((req, res) => res.json({ providers: scheduling.getProviders(req.loc.id, true) })));
router.post('/providers', canManage, wrap((req, res) => {
  const b = validate(z.object({ name: z.string().min(2).max(80), type: z.enum(['dentist', 'hygienist', 'specialist']), accepts_new: z.boolean().default(true), schedule: scheduleSchema }), req.body);
  const id = uid();
  db.prepare('INSERT INTO providers (id,location_id,name,type,accepts_new,schedule_json,active) VALUES (?,?,?,?,?,?,1)').run(id, req.loc.id, b.name, b.type, b.accepts_new ? 1 : 0, j(b.schedule));
  audit(req, 'create_provider', 'provider', id);
  res.json({ provider: scheduling.getProvider(id) });
}));
router.patch('/providers/:id', canManage, wrap((req, res) => {
  const b = validate(z.object({ name: z.string().min(2).max(80).optional(), accepts_new: z.boolean().optional(), active: z.boolean().optional(), schedule: scheduleSchema.optional() }), req.body);
  const p = own(req, 'providers', req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE providers SET name=?, accepts_new=?, active=?, schedule_json=? WHERE id=?').run(b.name ?? p.name, b.accepts_new === undefined ? p.accepts_new : (b.accepts_new ? 1 : 0), b.active === undefined ? p.active : (b.active ? 1 : 0), b.schedule ? j(b.schedule) : p.schedule_json, p.id);
  audit(req, 'update_provider', 'provider', p.id);
  res.json({ provider: scheduling.getProvider(p.id) });
}));
const typeSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_]{2,30}$/, 'Use capital letters, numbers and underscores').optional(), name: z.string().min(2).max(80), duration_min: z.number().int().min(5).max(480), buffer_min: z.number().int().min(0).max(120).default(0),
  allowed_provider_types: z.array(z.string()).default(['dentist']), new_patient_only: z.boolean().default(false), existing_only: z.boolean().default(false),
  min_age: z.number().int().min(0).max(120).nullable().optional(), max_age: z.number().int().min(0).max(120).nullable().optional(), lead_time_min: z.number().int().min(0).max(100000).default(60),
  max_horizon_days: z.number().int().min(1).max(365).default(90), is_emergency: z.boolean().default(false),
  agent_permissions: z.object({ book: z.boolean(), reschedule: z.boolean(), cancel: z.boolean() }).default({ book: true, reschedule: true, cancel: true }),
  value_estimate: z.number().min(0).max(100000).default(0), keywords: z.array(z.string().max(40)).max(30).default([]), active: z.boolean().default(true),
});
router.get('/appointment-types', wrap((req, res) => res.json({ types: scheduling.getTypes(req.loc.id, true) })));
router.post('/appointment-types', canManage, wrap((req, res) => {
  const b = validate(typeSchema.required({ code: true }), req.body);
  if (scheduling.getTypeByCode(req.loc.id, b.code)) return res.status(409).json({ error: 'That code already exists.' });
  const id = uid();
  db.prepare(`INSERT INTO appointment_types (id,location_id,code,name,duration_min,buffer_min,allowed_provider_types,new_patient_only,existing_only,min_age,max_age,lead_time_min,max_horizon_days,is_emergency,agent_permissions,value_estimate,keywords,active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, req.loc.id, b.code, b.name, b.duration_min, b.buffer_min, j(b.allowed_provider_types), b.new_patient_only ? 1 : 0, b.existing_only ? 1 : 0, b.min_age ?? null, b.max_age ?? null, b.lead_time_min, b.max_horizon_days, b.is_emergency ? 1 : 0, j(b.agent_permissions), b.value_estimate, j(b.keywords), b.active ? 1 : 0);
  audit(req, 'create_appointment_type', 'appointment_type', id);
  res.json({ type: scheduling.getType(id) });
}));
router.patch('/appointment-types/:id', canManage, wrap((req, res) => {
  const b = validate(typeSchema.partial(), req.body);
  const t = own(req, 'appointment_types', req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const cur = scheduling.getType(t.id);
  const m = { ...cur, ...b };
  db.prepare(`UPDATE appointment_types SET name=?,duration_min=?,buffer_min=?,allowed_provider_types=?,new_patient_only=?,existing_only=?,min_age=?,max_age=?,lead_time_min=?,max_horizon_days=?,is_emergency=?,agent_permissions=?,value_estimate=?,keywords=?,active=? WHERE id=?`)
    .run(m.name, m.duration_min, m.buffer_min, j(m.allowed_provider_types), m.new_patient_only ? 1 : 0, m.existing_only ? 1 : 0, m.min_age ?? null, m.max_age ?? null, m.lead_time_min, m.max_horizon_days, m.is_emergency ? 1 : 0, j(m.agent_permissions), m.value_estimate, j(m.keywords), m.active ? 1 : 0, t.id);
  audit(req, 'update_appointment_type', 'appointment_type', t.id);
  res.json({ type: scheduling.getType(t.id) });
}));

// ---------------------------------------------------------------- settings (versioned)
const hoursSchema = z.record(z.array(z.string().regex(/^\d{2}:\d{2}$/)).length(2).nullable());
router.get('/settings', wrap((req, res) => res.json({ location: { id: req.loc.id, name: req.loc.name, address: req.loc.address, phone: req.loc.phone, timezone: req.loc.timezone, hours: req.loc.hours, settings: req.loc.settings, widget_key: req.loc.widget_key } })));
router.patch('/settings', canManage, wrap((req, res) => {
  const b = validate(z.object({
    name: z.string().min(2).max(120).optional(), address: z.string().max(250).optional(), phone: z.string().max(30).optional(), timezone: z.string().max(60).optional(), hours: hoursSchema.optional(),
    settings: z.object({
      agent_name: z.string().min(1).max(30), greeting: z.string().max(400), recording_disclosure: z.boolean(), routing_mode: z.enum(['always', 'after_hours', 'overflow']), overflow_ring_seconds: z.number().int().min(5).max(60),
      transfer_number: z.string().max(30), transfer_only_in_hours: z.boolean(), accepted_insurance: z.array(z.string().max(60)).max(80), cancellation_policy: z.string().max(500),
      new_patient_daily_cap: z.number().int().min(0).max(50), emergency_reserve_minutes: z.number().int().min(0).max(240), reminder_cadence_hours: z.array(z.number().int().min(1).max(336)).max(6),
      waitlist_mode: z.enum(['batch', 'sequential']), offer_ttl_min: z.number().int().min(1).max(240), notify_phones: z.array(z.string().max(30)).max(10), notify_emails: z.array(z.string().email()).max(10),
      blockouts: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), provider_id: z.string().optional(), start: z.string().optional(), end: z.string().optional() })).max(200),
      emergency_policy: z.object({ on_call_number: z.string().max(30), script_life: z.string().max(600), script_urgent: z.string().max(600) }).partial(), spend_cap_usd: z.number().min(0).max(1000000),
    }).partial().optional(),
  }), req.body);
  if (b.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch (_) { return res.status(400).json({ error: 'Unknown time zone' }); } }
  const snapshotNeeded = true;
  const loc = core.saveSettings(req.loc.id, b.settings || {}, req.user.email);
  if (snapshotNeeded) db.prepare('UPDATE locations SET name=?, address=?, phone=?, timezone=?, hours_json=? WHERE id=?').run(b.name ?? loc.name, b.address ?? loc.address, b.phone ?? loc.phone, b.timezone ?? loc.timezone, b.hours ? j(b.hours) : loc.hours_json, loc.id);
  audit(req, 'update_settings', 'location', loc.id, Object.keys(b));
  res.json({ ok: true });
}));
router.get('/settings/versions', canManage, wrap((req, res) => res.json({ versions: db.prepare('SELECT id,author,ts FROM settings_versions WHERE location_id=? ORDER BY ts DESC LIMIT 30').all(req.loc.id) })));
router.post('/settings/versions/:id/rollback', canManage, wrap((req, res) => {
  const v = db.prepare('SELECT * FROM settings_versions WHERE id=? AND location_id=?').get(req.params.id, req.loc.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const snap = parse(v.snapshot_json, {});
  core.saveSettings(req.loc.id, snap.settings || {}, `${req.user.email} (rollback)`);
  db.prepare('UPDATE locations SET name=?, address=?, phone=?, timezone=?, hours_json=? WHERE id=?').run(snap.name, snap.address, snap.phone, snap.timezone, j(snap.hours), req.loc.id);
  audit(req, 'rollback_settings', 'location', req.loc.id, { version: v.id });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- knowledge base
router.get('/knowledge', wrap((req, res) => {
  const docs = db.prepare('SELECT id,title,source_type,source_url,version,active,created_at,substr(content,1,240) AS preview, length(content) AS size FROM knowledge_docs WHERE location_id=? ORDER BY created_at DESC').all(req.loc.id);
  res.json({ docs });
}));
router.get('/knowledge/:id', wrap((req, res) => { const d = own(req, 'knowledge_docs', req.params.id); if (!d) return res.status(404).json({ error: 'Not found' }); res.json({ doc: d }); }));
router.post('/knowledge', wrap((req, res) => {
  const b = validate(z.object({ title: z.string().min(2).max(200), content: z.string().min(2).max(40000), type: z.enum(['text', 'canonical']).default('text') }), req.body);
  const id = knowledge.addDoc({ tenantId: req.user.tenant_id, locationId: req.loc.id, title: b.title, content: b.content, source_type: b.type });
  audit(req, 'create_knowledge', 'knowledge_doc', id);
  res.json({ id });
}));
router.patch('/knowledge/:id', wrap((req, res) => {
  const b = validate(z.object({ title: z.string().min(2).max(200).optional(), content: z.string().min(2).max(40000).optional(), active: z.boolean().optional() }), req.body);
  if (!own(req, 'knowledge_docs', req.params.id)) return res.status(404).json({ error: 'Not found' });
  knowledge.updateDoc(req.params.id, b);
  audit(req, 'update_knowledge', 'knowledge_doc', req.params.id);
  res.json({ ok: true });
}));
router.delete('/knowledge/:id', wrap((req, res) => { if (!own(req, 'knowledge_docs', req.params.id)) return res.status(404).json({ error: 'Not found' }); knowledge.deleteDoc(req.params.id); audit(req, 'delete_knowledge', 'knowledge_doc', req.params.id); res.json({ ok: true }); }));
router.post('/knowledge/crawl', canManage, wrap(async (req, res) => {
  const b = validate(z.object({ url: z.string().url().max(500) }), req.body);
  try { const id = await knowledge.crawl({ tenantId: req.user.tenant_id, locationId: req.loc.id, url: b.url }); audit(req, 'crawl_website', 'knowledge_doc', id, { url: b.url }); res.json({ id }); }
  catch (e) { res.status(400).json({ error: `Could not import that page: ${e.message}` }); }
}));
router.post('/knowledge/test', wrap((req, res) => {
  const b = validate(z.object({ question: z.string().min(2).max(300) }), req.body);
  const r = knowledge.answer(req.loc, b.question);
  res.json({ answer: r.text, source: r.source, confidence: r.confidence });
}));
router.get('/unanswered', wrap((req, res) => res.json({ questions: db.prepare('SELECT * FROM unanswered_questions WHERE location_id=? AND resolved=0 ORDER BY ts DESC LIMIT 100').all(req.loc.id) })));
router.post('/unanswered/:id/resolve', wrap((req, res) => { db.prepare('UPDATE unanswered_questions SET resolved=1 WHERE id=? AND location_id=?').run(req.params.id, req.loc.id); res.json({ ok: true }); }));

// ---------------------------------------------------------------- waitlist, offers, campaigns
router.get('/waitlist', wrap((req, res) => res.json({ entries: waitlist.list(req.loc.id), offers: waitlist.listOffers(req.loc.id) })));
router.post('/waitlist', wrap((req, res) => {
  const b = validate(z.object({ patient_id: z.string(), type_id: z.string(), days: z.array(z.number().int().min(0).max(6)).default([]), tod: z.enum(['morning', 'afternoon', 'evening']).nullable().optional() }), req.body);
  const p = patientsSvc.getPatient(b.patient_id); const t = scheduling.getType(b.type_id);
  if (!p || p.location_id !== req.loc.id || !t || t.location_id !== req.loc.id) return res.status(404).json({ error: 'Not found' });
  res.json({ id: waitlist.add({ tenantId: req.user.tenant_id, locationId: req.loc.id, patientId: p.id, typeId: t.id, prefs: { days: b.days, tod: b.tod || null } }) });
}));
router.delete('/waitlist/:id', wrap((req, res) => { waitlist.remove(req.params.id); res.json({ ok: true }); }));
router.get('/campaigns', wrap((req, res) => res.json({ campaigns: campaigns.list(req.loc.id) })));
router.post('/campaigns/recall', canManage, wrap((req, res) => {
  const r = campaigns.createRecall({ tenantId: req.user.tenant_id, locationId: req.loc.id, name: (req.body || {}).name || `Recall ${tz.local(clock.now(), req.loc.timezone).date}` });
  audit(req, 'create_campaign', 'campaign', r.id, r);
  res.json(r);
}));

// ---------------------------------------------------------------- analytics, outbox, audit, billing, integrations
router.get('/analytics/summary', wrap((req, res) => res.json(analytics.summary(req.loc.id, Math.min(parseInt(req.query.days || '30', 10), 365)))));
router.get('/outbox', wrap((req, res) => res.json({ messages: db.prepare('SELECT id,channel,to_addr,body,kind,status,provider,error,created_at FROM outbox WHERE location_id=? ORDER BY created_at DESC LIMIT 100').all(req.loc.id).map((m) => ({ ...m, to_addr: m.to_addr && m.channel === 'sms' ? m.to_addr.slice(0, -4).replace(/\d/g, '*') + m.to_addr.slice(-4) : m.to_addr })) })));
router.get('/audit', canManage, wrap((req, res) => res.json({ logs: db.prepare('SELECT * FROM audit_logs WHERE tenant_id=? ORDER BY ts DESC, rowid DESC LIMIT ?').all(req.user.tenant_id, Math.min(parseInt(req.query.limit || '100', 10), 500)) })));
router.get('/billing/usage', wrap((req, res) => {
  const tenant = db.prepare('SELECT plan FROM tenants WHERE id=?').get(req.user.tenant_id);
  const since = new Date(clock.now().getTime() - 30 * 86400000).toISOString();
  const rows = db.prepare('SELECT kind, SUM(quantity) q, SUM(quantity*unit_cost) cost FROM usage_events WHERE tenant_id=? AND ts>=? GROUP BY kind').all(req.user.tenant_id, since);
  const total = rows.reduce((s, r) => s + r.cost, 0);
  const plans = { starter: 249, growth: 599, pro: 899 };
  res.json({ plan: tenant.plan, plan_price_usd: plans[tenant.plan] || 0, usage: rows.map((r) => ({ kind: r.kind, quantity: Math.round(r.q * 100) / 100, cost_usd: Math.round(r.cost * 100) / 100 })), variable_cost_usd: Math.round(total * 100) / 100, spend_cap_usd: req.loc.settings.spend_cap_usd, stripe_configured: !!cfg.stripe.key });
}));
router.post('/billing/checkout', sec.requireRole('owner'), wrap(async (req, res) => {
  if (!cfg.stripe.key || !cfg.stripe.price) return res.status(501).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID in .env.' });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${cfg.stripe.key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ mode: 'subscription', 'line_items[0][price]': cfg.stripe.price, 'line_items[0][quantity]': '1', success_url: `${cfg.baseUrl}/app#/billing`, cancel_url: `${cfg.baseUrl}/app#/billing`, client_reference_id: req.user.tenant_id }) });
  const data = await r.json();
  if (!r.ok) return res.status(502).json({ error: data.error?.message || 'Stripe error' });
  res.json({ url: data.url });
}));
router.get('/integrations', wrap((req, res) => {
  const rows = db.prepare('SELECT id,pms_type,status,last_sync_at FROM integrations WHERE location_id=?').all(req.loc.id);
  res.json({ active: rows.find((r) => r.status === 'connected')?.pms_type || 'native', integrations: rows });
}));
router.post('/integrations', sec.requireRole('owner'), wrap(async (req, res) => {
  const b = validate(z.object({ pms_type: z.enum(['native', 'opendental']), baseUrl: z.string().url().optional(), developerKey: z.string().max(200).optional(), customerKey: z.string().max(200).optional() }), req.body);
  db.prepare("UPDATE integrations SET status='disabled' WHERE location_id=?").run(req.loc.id);
  if (b.pms_type !== 'native') db.prepare('INSERT INTO integrations (id,location_id,pms_type,config_enc,status,last_sync_at) VALUES (?,?,?,?,?,?)').run(uid(), req.loc.id, b.pms_type, encrypt(j({ baseUrl: b.baseUrl, developerKey: b.developerKey, customerKey: b.customerKey })), 'connected', null);
  audit(req, 'change_integration', 'location', req.loc.id, { pms_type: b.pms_type });
  res.json({ ok: true, test: await getAdapter(req.loc.id).testConnection() });
}));
router.post('/integrations/test', wrap(async (req, res) => res.json(await getAdapter(req.loc.id).testConnection())));

// ---------------------------------------------------------------- users (owner)
router.get('/users', sec.requireRole('owner', 'manager'), wrap((req, res) => res.json({ users: db.prepare('SELECT id,email,name,role,mfa_enabled,last_login FROM users WHERE tenant_id=? ORDER BY created_at').all(req.user.tenant_id) })));
router.post('/users', sec.requireRole('owner'), wrap((req, res) => {
  const b = validate(z.object({ email: z.string().email().max(200), name: z.string().min(2).max(80), role: z.enum(['manager', 'staff', 'readonly']), password: z.string().min(10).max(200).regex(/[A-Za-z]/).regex(/\d/) }), req.body);
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(b.email.toLowerCase())) return res.status(409).json({ error: 'That email is already in use.' });
  const id = uid();
  db.prepare('INSERT INTO users (id,tenant_id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?,?)').run(id, req.user.tenant_id, b.email.toLowerCase(), b.name, bcrypt.hashSync(b.password, 12), b.role, nowIso());
  audit(req, 'create_user', 'user', id, { role: b.role });
  res.json({ id });
}));
router.delete('/users/:id', sec.requireRole('owner'), wrap((req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  db.prepare('DELETE FROM users WHERE id=? AND tenant_id=?').run(req.params.id, req.user.tenant_id);
  audit(req, 'delete_user', 'user', req.params.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- simulator ("test call") and live stream
router.post('/simulate/start', wrap((req, res) => {
  const b = validate(z.object({ channel: z.enum(['voice', 'chat']).default('chat'), from: z.string().max(30).optional(), closed: z.boolean().optional() }), req.body);
  const r = conversations.start({ locationId: req.loc.id, channel: b.channel, externalId: `sim:${uid()}`, from: b.from || (b.channel === 'voice' ? '+15125550199' : null) });
  res.json({ conversation_id: r.conversation.id, greeting: r.greeting });
}));
router.post('/simulate/turn', wrap(async (req, res) => {
  const b = validate(z.object({ conversation_id: z.string(), text: z.string().min(1).max(1000) }), req.body);
  if (!own(req, 'conversations', b.conversation_id)) return res.status(404).json({ error: 'Not found' });
  res.json(await conversations.turn({ conversationId: b.conversation_id, text: b.text }));
}));
router.post('/simulate/sms', wrap(async (req, res) => {
  const b = validate(z.object({ from: z.string().min(7).max(30), body: z.string().min(1).max(500) }), req.body);
  const r = await inbound.handleSms({ locationId: req.loc.id, from: b.from, body: b.body });
  res.json(r);
}));
router.post('/simulate/advance-clock', canManage, wrap((req, res) => {
  if (cfg.isProd) return res.status(403).json({ error: 'Disabled in production' });
  const hours = Math.min(Math.max(parseFloat((req.body || {}).hours) || 0, 0), 24 * 14);
  clock.shiftMs(hours * 3600000);
  const sent = require('../services/reminders').runDue();
  res.json({ ok: true, now: clock.iso(), reminders_sent: sent });
}));

router.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 4000\n\n');
  const handler = (ev) => { if (ev.tenantId === req.user.tenant_id) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`); };
  core.bus.on('event', handler);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); core.bus.off('event', handler); });
});

module.exports = router;
