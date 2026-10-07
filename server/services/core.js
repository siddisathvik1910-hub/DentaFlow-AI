// Core small services: event bus (SSE), audit log, usage metering, location/settings helpers.
const EventEmitter = require('events');
const { db, uid, nowIso, j, parse } = require('../db');
const tz = require('../tz');
const clock = require('../clock');

// ---------- Event bus (powers live dashboard via Server-Sent Events) ----------
const bus = new EventEmitter();
bus.setMaxListeners(200);
function emit(tenantId, type, data = {}) { bus.emit('event', { tenantId, type, data, ts: nowIso() }); }

// ---------- Audit log (append-only) ----------
function audit({ tenantId, actor, action, resource, resourceId, ip, detail }) {
  db.prepare('INSERT INTO audit_logs (id,tenant_id,actor,action,resource,resource_id,ip,detail,ts) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(uid(), tenantId || null, actor || 'system', action, resource || null, resourceId || null, ip || null, detail ? (typeof detail === 'string' ? detail : j(detail)) : null, nowIso());
}

// ---------- Usage metering (voice minutes, SMS, LLM tokens...) ----------
const UNIT_COST = { voice_min: 0.06, sms: 0.008, llm_turn: 0.004, llm_token_k: 0.01 };
function recordUsage(tenantId, conversationId, kind, quantity) {
  db.prepare('INSERT INTO usage_events (id,tenant_id,conversation_id,kind,quantity,unit_cost,ts) VALUES (?,?,?,?,?,?,?)')
    .run(uid(), tenantId, conversationId || null, kind, quantity, UNIT_COST[kind] ?? 0, nowIso());
}

// ---------- Locations & settings ----------
const DEFAULT_HOURS = {
  mon: ['08:00', '17:00'], tue: ['08:00', '17:00'], wed: ['08:00', '17:00'], thu: ['08:00', '17:00'], fri: ['08:00', '13:00'], sat: null, sun: null,
};
const DEFAULT_SETTINGS = {
  agent_name: 'Ava',
  greeting: '',
  recording_disclosure: true,
  language: 'en',
  voice: 'alloy-warm',
  routing_mode: 'always', // always | after_hours | overflow
  overflow_ring_seconds: 15,
  transfer_number: '',
  transfer_only_in_hours: true,
  emergency_policy: {
    on_call_number: '',
    script_life: 'This could be a medical emergency. Please hang up and call 911 or go to the nearest emergency room right now. I have alerted our team and someone will follow up with you. Please stay safe.',
    script_urgent: "I'm sorry you're dealing with that. I can't give medical advice, but I can get you in with the doctor as soon as possible.",
  },
  accepted_insurance: ['Delta Dental', 'Cigna', 'Aetna', 'MetLife', 'Guardian', 'United Healthcare', 'Humana'],
  cancellation_policy: 'Cancellations within 24 hours may incur a fee, and our team will follow up if that applies.',
  new_patient_daily_cap: 4,
  emergency_reserve_minutes: 30,
  emergency_reserve_release: '12:00',
  slot_step_min: 15,
  reminder_cadence_hours: [72, 24, 2],
  waitlist_mode: 'batch', // batch | sequential
  offer_ttl_min: 15,
  blockouts: [], // [{provider_id?, date:'YYYY-MM-DD', start?, end?}]
  notify_phones: [],
  notify_emails: [],
  spend_cap_usd: 500,
  staff_values: {},
};

function hydrateLocation(row) {
  if (!row) return null;
  const settings = { ...DEFAULT_SETTINGS, ...parse(row.settings_json, {}) };
  settings.emergency_policy = { ...DEFAULT_SETTINGS.emergency_policy, ...(settings.emergency_policy || {}) };
  return { ...row, hours: parse(row.hours_json, DEFAULT_HOURS), settings };
}
const getLocation = (id) => hydrateLocation(db.prepare('SELECT * FROM locations WHERE id=?').get(id));
const getLocationByWidgetKey = (k) => hydrateLocation(db.prepare('SELECT * FROM locations WHERE widget_key=?').get(k));
const listLocations = (tenantId) => db.prepare('SELECT * FROM locations WHERE tenant_id=? ORDER BY created_at').all(tenantId).map(hydrateLocation);

function saveSettings(locationId, patch, author) {
  const loc = getLocation(locationId);
  const merged = { ...loc.settings, ...patch };
  if (patch.emergency_policy) merged.emergency_policy = { ...loc.settings.emergency_policy, ...patch.emergency_policy };
  db.prepare('INSERT INTO settings_versions (id,location_id,snapshot_json,author,ts) VALUES (?,?,?,?,?)')
    .run(uid(), locationId, j({ settings: loc.settings, hours: loc.hours, name: loc.name, address: loc.address, phone: loc.phone, timezone: loc.timezone }), author || 'system', nowIso());
  db.prepare('UPDATE locations SET settings_json=? WHERE id=?').run(j(merged), locationId);
  return getLocation(locationId);
}

function isOpenNow(loc, at = clock.now()) {
  const l = tz.local(at, loc.timezone);
  const h = loc.hours[l.wd];
  if (!h) return false;
  return l.minutes >= tz.toMin(h[0]) && l.minutes < tz.toMin(h[1]);
}

function hoursSpoken(loc) {
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const names = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const groups = [];
  for (const d of order) {
    const h = loc.hours[d];
    const key = h ? `${tz.fmtTime12(h[0])} to ${tz.fmtTime12(h[1])}` : 'closed';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.days.push(d); else groups.push({ key, days: [d] });
  }
  return groups.map((g) => {
    const first = names[g.days[0]]; const lastD = names[g.days[g.days.length - 1]];
    const label = g.days.length === 1 ? first : g.days.length === 2 ? `${first} and ${lastD}` : `${first} through ${lastD}`;
    return g.key === 'closed' ? `${label}: closed` : `${label}: ${g.key}`;
  }).join('; ');
}

function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/[^\d]/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return digits ? '+' + digits : '';
}

// Mask obvious PHI patterns for analytics / log copies of transcripts
function redact(text) {
  return String(text || '')
    .replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, '[DATE]')
    .replace(/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/g, '[DATE]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[PHONE]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]')
    .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:19|20)\d{2}\b/gi, '[DOB]');
}

module.exports = {
  bus, emit, audit, recordUsage, UNIT_COST,
  DEFAULT_HOURS, DEFAULT_SETTINGS, getLocation, getLocationByWidgetKey, listLocations, saveSettings, isOpenNow, hoursSpoken, normalizePhone, redact,
};
