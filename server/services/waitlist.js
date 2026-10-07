// Waitlist + cancellation backfill: a cancelled slot is offered to eligible waitlisted patients (first YES wins).
const { db, uid, nowIso, j, parse } = require('../db');
const clock = require('../clock');
const tz = require('../tz');
const core = require('./core');
const patients = require('./patients');
const comms = require('./comms');

function add({ tenantId, locationId, patientId, typeId, prefs = {}, priority = 0 }) {
  const dup = db.prepare("SELECT id FROM waitlist_entries WHERE patient_id=? AND type_id=? AND status='active'").get(patientId, typeId);
  if (dup) { db.prepare('UPDATE waitlist_entries SET prefs_json=? WHERE id=?').run(j(prefs), dup.id); return dup.id; }
  const id = uid();
  db.prepare('INSERT INTO waitlist_entries (id,tenant_id,location_id,patient_id,type_id,prefs_json,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, tenantId, locationId, patientId, typeId, j(prefs), priority, 'active', nowIso());
  return id;
}
const remove = (id) => db.prepare("UPDATE waitlist_entries SET status='removed' WHERE id=?").run(id);
function list(locationId) {
  return db.prepare(`SELECT w.*, p.first_name, p.last_name, t.name AS type_name FROM waitlist_entries w
    JOIN patients p ON p.id=w.patient_id JOIN appointment_types t ON t.id=w.type_id WHERE w.location_id=? AND w.status IN ('active','filled') ORDER BY w.created_at DESC`)
    .all(locationId).map((r) => ({ ...r, prefs: parse(r.prefs_json, {}) }));
}

function prefsOk(prefs, slot) {
  const wd = tz.weekdayOf(slot.local_date);
  const mins = tz.toMin(slot.local_time);
  if (prefs.days && prefs.days.length && !prefs.days.includes(wd)) return false;
  if (prefs.tod === 'morning' && mins >= 12 * 60) return false;
  if (prefs.tod === 'afternoon' && (mins < 12 * 60 || mins >= 17 * 60)) return false;
  if (prefs.tod === 'evening' && mins < 16 * 60) return false;
  if (prefs.after && mins < tz.toMin(prefs.after)) return false;
  return true;
}

// Called whenever an appointment is cancelled or rescheduled away from.
function onCancellation(apptRow) {
  const scheduling = require('./scheduling');
  const slotId = `${apptRow.provider_id}~${apptRow.start_utc}~${apptRow.type_id}`;
  const chk = scheduling.checkSlot({ locationId: apptRow.location_id, slotId, patient: { isNew: null, age: null } });
  if (!chk.ok) return { offered: 0, reason: chk.code };
  return offerSlot({ tenantId: apptRow.tenant_id, locationId: apptRow.location_id, slot: chk.slot, excludePatientIds: [apptRow.patient_id] });
}

function offerSlot({ tenantId, locationId, slot, excludePatientIds = [] }) {
  const scheduling = require('./scheduling');
  const loc = core.getLocation(locationId);
  const entries = db.prepare("SELECT * FROM waitlist_entries WHERE location_id=? AND status='active' AND type_id=?").all(locationId, slot.type_id);
  const candidates = [];
  for (const e of entries) {
    if (excludePatientIds.includes(e.patient_id)) continue;
    const p = patients.getPatient(e.patient_id);
    if (!p || !p.phone || p.do_not_contact) continue;
    if (!prefsOk(parse(e.prefs_json, {}), slot)) continue;
    // Do not re-offer the same slot, and cap offers per patient per week
    if (db.prepare("SELECT 1 FROM offers WHERE patient_id=? AND slot_json LIKE ? AND status IN ('pending','declined','expired')").get(p.id, `%${slot.slot_id}%`)) continue;
    const weekAgo = new Date(clock.now().getTime() - 7 * 86400000).toISOString();
    if (db.prepare('SELECT COUNT(*) c FROM offers WHERE patient_id=? AND sent_at>?').get(p.id, weekAgo).c >= 3) continue;
    const ok = scheduling.checkSlot({ locationId, slotId: slot.slot_id, patient: scheduling.patientCtx(p) });
    if (!ok.ok) continue;
    candidates.push({ e, p });
  }
  candidates.sort((a, b) => (b.e.priority - a.e.priority) || a.e.created_at.localeCompare(b.e.created_at) || (a.p.no_shows - b.p.no_shows));
  const take = loc.settings.waitlist_mode === 'sequential' ? 1 : 3;
  const ttl = loc.settings.offer_ttl_min || 15;
  let offered = 0;
  for (const { e, p } of candidates.slice(0, take)) {
    const id = uid();
    const expires = new Date(clock.now().getTime() + ttl * 60000).toISOString();
    db.prepare('INSERT INTO offers (id,tenant_id,location_id,waitlist_entry_id,patient_id,slot_json,sent_at,expires_at,status) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, tenantId, locationId, e.id, p.id, j(slot), nowIso(), expires, 'pending');
    const body = `Hi ${p.first_name}, a ${slot.type_name} just opened at ${loc.name}: ${slot.spoken}. Reply YES within ${ttl} minutes to take it. Reply STOP to opt out.`;
    comms.send({ tenantId, locationId, patientId: p.id, to: p.phone, body, kind: 'waitlist_offer' });
    offered++;
  }
  if (offered) core.emit(tenantId, 'waitlist.offers', { count: offered });
  return { offered };
}

// Patient replied YES to an offer
function acceptOffer(patientIds) {
  const scheduling = require('./scheduling');
  const now = clock.now().toISOString();
  const ph = patientIds.map(() => '?').join(',');
  if (!patientIds.length) return null;
  const offer = db.prepare(`SELECT * FROM offers WHERE patient_id IN (${ph}) AND status='pending' AND expires_at>? ORDER BY sent_at DESC LIMIT 1`).get(...patientIds, now);
  if (!offer) return null;
  const slot = parse(offer.slot_json);
  const p = patients.getPatient(offer.patient_id);
  try {
    const { appointment } = scheduling.bookAppointment({
      tenantId: offer.tenant_id, locationId: offer.location_id, patientId: p.id, slotId: slot.slot_id, source: 'waitlist',
      idempotencyKey: `offer-${offer.id}`, actor: 'waitlist', reason: 'Waitlist offer accepted',
    });
    db.prepare("UPDATE offers SET status='accepted', appointment_id=? WHERE id=?").run(appointment.id, offer.id);
    db.prepare("UPDATE waitlist_entries SET status='filled' WHERE id=?").run(offer.waitlist_entry_id);
    const others = db.prepare("SELECT * FROM offers WHERE status='pending' AND slot_json LIKE ? AND id<>?").all(`%${slot.slot_id}%`, offer.id);
    for (const o of others) {
      db.prepare("UPDATE offers SET status='slot_taken' WHERE id=?").run(o.id);
      const op = patients.getPatient(o.patient_id);
      if (op && op.phone) comms.send({ tenantId: o.tenant_id, locationId: o.location_id, patientId: op.id, to: op.phone, body: 'Thanks for your quick reply. That time was just taken, but you are still on our waitlist and we will text you if another one opens.', kind: 'waitlist_offer' });
    }
    return { ok: true, appointment, reply: `You're booked: ${appointment.type_name} ${appointment.spoken} with ${appointment.provider_name}. See you then!` };
  } catch (e) {
    db.prepare("UPDATE offers SET status='slot_taken' WHERE id=?").run(offer.id);
    return { ok: false, reply: 'Sorry, that time was just taken. You are still on our waitlist and we will text you if another one opens.' };
  }
}

function expireOffers() {
  const now = clock.now().toISOString();
  const rows = db.prepare("SELECT * FROM offers WHERE status='pending' AND expires_at<=?").all(now);
  for (const o of rows) {
    db.prepare("UPDATE offers SET status='expired' WHERE id=?").run(o.id);
    const loc = core.getLocation(o.location_id);
    if (loc.settings.waitlist_mode === 'sequential') {
      const slot = parse(o.slot_json);
      const still = db.prepare("SELECT 1 FROM offers WHERE slot_json LIKE ? AND status IN ('pending','accepted')").get(`%${slot.slot_id}%`);
      if (!still) { try { offerSlot({ tenantId: o.tenant_id, locationId: o.location_id, slot, excludePatientIds: [] }); } catch (_) { /* slot may be gone */ } }
    }
  }
  return rows.length;
}

const listOffers = (locationId) => db.prepare(`SELECT o.*, p.first_name, p.last_name FROM offers o JOIN patients p ON p.id=o.patient_id WHERE o.location_id=? ORDER BY o.sent_at DESC LIMIT 100`)
  .all(locationId).map((r) => ({ ...r, slot: parse(r.slot_json) }));

module.exports = { add, remove, list, onCancellation, offerSlot, acceptOffer, expireOffers, listOffers };
