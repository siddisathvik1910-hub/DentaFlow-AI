// KPI computation for the ROI dashboard. Revenue values are estimates based on clinic-configured value per appointment type.
const { db } = require('../db');
const clock = require('../clock');
const tz = require('../tz');
const core = require('./core');

function summary(locationId, days = 30) {
  const loc = core.getLocation(locationId);
  const to = clock.now();
  const from = new Date(to.getTime() - days * 86400000);
  const f = from.toISOString(), t = to.toISOString();
  const conv = db.prepare('SELECT * FROM conversations WHERE location_id=? AND started_at>=? AND started_at<=?').all(locationId, f, t);
  const voice = conv.filter((c) => c.channel === 'voice');
  const booked = db.prepare(`SELECT a.*, t.value_estimate, t.new_patient_only FROM appointments a JOIN appointment_types t ON t.id=a.type_id
    WHERE a.location_id=? AND a.created_at>=? AND a.created_at<=? AND a.source IN ('agent','waitlist') AND a.status IN ('booked','confirmed','completed','cancelled','no_show')`).all(locationId, f, t);
  const activeBooked = booked.filter((a) => ['booked', 'confirmed', 'completed'].includes(a.status));
  const production = activeBooked.reduce((s, a) => s + (a.value_estimate || 0), 0);
  const newPatientConv = conv.filter((c) => c.new_patient);
  const newPatientBooked = newPatientConv.filter((c) => c.outcome === 'booked');
  const handoffs = conv.filter((c) => c.handoff);
  const finished = db.prepare(`SELECT status, COUNT(*) n FROM appointments WHERE location_id=? AND start_utc>=? AND start_utc<=? AND status IN ('completed','no_show') GROUP BY status`).all(locationId, f, t);
  const fin = Object.fromEntries(finished.map((r) => [r.status, r.n]));
  const noShowRate = (fin.completed || 0) + (fin.no_show || 0) ? (fin.no_show || 0) / ((fin.completed || 0) + (fin.no_show || 0)) : null;
  const backfill = db.prepare("SELECT COUNT(*) n FROM appointments WHERE location_id=? AND source='waitlist' AND created_at>=? AND status IN ('booked','confirmed','completed')").get(locationId, f).n;
  const cancelled = db.prepare("SELECT COUNT(*) n FROM appointments WHERE location_id=? AND status='cancelled' AND created_at>=?").get(locationId, f).n;
  const minutes = conv.reduce((s, c) => s + Math.max(0.5, (new Date(c.last_activity) - new Date(c.started_at)) / 60000), 0);
  const emergencies = db.prepare("SELECT COUNT(*) n FROM triage_events WHERE tenant_id=? AND ts>=?").get(loc.tenant_id, f).n;

  // daily series in clinic-local time
  const series = {};
  for (let i = days - 1; i >= 0; i--) { const d = tz.local(new Date(to.getTime() - i * 86400000), loc.timezone).date; series[d] = { date: d, conversations: 0, bookings: 0 }; }
  for (const c of conv) { const d = tz.local(new Date(c.started_at), loc.timezone).date; if (series[d]) series[d].conversations++; }
  for (const a of activeBooked) { const d = tz.local(new Date(a.created_at), loc.timezone).date; if (series[d]) series[d].bookings++; }
  const hours = Array.from({ length: 24 }, () => 0);
  for (const c of conv) hours[Math.floor(tz.local(new Date(c.started_at), loc.timezone).minutes / 60)]++;
  const count = (key) => { const m = {}; for (const c of conv) { const k = c[key] || 'unknown'; m[k] = (m[k] || 0) + 1; } return m; };

  return {
    range_days: days,
    conversations: conv.length,
    calls_answered: voice.length,
    after_hours_captured: conv.filter((c) => c.after_hours).length,
    appointments_booked: activeBooked.length,
    estimated_production: Math.round(production),
    new_patient_conversion: newPatientConv.length ? newPatientBooked.length / newPatientConv.length : null,
    new_patient_bookings: newPatientBooked.length,
    handoff_rate: conv.length ? handoffs.length / conv.length : 0,
    no_show_rate: noShowRate,
    slots_recovered: backfill,
    cancellations: cancelled,
    emergencies,
    staff_hours_saved: Math.round((minutes * 1.4 / 60) * 10) / 10,
    containment_rate: conv.length ? 1 - handoffs.length / conv.length : null,
    outcomes: count('outcome'),
    intents: count('intent'),
    channels: count('channel'),
    daily: Object.values(series),
    hourly: hours,
    note: 'Revenue figures are estimates based on the value per appointment type configured in Settings.',
  };
}

module.exports = { summary };
