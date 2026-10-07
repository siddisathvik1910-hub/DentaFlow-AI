#!/usr/bin/env node
// Creates a new practice (tenant), its first location with sensible defaults, and an owner login. For production use.
//   npm run create-admin -- --email you@clinic.com --name "Dr. Jane Doe" --clinic "Smile Dental" --password "LongPassw0rd!" [--timezone America/Chicago]
const bcrypt = require('bcryptjs');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? a.concat([[v.slice(2), arr[i + 1]]]) : a), []));
const need = ['email', 'name', 'clinic', 'password'];
if (need.some((k) => !args[k])) { console.error('Usage: npm run create-admin -- --email E --name N --clinic C --password P [--timezone TZ]'); process.exit(1); }
if (args.password.length < 10 || !/[A-Za-z]/.test(args.password) || !/\d/.test(args.password)) { console.error('Password must be at least 10 characters with a letter and a number.'); process.exit(1); }
const { db, uid, nowIso, j } = require('../server/db');
const core = require('../server/services/core');
const crypto = require('../server/crypto');
if (db.prepare('SELECT 1 FROM users WHERE email=?').get(args.email.toLowerCase())) { console.error('A user with that email already exists.'); process.exit(1); }
const tenantId = uid(), locId = uid();
db.prepare('INSERT INTO tenants (id,name,plan,status,created_at) VALUES (?,?,?,?,?)').run(tenantId, args.clinic, 'growth', 'active', nowIso());
db.prepare('INSERT INTO users (id,tenant_id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?,?)').run(uid(), tenantId, args.email.toLowerCase(), args.name, bcrypt.hashSync(args.password, 12), 'owner', nowIso());
db.prepare('INSERT INTO locations (id,tenant_id,name,timezone,hours_json,settings_json,widget_key,created_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(locId, tenantId, args.clinic, args.timezone || 'America/New_York', j(core.DEFAULT_HOURS), j(core.DEFAULT_SETTINGS), 'wk_' + crypto.randomToken(12), nowIso());
const week = (blocks, fri) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, d === 'fri' ? fri : blocks]));
const prov = (name, type) => db.prepare('INSERT INTO providers (id,location_id,name,type,accepts_new,schedule_json,active) VALUES (?,?,?,?,1,?,1)').run(uid(), locId, name, type, j(week([['08:00', '12:00'], ['13:00', '17:00']], [['08:00', '12:00']])));
prov('Dentist (edit name & hours)', 'dentist'); prov('Hygienist (edit name & hours)', 'hygienist');
const type = (code, name, dur, o = {}) => db.prepare('INSERT INTO appointment_types (id,location_id,code,name,duration_min,allowed_provider_types,new_patient_only,existing_only,lead_time_min,is_emergency,agent_permissions,value_estimate,keywords) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(uid(), locId, code, name, dur, j(o.types || ['dentist']), o.newOnly ? 1 : 0, o.existingOnly ? 1 : 0, o.lead ?? 120, o.emergency ? 1 : 0, j({ book: true, reschedule: true, cancel: true }), o.value || 0, j(o.kw || []));
type('NEW_PT_EXAM', 'New Patient Exam & X-rays', 60, { newOnly: true, value: 285 });
type('CLEANING', 'Cleaning & Exam', 60, { types: ['hygienist'], existingOnly: true, value: 195, kw: ['cleaning', 'hygiene', 'teeth cleaning'] });
type('CHECKUP', 'Checkup & Exam', 30, { existingOnly: true, value: 120, kw: ['checkup', 'check-up', 'exam', 'x-ray'] });
type('EMERGENCY_EXAM', 'Emergency Exam', 30, { emergency: true, lead: 0, value: 250, kw: ['emergency'] });
type('CONSULT', 'Consultation', 30, { value: 80, kw: ['whitening', 'consult', 'invisalign', 'implant', 'cosmetic'] });
console.log(`Created practice "${args.clinic}" and owner ${args.email}.\nNext: sign in at /login, set hours, providers and rules in Settings, add your FAQs in Knowledge base, then run a test call.`);
