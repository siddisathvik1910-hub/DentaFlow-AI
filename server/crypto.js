const crypto = require('crypto');
const cfg = require('./config');

const key = crypto.createHash('sha256').update(String(cfg.encryptionKey)).digest(); // 32 bytes
const macKey = crypto.createHash('sha256').update('mac:' + cfg.encryptionKey).digest();

// AES-256-GCM field-level encryption for PHI (DOB, phone, email, insurance ids)
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') return null;
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// Deterministic keyed hash for lookups (e.g. phone numbers) without storing plaintext
const hmac = (s) => crypto.createHmac('sha256', macKey).update(String(s)).digest('hex');
const randomToken = (n = 24) => crypto.randomBytes(n).toString('base64url');

module.exports = { encrypt, decrypt, hmac, randomToken };
