const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const cfg = require('../config');
const { db } = require('../db');

// ---- 4. Force HTTPS (production / FORCE_HTTPS=true). Localhost is exempt so local development keeps working.
function forceHttps(req, res, next) {
  if (!cfg.forceHttps) return next();
  const host = (req.headers.host || '').split(':')[0];
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return next();
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    return next();
  }
  if (req.path === '/healthz') return next(); // load balancers probe over HTTP
  return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
}

// ---- Security headers incl. a strict Content-Security-Policy (no inline scripts or styles)
function headers() {
  const scriptSrc = ["'self'"];
  const connectSrc = ["'self'"];
  const frameSrc = ["'none'"];
  if (cfg.analytics.ga4) { scriptSrc.push('https://www.googletagmanager.com'); connectSrc.push('https://www.google-analytics.com', 'https://*.analytics.google.com', 'https://www.googletagmanager.com'); }
  if (cfg.analytics.plausibleDomain) { scriptSrc.push('https://plausible.io'); connectSrc.push('https://plausible.io'); }
  if (cfg.turnstile.site) { scriptSrc.push('https://challenges.cloudflare.com'); frameSrc.splice(0, 1, 'https://challenges.cloudflare.com'); }
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"], 'script-src': scriptSrc, 'style-src': ["'self'"], 'img-src': ["'self'", 'data:'], 'font-src': ["'self'"],
        'connect-src': connectSrc, 'frame-src': frameSrc, 'object-src': ["'none'"], 'base-uri': ["'self'"], 'form-action': ["'self'"], 'frame-ancestors': ["'none'"],
        ...(cfg.forceHttps ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    hsts: false, // set manually, only over verified HTTPS
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // lets the chat widget script load on clinic websites
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

// ---- CSRF defence for cookie-authenticated API calls: custom header + same-origin Origin check
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'DentaFlow') return res.status(403).json({ error: 'Missing CSRF header' });
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked' }); }
    catch (_) { return res.status(403).json({ error: 'Bad origin' }); }
  }
  next();
}

// ---- Auth
const COOKIE = 'df_session';
function issueSession(res, user, req) {
  const token = jwt.sign({ uid: user.id, tid: user.tenant_id, role: user.role }, cfg.jwtSecret, { expiresIn: `${cfg.sessionHours}h` });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: !!(req.secure || req.headers['x-forwarded-proto'] === 'https'), maxAge: cfg.sessionHours * 3600 * 1000, path: '/' });
}
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    const p = jwt.verify(token, cfg.jwtSecret);
    const user = db.prepare('SELECT id,tenant_id,email,name,role,mfa_enabled FROM users WHERE id=?').get(p.uid);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });
    req.user = user;
    next();
  } catch (_) { return res.status(401).json({ error: 'Session expired' }); }
}
const requireRole = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have permission to do that' }));

// ---- Rate limiters
const mk = (windowMs, max, message) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: message }, skip: () => process.env.DF_DISABLE_RATE_LIMIT === '1' });
const limits = {
  login: mk(15 * 60 * 1000, 15, 'Too many sign-in attempts. Please wait 15 minutes.'),
  lead: mk(60 * 60 * 1000, 6, 'Too many requests. Please try again later.'),
  chat: mk(60 * 1000, 40, 'You are sending messages too quickly. Please slow down.'),
  chatStart: mk(60 * 60 * 1000, 40, 'Too many chat sessions started from this connection.'),
  collect: mk(60 * 1000, 60, 'Too many events.'),
  api: mk(60 * 1000, 600, 'Too many requests.'),
};

module.exports = { forceHttps, headers, csrfGuard, issueSession, requireAuth, requireRole, limits, COOKIE };
