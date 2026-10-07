const Database = require('better-sqlite3');
const crypto = require('crypto');
const cfg = require('./config');
const clock = require('./clock');

const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'growth', status TEXT NOT NULL DEFAULT 'active',
  baa_signed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', totp_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT, last_login TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), name TEXT NOT NULL, address TEXT, phone TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York', hours_json TEXT NOT NULL, settings_json TEXT NOT NULL,
  widget_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS phone_numbers (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id), e164 TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL DEFAULT 'voice', routing_mode TEXT NOT NULL DEFAULT 'always', forward_to TEXT, status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id), name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'dentist',
  accepts_new INTEGER NOT NULL DEFAULT 1, schedule_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, pms_provider_id TEXT
);
CREATE TABLE IF NOT EXISTS appointment_types (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id), code TEXT NOT NULL, name TEXT NOT NULL,
  duration_min INTEGER NOT NULL, buffer_min INTEGER NOT NULL DEFAULT 0, allowed_provider_types TEXT NOT NULL DEFAULT '["dentist"]',
  allowed_provider_ids TEXT NOT NULL DEFAULT '[]', new_patient_only INTEGER NOT NULL DEFAULT 0, existing_only INTEGER NOT NULL DEFAULT 0,
  min_age INTEGER, max_age INTEGER, lead_time_min INTEGER NOT NULL DEFAULT 60, max_horizon_days INTEGER NOT NULL DEFAULT 90,
  is_emergency INTEGER NOT NULL DEFAULT 0, agent_permissions TEXT NOT NULL DEFAULT '{"book":true,"reschedule":true,"cancel":true}',
  value_estimate REAL NOT NULL DEFAULT 0, keywords TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(location_id, code)
);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), location_id TEXT NOT NULL REFERENCES locations(id),
  first_name TEXT NOT NULL, last_name TEXT NOT NULL, dob_enc TEXT, phone_enc TEXT, phone_hash TEXT, email_enc TEXT,
  preferred_language TEXT DEFAULT 'en', status TEXT NOT NULL DEFAULT 'active', last_visit TEXT, recall_due TEXT,
  no_shows INTEGER NOT NULL DEFAULT 0, do_not_contact INTEGER NOT NULL DEFAULT 0, pms_patient_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(location_id, phone_hash);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(location_id, last_name);
CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, patient_id TEXT, phone_hash TEXT, channel TEXT NOT NULL DEFAULT 'sms',
  purpose TEXT NOT NULL DEFAULT 'transactional', status TEXT NOT NULL, source TEXT, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consents_phone ON consents(phone_hash, purpose, ts);
CREATE TABLE IF NOT EXISTS insurance_policies (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id), carrier TEXT, member_id_enc TEXT,
  subscriber TEXT, status TEXT NOT NULL DEFAULT 'unverified', verified_at TEXT, result_json TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, location_id TEXT NOT NULL REFERENCES locations(id), patient_id TEXT NOT NULL REFERENCES patients(id),
  provider_id TEXT NOT NULL REFERENCES providers(id), type_id TEXT NOT NULL REFERENCES appointment_types(id),
  start_utc TEXT NOT NULL, end_utc TEXT NOT NULL, block_end_utc TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'booked',
  source TEXT NOT NULL DEFAULT 'staff', confirmation_status TEXT NOT NULL DEFAULT 'unconfirmed', pms_appointment_id TEXT,
  idempotency_key TEXT UNIQUE, reason TEXT, conversation_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appt_provider ON appointments(provider_id, start_utc);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id, start_utc);
CREATE TABLE IF NOT EXISTS appointment_events (
  id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL, event TEXT NOT NULL, actor TEXT, payload TEXT, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, location_id TEXT NOT NULL, channel TEXT NOT NULL, external_id TEXT,
  from_number TEXT, patient_id TEXT, state_json TEXT NOT NULL DEFAULT '{}', verified INTEGER NOT NULL DEFAULT 0, intent TEXT,
  outcome TEXT, language TEXT DEFAULT 'en', status TEXT NOT NULL DEFAULT 'active', handoff INTEGER NOT NULL DEFAULT 0,
  after_hours INTEGER NOT NULL DEFAULT 0, new_patient INTEGER NOT NULL DEFAULT 0, urgency TEXT, summary TEXT, qa_score REAL,
  feedback TEXT, started_at TEXT NOT NULL, last_activity TEXT NOT NULL, ended_at TEXT, engine TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_loc ON conversations(location_id, started_at);
CREATE INDEX IF NOT EXISTS idx_conv_ext ON conversations(external_id, channel);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, text TEXT NOT NULL,
  redacted_text TEXT, confidence REAL, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, ts);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, name TEXT NOT NULL, args_json TEXT, result_json TEXT,
  status TEXT NOT NULL, latency_ms INTEGER, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS triage_events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, conversation_id TEXT, level TEXT NOT NULL, rule TEXT, action TEXT, reviewed INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, location_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  urgency TEXT NOT NULL DEFAULT 'normal', assignee_id TEXT, patient_id TEXT, conversation_id TEXT, title TEXT NOT NULL,
  payload_json TEXT, notes TEXT, due_at TEXT, resolved_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_loc ON tasks(location_id, status);
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, location_id TEXT NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id),
  type_id TEXT NOT NULL, prefs_json TEXT NOT NULL DEFAULT '{}', priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, location_id TEXT NOT NULL, waitlist_entry_id TEXT, patient_id TEXT NOT NULL,
  slot_json TEXT NOT NULL, sent_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', appointment_id TEXT
);
CREATE TABLE IF NOT EXISTS reminder_schedules (
  id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL, step_hours INTEGER NOT NULL, send_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', sent_at TEXT, UNIQUE(appointment_id, step_hours)
);
CREATE INDEX IF NOT EXISTS idx_rem_due ON reminder_schedules(status, send_at);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, location_id TEXT, patient_id TEXT, channel TEXT NOT NULL DEFAULT 'sms',
  to_addr TEXT, body TEXT NOT NULL, kind TEXT, status TEXT NOT NULL, provider TEXT, provider_sid TEXT, error TEXT,
  conversation_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, location_id TEXT NOT NULL, title TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT 'text',
  source_url TEXT, content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE, tenant_id TEXT NOT NULL,
  location_id TEXT NOT NULL, text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS unanswered_questions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, location_id TEXT NOT NULL, question TEXT NOT NULL, conversation_id TEXT, ts TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, location_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'recall',
  filters_json TEXT, status TEXT NOT NULL DEFAULT 'running', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_members (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, patient_id TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, contacted_at TEXT, booked_appointment_id TEXT
);
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, conversation_id TEXT, kind TEXT NOT NULL, quantity REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, tenant_id TEXT, actor TEXT, action TEXT NOT NULL, resource TEXT, resource_id TEXT, ip TEXT, detail TEXT, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings_versions (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, author TEXT, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL, pms_type TEXT NOT NULL, config_enc TEXT, status TEXT NOT NULL DEFAULT 'connected', last_sync_at TEXT
);
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, clinic TEXT, phone TEXT, message TEXT, source TEXT, ip_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS web_events (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, referrer TEXT, device TEXT, session TEXT, ts TEXT NOT NULL
);
`);

const uid = () => crypto.randomUUID();
const nowIso = () => clock.iso();
const j = (v) => JSON.stringify(v);
const parse = (s, d = null) => { if (s === null || s === undefined || s === '') return d; try { return JSON.parse(s); } catch (_) { return d; } };
const tx = (fn) => db.transaction(fn)();

module.exports = { db, uid, nowIso, j, parse, tx };
