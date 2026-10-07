// Recall / reactivation campaigns. Marketing messages require explicit marketing consent and respect quiet hours.
const { db, uid, nowIso, j, parse } = require('../db');
const clock = require('../clock');
const tz = require('../tz');
const core = require('./core');
const patients = require('./patients');
const comms = require('./comms');

function createRecall({ tenantId, locationId, name = 'Recall: overdue hygiene' }) {
  const loc = core.getLocation(locationId);
  const today = tz.local(clock.now(), loc.timezone).date;
  const id = uid();
  db.prepare('INSERT INTO campaigns (id,tenant_id,location_id,name,type,filters_json,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, tenantId, locationId, name, 'recall', j({ recall_due_on_or_before: today }), 'running', nowIso());
  const rows = db.prepare("SELECT * FROM patients WHERE location_id=? AND status='active' AND recall_due IS NOT NULL AND recall_due<=?").all(locationId, today);
  const ins = db.prepare('INSERT INTO campaign_members (id,campaign_id,patient_id,status,reason,contacted_at) VALUES (?,?,?,?,?,?)');
  const counts = { eligible: rows.length, queued: 0, skipped: 0 };
  for (const r of rows) {
    const p = patients.hydrate(r);
    let reason = null;
    if (p.do_not_contact) reason = 'do_not_contact';
    else if (!p.phone) reason = 'no_phone';
    else if (patients.consentStatus(p.phone, 'marketing') !== 'granted' || patients.consentStatus(p.phone, 'all') === 'revoked') reason = 'no_marketing_consent';
    else if (db.prepare("SELECT 1 FROM appointments WHERE patient_id=? AND status IN ('booked','confirmed') AND start_utc>?").get(p.id, clock.iso())) reason = 'already_scheduled';
    if (reason) { ins.run(uid(), id, p.id, 'skipped', reason, null); counts.skipped++; } else { ins.run(uid(), id, p.id, 'queued', null, null); counts.queued++; }
  }
  processQueued();
  return { id, ...counts };
}

function processQueued() {
  const rows = db.prepare("SELECT m.*, c.location_id, c.tenant_id FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE m.status='queued' AND c.status='running'").all();
  let sent = 0;
  for (const m of rows) {
    const loc = core.getLocation(m.location_id);
    if (comms.inQuietHours(loc)) continue;
    const p = patients.getPatient(m.patient_id);
    const body = `Hi ${p.first_name}, it's ${loc.name}. It's time for your dental checkup and cleaning. Reply BOOK and we'll find a time that works. Reply STOP to opt out.`;
    const r = comms.send({ tenantId: m.tenant_id, locationId: m.location_id, patientId: p.id, to: p.phone, body, kind: 'recall', purpose: 'marketing' });
    db.prepare('UPDATE campaign_members SET status=?, contacted_at=?, reason=? WHERE id=?').run(r.status === 'blocked_no_consent' ? 'skipped' : 'contacted', nowIso(), r.status === 'blocked_no_consent' ? 'no_marketing_consent' : null, m.id);
    if (r.status !== 'blocked_no_consent') sent++;
  }
  return sent;
}

function list(locationId) {
  return db.prepare('SELECT * FROM campaigns WHERE location_id=? ORDER BY created_at DESC').all(locationId).map((c) => {
    const rows = db.prepare('SELECT status, COUNT(*) n FROM campaign_members WHERE campaign_id=? GROUP BY status').all(c.id);
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    const booked = db.prepare(`SELECT COUNT(DISTINCT a.patient_id) n FROM campaign_members m JOIN appointments a ON a.patient_id=m.patient_id
      WHERE m.campaign_id=? AND m.status='contacted' AND a.created_at>=m.contacted_at AND a.status IN ('booked','confirmed','completed')`).get(c.id).n;
    return { ...c, funnel: { queued: by.queued || 0, contacted: by.contacted || 0, skipped: by.skipped || 0, booked } };
  });
}

// Which patient replied BOOK to a recall text?
function memberForPhone(phone) {
  const ps = db.prepare("SELECT id FROM patients WHERE phone_hash=?").all(require('../crypto').hmac(core.normalizePhone(phone)));
  if (!ps.length) return null;
  const ph = ps.map(() => '?').join(',');
  return db.prepare(`SELECT m.* FROM campaign_members m WHERE m.patient_id IN (${ph}) AND m.status='contacted' ORDER BY m.contacted_at DESC LIMIT 1`).get(...ps.map((p) => p.id)) || null;
}

module.exports = { createRecall, processQueued, list, memberForPhone };
