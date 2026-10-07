const { db, uid, nowIso } = require('../db');
const { encrypt, decrypt, hmac } = require('../crypto');
const { normalizePhone } = require('./core');
const clock = require('../clock');

function hydrate(r, { full = true } = {}) {
  if (!r) return null;
  const out = {
    id: r.id, tenant_id: r.tenant_id, location_id: r.location_id, first_name: r.first_name, last_name: r.last_name,
    status: r.status, last_visit: r.last_visit, recall_due: r.recall_due, no_shows: r.no_shows, do_not_contact: !!r.do_not_contact,
    preferred_language: r.preferred_language, created_at: r.created_at, pms_patient_id: r.pms_patient_id,
  };
  if (full) { out.dob = decrypt(r.dob_enc); out.phone = decrypt(r.phone_enc); out.email = decrypt(r.email_enc); }
  return out;
}

const getPatient = (id) => hydrate(db.prepare('SELECT * FROM patients WHERE id=?').get(id));

function createPatient({ tenantId, locationId, first_name, last_name, dob, phone, email, preferred_language = 'en', last_visit = null, recall_due = null }) {
  const id = uid();
  const p = normalizePhone(phone);
  db.prepare(`INSERT INTO patients (id,tenant_id,location_id,first_name,last_name,dob_enc,phone_enc,phone_hash,email_enc,preferred_language,last_visit,recall_due,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, tenantId, locationId, titleCase(first_name), titleCase(last_name), encrypt(dob), encrypt(p), p ? hmac(p) : null, encrypt(email), preferred_language, last_visit, recall_due, nowIso());
  return getPatient(id);
}

function updatePatient(id, patch) {
  const cur = db.prepare('SELECT * FROM patients WHERE id=?').get(id);
  if (!cur) return null;
  const phone = patch.phone !== undefined ? normalizePhone(patch.phone) : undefined;
  db.prepare(`UPDATE patients SET first_name=?, last_name=?, dob_enc=?, phone_enc=?, phone_hash=?, email_enc=?, preferred_language=?, do_not_contact=?, recall_due=? WHERE id=?`).run(
    patch.first_name ? titleCase(patch.first_name) : cur.first_name,
    patch.last_name ? titleCase(patch.last_name) : cur.last_name,
    patch.dob !== undefined ? encrypt(patch.dob) : cur.dob_enc,
    phone !== undefined ? encrypt(phone) : cur.phone_enc,
    phone !== undefined ? (phone ? hmac(phone) : null) : cur.phone_hash,
    patch.email !== undefined ? encrypt(patch.email) : cur.email_enc,
    patch.preferred_language || cur.preferred_language,
    patch.do_not_contact !== undefined ? (patch.do_not_contact ? 1 : 0) : cur.do_not_contact,
    patch.recall_due !== undefined ? patch.recall_due : cur.recall_due,
    id);
  return getPatient(id);
}

function titleCase(s) {
  return String(s || '').trim().toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

function findByPhone(locationId, phone) {
  const p = normalizePhone(phone);
  if (!p) return [];
  return db.prepare('SELECT * FROM patients WHERE location_id=? AND phone_hash=? AND status=\'active\'').all(locationId, hmac(p)).map(hydrate);
}

// Damerau-Levenshtein (optimal string alignment): a swapped pair of letters counts as one error,
// which matches typical speech-to-text slips ("Jaems" for "James").
function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let k = 0; k <= n; k++) d[0][k] = k;
  for (let i = 1; i <= m; i++) {
    for (let k = 1; k <= n; k++) {
      const cost = a[i - 1] === b[k - 1] ? 0 : 1;
      d[i][k] = Math.min(d[i - 1][k] + 1, d[i][k - 1] + 1, d[i - 1][k - 1] + cost);
      if (i > 1 && k > 1 && a[i - 1] === b[k - 2] && a[i - 2] === b[k - 1]) d[i][k] = Math.min(d[i][k], d[i - 2][k - 2] + 1);
    }
  }
  return d[m][n];
}
const nameClose = (a, b) => { a = String(a || '').trim(); b = String(b || '').trim(); return a.toLowerCase() === b.toLowerCase() || levenshtein(a, b) <= (Math.max(a.length, b.length) >= 6 ? 2 : 1); };

// Candidates by (fuzzy) last name; the caller then verifies DOB
function findByName(locationId, first, last) {
  const rows = db.prepare('SELECT * FROM patients WHERE location_id=? AND status=\'active\'').all(locationId);
  return rows.filter((r) => nameClose(r.last_name, last) && nameClose(r.first_name, first)).map(hydrate);
}

// Identity verification = name + DOB. Caller ID alone is never proof of identity.
function verifyIdentity(locationId, { first_name, last_name, dob }) {
  if (!first_name || !last_name || !dob) return null;
  const hits = findByName(locationId, first_name, last_name).filter((p) => p.dob === dob);
  return hits.length === 1 ? hits[0] : null;
}

function ageOf(dob, at = clock.now()) {
  if (!dob) return null;
  const [y, m, d] = dob.split('-').map(Number);
  let age = at.getUTCFullYear() - y;
  if (at.getUTCMonth() + 1 < m || (at.getUTCMonth() + 1 === m && at.getUTCDate() < d)) age--;
  return age;
}

const hasAnyAppointment = (patientId) => !!db.prepare('SELECT 1 FROM appointments WHERE patient_id=? AND status IN (\'booked\',\'confirmed\',\'completed\')').get(patientId);

// ---------- Consent ----------
function recordConsent({ tenantId, patientId, phone, purpose = 'transactional', status, source }) {
  const p = normalizePhone(phone);
  if (!p) return;
  db.prepare('INSERT INTO consents (id,tenant_id,patient_id,phone_hash,channel,purpose,status,source,ts) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(uid(), tenantId, patientId || null, hmac(p), 'sms', purpose, status, source || null, nowIso());
}
// Latest record wins. Opt-out (revoked, purpose 'all') blocks every purpose.
function consentStatus(phone, purpose = 'transactional') {
  const p = normalizePhone(phone);
  if (!p) return 'none';
  const h = hmac(p);
  const all = db.prepare("SELECT status FROM consents WHERE phone_hash=? AND purpose='all' ORDER BY ts DESC, rowid DESC LIMIT 1").get(h);
  const one = db.prepare('SELECT status FROM consents WHERE phone_hash=? AND purpose=? ORDER BY ts DESC, rowid DESC LIMIT 1').get(h, purpose);
  const allTs = all ? db.prepare("SELECT ts FROM consents WHERE phone_hash=? AND purpose='all' ORDER BY ts DESC, rowid DESC LIMIT 1").get(h).ts : null;
  const oneTs = one ? db.prepare('SELECT ts FROM consents WHERE phone_hash=? AND purpose=? ORDER BY ts DESC, rowid DESC LIMIT 1').get(h, purpose).ts : null;
  if (all && all.status === 'revoked' && (!oneTs || allTs >= oneTs)) return 'revoked';
  return one ? one.status : 'none';
}
const canText = (phone, purpose = 'transactional') => {
  const s = consentStatus(phone, purpose);
  if (purpose === 'marketing') return s === 'granted';
  return s !== 'revoked'; // transactional: allowed unless opted out
};

// ---------- Insurance ----------
function addPolicy({ tenantId, patientId, carrier, member_id, subscriber }) {
  const id = uid();
  db.prepare('INSERT INTO insurance_policies (id,tenant_id,patient_id,carrier,member_id_enc,subscriber,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, tenantId, patientId, carrier || null, encrypt(member_id), subscriber || null, carrier && /self/i.test(carrier) ? 'self_pay' : 'unverified', nowIso());
  return id;
}
const listPolicies = (patientId) => db.prepare('SELECT * FROM insurance_policies WHERE patient_id=? ORDER BY created_at DESC').all(patientId)
  .map((r) => ({ id: r.id, carrier: r.carrier, member_id_masked: maskId(decrypt(r.member_id_enc)), status: r.status, verified_at: r.verified_at, result: r.result_json ? JSON.parse(r.result_json) : null }));
const maskId = (s) => (s ? '*'.repeat(Math.max(0, s.length - 3)) + s.slice(-3) : null);

module.exports = {
  hydrate, getPatient, createPatient, updatePatient, findByPhone, findByName, verifyIdentity, ageOf, hasAnyAppointment,
  recordConsent, consentStatus, canText, addPolicy, listPolicies, titleCase, nameClose, levenshtein,
};
