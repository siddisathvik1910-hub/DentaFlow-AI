const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { db, uid, nowIso } = require('../db');
const cfg = require('../config');
const core = require('../services/core');
const conversations = require('../services/conversations');
const sec = require('../middleware/security');
const { hmac } = require('../crypto');

const router = express.Router();

// CORS only for the embeddable chat widget (protected by widget key + rate limits, carries no cookies)
router.use(['/chat'], (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Public configuration. Contains ONLY values that are safe for browsers (no secrets).
router.get('/config', (req, res) => {
  const demo = db.prepare('SELECT widget_key FROM locations ORDER BY created_at LIMIT 1').get();
  res.json({
    ga4: cfg.analytics.ga4 || null,
    plausibleDomain: cfg.analytics.plausibleDomain || null,
    turnstileSiteKey: cfg.turnstile.site || null,
    demoWidgetKey: cfg.seedDemo && demo ? demo.widget_key : null,
  });
});

// ---------- Anti-bot form token: signed timestamp, must be at least 3 seconds old and under 2 hours old
const sign = (ts) => crypto.createHmac('sha256', cfg.jwtSecret).update('form:' + ts).digest('hex').slice(0, 32);
router.get('/form-token', (req, res) => { const ts = Date.now(); res.json({ token: `${ts}.${sign(ts)}` }); });
function checkFormToken(token) {
  const [ts, sig] = String(token || '').split('.');
  if (!ts || !sig || sig !== sign(ts)) return 'invalid';
  const age = Date.now() - Number(ts);
  if (age < 3000) return 'too_fast';
  if (age > 2 * 3600 * 1000) return 'expired';
  return null;
}
async function verifyTurnstile(token, ip) {
  if (!cfg.turnstile.secret) return true; // not configured: honeypot + timing + rate limit still apply
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: cfg.turnstile.secret, response: token, remoteip: ip || '' }) });
    return !!(await r.json()).success;
  } catch (_) { return false; }
}

const leadSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name.').max(100),
  email: z.string().trim().email('Please enter a valid email address.').max(200),
  clinic: z.string().trim().min(2, 'Please enter your practice name.').max(150),
  phone: z.string().trim().max(30).regex(/^[\d\s()+.-]*$/, 'Phone numbers can only include digits and + ( ) - .').optional().or(z.literal('')),
  message: z.string().trim().max(1000).optional().or(z.literal('')),
  consent: z.literal(true, { errorMap: () => ({ message: 'Please agree to be contacted so we can respond.' }) }),
  website: z.string().max(200).optional(), // honeypot: real people never see or fill this
  t: z.string().max(100).optional(),
  turnstile: z.string().max(2000).optional(),
});

router.post('/lead', sec.limits.lead, async (req, res) => {
  const parsed = leadSchema.safeParse(req.body || {});
  if (!parsed.success) {
    const fields = {};
    for (const i of parsed.error.issues) fields[i.path[0]] = fields[i.path[0]] || i.message;
    return res.status(400).json({ error: 'Please fix the highlighted fields.', fields });
  }
  const d = parsed.data;
  // Bots fill every field. Pretend success so they learn nothing.
  if (d.website) return res.json({ ok: true });
  const tokenProblem = checkFormToken(d.t);
  if (tokenProblem === 'too_fast') return res.status(429).json({ error: 'That was very fast. Please wait a moment and submit again.' });
  if (tokenProblem) return res.status(400).json({ error: 'Your form expired. Please refresh the page and try again.' });
  if (!(await verifyTurnstile(d.turnstile, req.ip))) return res.status(400).json({ error: 'Please complete the human check.' });
  const dup = db.prepare("SELECT 1 FROM leads WHERE email=? AND created_at>?").get(d.email.toLowerCase(), new Date(Date.now() - 600000).toISOString());
  if (dup) return res.json({ ok: true });
  db.prepare('INSERT INTO leads (id,name,email,clinic,phone,message,source,ip_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(uid(), d.name, d.email.toLowerCase(), d.clinic, d.phone || null, d.message || null, 'website', hmac(req.ip || ''), nowIso());
  core.audit({ actor: 'website', action: 'lead_created', resource: 'lead', detail: { clinic: d.clinic } });
  res.json({ ok: true });
});

// ---------- Embeddable chat widget API
const startSchema = z.object({ widget_key: z.string().min(5).max(80), session_id: z.string().max(80).optional() });
const msgSchema = z.object({ widget_key: z.string().min(5).max(80), conversation_id: z.string().min(10).max(80), message: z.string().min(1).max(1000) });

router.post('/chat/start', sec.limits.chatStart, (req, res) => {
  const p = startSchema.safeParse(req.body || {});
  if (!p.success) return res.status(400).json({ error: 'Invalid request' });
  const loc = core.getLocationByWidgetKey(p.data.widget_key);
  if (!loc) return res.status(404).json({ error: 'Unknown widget' });
  const session = p.data.session_id || crypto.randomUUID();
  const r = conversations.start({ locationId: loc.id, channel: 'chat', externalId: `web:${session}`, resumeWithinMin: 30 });
  res.json({ conversation_id: r.conversation.id, session_id: session, greeting: r.greeting, resumed: r.resumed, clinic: loc.name, agent: loc.settings.agent_name });
});

router.post('/chat/message', sec.limits.chat, async (req, res) => {
  const p = msgSchema.safeParse(req.body || {});
  if (!p.success) return res.status(400).json({ error: 'Invalid request' });
  const loc = core.getLocationByWidgetKey(p.data.widget_key);
  const conv = loc && conversations.getConversation(p.data.conversation_id);
  if (!conv || conv.location_id !== loc.id || conv.channel !== 'chat') return res.status(404).json({ error: 'Conversation not found' });
  try {
    const r = await conversations.turn({ conversationId: conv.id, text: p.data.message });
    res.json({ reply: r.reply, ended: r.ended });
  } catch (e) { console.error('[chat]', e); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

// ---------- Consent-gated first-party analytics beacon (no cookies, no IPs stored)
const collectSchema = z.object({ path: z.string().max(200), referrer: z.string().max(300).optional(), session: z.string().max(40).optional(), consent: z.literal(true) });
router.post('/collect', sec.limits.collect, (req, res) => {
  const p = collectSchema.safeParse(req.body || {});
  if (!p.success) return res.status(204).end(); // no consent flag: store nothing
  const ua = String(req.headers['user-agent'] || '');
  const device = /bot|crawl|spider/i.test(ua) ? 'bot' : /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop';
  if (device === 'bot') return res.status(204).end();
  let ref = null; try { ref = p.data.referrer ? new URL(p.data.referrer).hostname : null; } catch (_) { /* ignore */ }
  db.prepare('INSERT INTO web_events (id,path,referrer,device,session,ts) VALUES (?,?,?,?,?,?)').run(uid(), p.data.path.split('?')[0], ref, device, p.data.session || null, nowIso());
  res.status(204).end();
});

module.exports = router;
