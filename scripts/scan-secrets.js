#!/usr/bin/env node
// Verifies no secrets can reach the browser: scans everything under web/ and the live public config,
// and confirms .env / data are git-ignored and never served.
const fs = require('fs'), path = require('path');
const boot = require('./_boot');
const root = path.join(__dirname, '..');
const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, 'Anthropic API key'], [/sk_(live|test)_[A-Za-z0-9]{10,}/, 'Stripe secret key'], [/AC[a-f0-9]{32}/, 'Twilio Account SID'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'Private key'], [/(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{16,}['"]/i, 'Hard-coded credential'],
  [/process\.env/, 'server env access in browser code'], [/ANTHROPIC_API_KEY|TWILIO_AUTH_TOKEN|STRIPE_SECRET_KEY|JWT_SECRET|ENCRYPTION_KEY/, 'secret variable name in browser code'],
];
let failed = 0;
function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); }
for (const f of walk(path.join(root, 'web'))) {
  if (/\.(png|ico|webp|jpg)$/.test(f)) continue;
  const txt = fs.readFileSync(f, 'utf8');
  for (const [re, name] of PATTERNS) if (re.test(txt)) { failed++; console.log(`FAIL ${path.relative(root, f)}: ${name}`); }
}
const gi = fs.existsSync(path.join(root, '.gitignore')) ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8') : '';
for (const need of ['.env', 'data/']) if (!gi.split('\n').some((l) => l.trim() === need || l.trim() === need.replace(/\/$/, ''))) { failed++; console.log(`FAIL .gitignore does not list ${need}`); }
(async () => {
  const { base, close } = await boot();
  const cfgRes = await (await fetch(base + '/api/public/config')).json();
  const allowed = ['ga4', 'plausibleDomain', 'turnstileSiteKey', 'demoWidgetKey'];
  for (const k of Object.keys(cfgRes)) if (!allowed.includes(k)) { failed++; console.log('FAIL public config exposes unexpected key: ' + k); }
  for (const p of ['/.env', '/.env.example', '/server/config.js', '/data/dentaflow.db', '/package.json', '/.git/config']) {
    const r = await fetch(base + p, { redirect: 'manual' }); if (r.status === 200) { failed++; console.log('FAIL served: ' + p); }
  }
  await close();
  console.log(failed ? `\n${failed} problem(s) found.` : 'OK: no secrets in browser code, public config is whitelisted, sensitive files are not served.');
  process.exit(failed ? 1 : 0);
})();
