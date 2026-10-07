const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { db, nowIso } = require('../db');
const clock = require('../clock');
const core = require('../services/core');
const totp = require('../totp');
const { encrypt, decrypt } = require('../crypto');
const sec = require('../middleware/security');

const router = express.Router();
const LOCK_AFTER = 5;
const LOCK_MIN = 15;

const loginSchema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200), code: z.string().max(10).optional() });

router.post('/login', sec.limits.login, (req, res) => {
  const parsed = loginSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and password.' });
  const { email, password, code } = parsed.data;
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase());
  const fail = (msg = 'Incorrect email or password.') => res.status(401).json({ error: msg });
  if (!user) { bcrypt.compareSync(password, '$2a$10$abcdefghijklmnopqrstuuJ1Y2zP3QJ6h3mY2kY0y4f2X5v5H8a1K'); return fail(); } // constant-ish timing
  if (user.locked_until && user.locked_until > clock.iso()) return res.status(423).json({ error: `Account temporarily locked. Try again in a few minutes.` });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    const n = user.failed_logins + 1;
    if (n >= LOCK_AFTER) {
      db.prepare('UPDATE users SET failed_logins=0, locked_until=? WHERE id=?').run(new Date(clock.now().getTime() + LOCK_MIN * 60000).toISOString(), user.id);
      core.audit({ tenantId: user.tenant_id, actor: user.email, action: 'account_locked', ip: req.ip });
    } else db.prepare('UPDATE users SET failed_logins=? WHERE id=?').run(n, user.id);
    core.audit({ tenantId: user.tenant_id, actor: user.email, action: 'login_failed', ip: req.ip });
    return fail();
  }
  if (user.mfa_enabled) {
    if (!code) return res.status(200).json({ mfa_required: true });
    if (!totp.verify(decrypt(user.totp_secret), code)) { core.audit({ tenantId: user.tenant_id, actor: user.email, action: 'mfa_failed', ip: req.ip }); return fail('That code is not valid. Please try again.'); }
  }
  db.prepare('UPDATE users SET failed_logins=0, locked_until=NULL, last_login=? WHERE id=?').run(nowIso(), user.id);
  sec.issueSession(res, user, req);
  core.audit({ tenantId: user.tenant_id, actor: user.email, action: 'login', ip: req.ip });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => { res.clearCookie(sec.COOKIE, { path: '/' }); res.json({ ok: true }); });

router.get('/me', sec.requireAuth, (req, res) => res.json({ user: req.user }));

router.post('/mfa/setup', sec.requireAuth, sec.csrfGuard, (req, res) => {
  const secret = totp.generateSecret();
  db.prepare('UPDATE users SET totp_secret=?, mfa_enabled=0 WHERE id=?').run(encrypt(secret), req.user.id);
  res.json({ secret, otpauth: totp.otpauthUri(secret, req.user.email) });
});
router.post('/mfa/enable', sec.requireAuth, sec.csrfGuard, (req, res) => {
  const u = db.prepare('SELECT totp_secret FROM users WHERE id=?').get(req.user.id);
  if (!u.totp_secret) return res.status(400).json({ error: 'Start setup first.' });
  if (!totp.verify(decrypt(u.totp_secret), (req.body || {}).code)) return res.status(400).json({ error: 'That code is not valid.' });
  db.prepare('UPDATE users SET mfa_enabled=1 WHERE id=?').run(req.user.id);
  core.audit({ tenantId: req.user.tenant_id, actor: req.user.email, action: 'mfa_enabled', ip: req.ip });
  res.json({ ok: true });
});
router.post('/mfa/disable', sec.requireAuth, sec.csrfGuard, (req, res) => {
  const body = z.object({ password: z.string().min(1) }).safeParse(req.body || {});
  const u = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!body.success || !bcrypt.compareSync(body.data.password, u.password_hash)) return res.status(400).json({ error: 'Password is incorrect.' });
  db.prepare('UPDATE users SET mfa_enabled=0, totp_secret=NULL WHERE id=?').run(req.user.id);
  core.audit({ tenantId: req.user.tenant_id, actor: req.user.email, action: 'mfa_disabled', ip: req.ip });
  res.json({ ok: true });
});

const pwSchema = z.object({ current: z.string().min(1), next: z.string().min(10, 'Use at least 10 characters.').max(200).regex(/[A-Za-z]/, 'Include a letter.').regex(/\d/, 'Include a number.') });
router.post('/password', sec.requireAuth, sec.csrfGuard, (req, res) => {
  const p = pwSchema.safeParse(req.body || {});
  if (!p.success) return res.status(400).json({ error: p.error.issues[0].message });
  const u = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(p.data.current, u.password_hash)) return res.status(400).json({ error: 'Current password is incorrect.' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(p.data.next, 12), req.user.id);
  core.audit({ tenantId: req.user.tenant_id, actor: req.user.email, action: 'password_changed', ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;
