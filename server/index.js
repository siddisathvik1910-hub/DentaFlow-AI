const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const cfg = require('./config');
const sec = require('./middleware/security');
const pages = require('./pages');
const core = require('./services/core');

const WEB = path.join(__dirname, '..', 'web');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);

  app.use(sec.forceHttps);
  app.use(sec.headers());
  app.use(compression({ filter: (req, res) => { if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false; return compression.filter(req, res); } }));
  app.use(cookieParser());

  // ---- Health (no auth, no secrets)
  app.get('/healthz', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  // ---- SEO files (10)
  app.get('/sitemap.xml', (req, res) => res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(pages.sitemapXml()));
  app.get('/robots.txt', (req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(pages.robotsTxt()));

  // ---- Webhooks (own body parser + signature check)
  app.use('/webhooks/twilio', require('./routes/webhooks'));

  // ---- JSON APIs
  app.use('/api', express.json({ limit: '100kb' }));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/public', require('./routes/public'));
  app.use('/api/v1', require('./routes/dashboard'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- Static assets (12: long cache for images, short for css/js; compressed above)
  const staticOpts = (maxAge) => ({ maxAge, etag: true, index: false, setHeaders: (res) => res.setHeader('Cache-Control', `public, max-age=${Math.floor(maxAge / 1000)}${maxAge >= 86400000 ? ', immutable' : ', must-revalidate'}`) });
  app.use('/img', express.static(path.join(WEB, 'img'), staticOpts(7 * 86400000)));
  app.use('/css', express.static(path.join(WEB, 'css'), staticOpts(3600000)));
  app.use('/js', express.static(path.join(WEB, 'js'), staticOpts(3600000)));
  for (const f of ['favicon.ico', 'apple-touch-icon.png', 'site.webmanifest']) app.get('/' + f, (req, res) => res.sendFile(path.join(WEB, 'img', f), { maxAge: 86400000 }));

  // ---- Pages
  for (const p of pages.PAGES) {
    app.get(p.path, (req, res) => {
      res.set('Cache-Control', p.noindex ? 'no-store' : 'public, max-age=300');
      if (p.noindex) res.set('X-Robots-Tag', 'noindex, nofollow');
      res.type('html').send(pages.render(p));
    });
  }
  app.get('/index.html', (req, res) => res.redirect(301, '/'));

  // ---- Custom 404 (14)
  app.use((req, res) => {
    res.status(404).set('Cache-Control', 'no-store').type('html').send(pages.render(pages.NOT_FOUND));
  });
  // ---- Error handler (never leaks stack traces)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.status && err.status < 500 && req.path.startsWith('/api')) return res.status(err.status).json({ error: err.message });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    console.error('[error]', err);
    if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Something went wrong.' });
    res.status(500).type('text/plain').send('Something went wrong.');
  });
  return app;
}

// ---- Background worker: reminders, offer expiry, queued campaign sends, idle conversation wrap-up
function startWorker() {
  const reminders = require('./services/reminders');
  const waitlist = require('./services/waitlist');
  const campaigns = require('./services/campaigns');
  const conversations = require('./services/conversations');
  const scheduling = require('./services/scheduling');
  const tick = () => {
    try {
      reminders.runDue(); reminders.flagUnconfirmed(); waitlist.expireOffers(); campaigns.processQueued();
      conversations.endIdle(20); scheduling.cleanHolds();
    } catch (e) { console.error('[worker]', e); }
  };
  const t = setInterval(tick, 30000);
  t.unref();
  return t;
}

async function main() {
  const { seedDemo } = require('./seed');
  if (cfg.seedDemo) { const made = await seedDemo(); if (made) console.log(`Demo data created. Sign in: demo@brightsmile.test / ${cfg.demoPassword}`); }
  const app = createApp();
  startWorker();
  app.listen(cfg.port, () => {
    console.log(`\nDentaFlow AI running at ${cfg.baseUrl}`);
    console.log(`  Website:    ${cfg.baseUrl}/`);
    console.log(`  Dashboard:  ${cfg.baseUrl}/app`);
    console.log(`  AI engine:  ${cfg.anthropic.key ? 'Claude (' + cfg.anthropic.model + ')' : 'built-in (add ANTHROPIC_API_KEY to use Claude)'}`);
    console.log(`  SMS/voice:  ${cfg.twilio.sid ? 'Twilio' : 'simulated (add Twilio keys to go live)'}\n`);
  });
}

module.exports = { createApp, startWorker };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
