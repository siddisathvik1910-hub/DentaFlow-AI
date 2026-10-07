// Reminder and confirmation pipeline (idempotent: UNIQUE(appointment_id, step_hours)).
const { db, uid, nowIso, j } = require('../db');
const clock = require('../clock');
const tz = require('../tz');
const core = require('./core');
const patients = require('./patients');
const comms = require('./comms');

function scheduleForAppointment(appointmentId) {
  const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(appointmentId);
  if (!a) return;
  const loc = core.getLocation(a.location_id);
  const start = new Date(a.start_utc).getTime();
  const now = clock.now().getTime();
  const ins = db.prepare('INSERT OR IGNORE INTO reminder_schedules (id,appointment_id,step_hours,send_at,status) VALUES (?,?,?,?,?)');
  for (const h of loc.settings.reminder_cadence_hours || [72, 24, 2]) {
    const sendAt = start - h * 3600000;
    if (sendAt <= now) continue;
    ins.run(uid(), appointmentId, h, new Date(sendAt).toISOString(), 'pending');
  }
}

function nextMorning(loc, from) {
  const l = tz.local(from, loc.timezone);
  const date = l.minutes >= 8 * 60 ? tz.addDays(l.date, 1) : l.date;
  return tz.zonedToUtc(date, '08:00', loc.timezone);
}

function runDue(now = clock.now()) {
  const due = db.prepare("SELECT * FROM reminder_schedules WHERE status='pending' AND send_at<=? ORDER BY send_at LIMIT 200").all(now.toISOString());
  let sent = 0;
  for (const r of due) {
    const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(r.appointment_id);
    const setStatus = (s) => db.prepare('UPDATE reminder_schedules SET status=?, sent_at=? WHERE id=?').run(s, nowIso(), r.id);
    if (!a || !['booked', 'confirmed'].includes(a.status) || new Date(a.start_utc) <= now) { setStatus('skipped'); continue; }
    const p = patients.getPatient(a.patient_id);
    if (!p || !p.phone || p.do_not_contact) { setStatus('skipped'); continue; }
    const loc = core.getLocation(a.location_id);
    if (comms.inQuietHours(loc, now)) {
      const next = nextMorning(loc, now);
      if (next.getTime() < new Date(a.start_utc).getTime() - 30 * 60000) { db.prepare('UPDATE reminder_schedules SET send_at=? WHERE id=?').run(next.toISOString(), r.id); }
      else setStatus('skipped');
      continue;
    }
    const type = db.prepare('SELECT name FROM appointment_types WHERE id=?').get(a.type_id);
    const when = tz.speak(new Date(a.start_utc), loc.timezone, now);
    const body = a.confirmation_status === 'confirmed'
      ? `Reminder from ${loc.name}: your ${type.name} is ${when}. See you then!`
      : `Reminder from ${loc.name}: your ${type.name} is ${when}. Reply C to confirm, R to reschedule, or X to cancel.`;
    const res = comms.send({ tenantId: a.tenant_id, locationId: a.location_id, patientId: p.id, to: p.phone, body, kind: 'reminder' });
    setStatus(res.status === 'blocked_no_consent' ? 'skipped' : 'sent');
    if (res.status !== 'blocked_no_consent') sent++;
  }
  return sent;
}

// Appointments within 24h that are still unconfirmed get a "call to confirm" task for staff
function flagUnconfirmed(now = clock.now()) {
  const rows = db.prepare(`SELECT * FROM appointments WHERE status='booked' AND confirmation_status='unconfirmed' AND start_utc>? AND start_utc<?`)
    .all(now.toISOString(), new Date(now.getTime() + 24 * 3600000).toISOString());
  for (const a of rows) {
    const marker = `"appointment_id":"${a.id}"`;
    if (db.prepare("SELECT 1 FROM tasks WHERE kind='confirm_call' AND payload_json LIKE ?").get(`%${marker}%`)) continue;
    const loc = core.getLocation(a.location_id);
    const p = patients.getPatient(a.patient_id);
    comms.createTask({ tenantId: a.tenant_id, locationId: a.location_id, kind: 'confirm_call', title: `Call to confirm: ${p.first_name} ${p.last_name}, ${tz.speak(new Date(a.start_utc), loc.timezone, now)}`, patientId: p.id, payload: { appointment_id: a.id } });
  }
}

module.exports = { scheduleForAppointment, runDue, flagUnconfirmed };
