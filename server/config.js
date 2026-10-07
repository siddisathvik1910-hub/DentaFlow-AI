const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const isProd = env.NODE_ENV === 'production';
const dataDir = env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Secrets: required in production. In development they are generated once and kept
// in data/.dev-secrets.json (never sent to the browser, git-ignored).
function devSecrets() {
  const file = path.join(dataDir, '.dev-secrets.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* first run */ }
  const crypto = require('crypto');
  let changed = false;
  for (const k of ['jwtSecret', 'encryptionKey']) {
    if (!s[k]) { s[k] = crypto.randomBytes(32).toString('hex'); changed = true; }
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
  return s;
}
let jwtSecret = env.JWT_SECRET;
let encryptionKey = env.ENCRYPTION_KEY;
if (!jwtSecret || !encryptionKey) {
  if (isProd) throw new Error('JWT_SECRET and ENCRYPTION_KEY must be set in production (see .env.example).');
  const d = devSecrets();
  jwtSecret = jwtSecret || d.jwtSecret;
  encryptionKey = encryptionKey || d.encryptionKey;
}
const port = parseInt(env.PORT || '3000', 10);

module.exports = {
  isProd,
  port,
  dataDir,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dbPath: env.DB_PATH || path.join(dataDir, 'dentaflow.db'),
  jwtSecret,
  encryptionKey,
  forceHttps: bool(env.FORCE_HTTPS, isProd),
  trustProxy: bool(env.TRUST_PROXY, isProd),
  seedDemo: bool(env.SEED_DEMO, !isProd),
  company: {
    name: env.COMPANY_NAME || 'DentaFlow AI, Inc.',
    email: env.COMPANY_EMAIL || 'privacy@example.com',
    address: env.COMPANY_ADDRESS || '123 Example Street, Your City, ST 00000',
    jurisdiction: env.COMPANY_JURISDICTION || 'the State of Delaware, USA',
  },
  // Server-side only secrets / provider keys. These are never serialized to the browser.
  anthropic: { key: env.ANTHROPIC_API_KEY || '', model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5' },
  twilio: { sid: env.TWILIO_ACCOUNT_SID || '', token: env.TWILIO_AUTH_TOKEN || '', from: env.TWILIO_FROM_NUMBER || '' },
  stripe: { key: env.STRIPE_SECRET_KEY || '', price: env.STRIPE_PRICE_ID || '' },
  turnstile: { site: env.TURNSTILE_SITE_KEY || '', secret: env.TURNSTILE_SECRET_KEY || '' },
  // Public (safe for the browser) analytics IDs
  analytics: { ga4: env.GA4_MEASUREMENT_ID || '', plausibleDomain: env.PLAUSIBLE_DOMAIN || '' },
  sessionHours: parseInt(env.SESSION_HOURS || '12', 10),
  demoPassword: env.DEMO_PASSWORD || 'DentaFlow!2026',
};
