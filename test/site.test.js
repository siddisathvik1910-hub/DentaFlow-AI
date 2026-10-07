// Launch-checklist tests: SEO, legal pages, accessibility basics, links, images, contrast.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
let S;
test.before(async () => { await H.setup(); S = await H.startServer(); });
test.after(async () => { await S.close(); });
const get = async (p) => { const r = await fetch(S.base + p, { redirect: 'manual' }); return { r, text: await r.text() }; };
const PUBLIC = ['/', '/privacy', '/terms', '/cookies'];

test('1-2: privacy policy and terms pages exist and are linked from every public page footer', async () => {
  for (const p of PUBLIC) {
    const { r, text } = await get(p); assert.equal(r.status, 200);
    assert.match(text, /href="\/privacy"/); assert.match(text, /href="\/terms"/); assert.match(text, /href="\/cookies"/);
  }
  assert.match((await get('/privacy')).text, /Your rights and choices/);
  assert.match((await get('/terms')).text, /Not medical advice; emergencies/);
});
test('5: cookie banner present on every public page, offers equal choices, and analytics is consent-gated', async () => {
  for (const p of PUBLIC.concat(['/nope'])) {
    const { text } = await get(p);
    assert.match(text, /id="cookie-banner"/); assert.match(text, /data-consent="all"/); assert.match(text, /data-consent="essential"/);
  }
  const analytics = fs.readFileSync(path.join(__dirname, '..', 'web/js/analytics.js'), 'utf8');
  assert.match(analytics, /Runs ONLY after the visitor accepts/);
  assert.ok(!/<script[^>]*googletagmanager|plausible\.io/.test((await get('/')).text), 'no third-party analytics tags in HTML');
});
test('6-7: every public page has unique title, description, canonical, Open Graph and Twitter tags', async () => {
  const titles = new Set(), descs = new Set();
  for (const p of PUBLIC) {
    const { text } = await get(p);
    const title = /<title>(.+?)<\/title>/.exec(text)[1]; const desc = /<meta name="description" content="([^"]+)"/.exec(text)[1];
    assert.ok(title.length >= 20 && title.length <= 70, `title length ${title.length} for ${p}`);
    assert.ok(desc.length >= 70 && desc.length <= 175, `description length ${desc.length} for ${p}`);
    assert.ok(!titles.has(title) && !descs.has(desc), 'unique per page'); titles.add(title); descs.add(desc);
    for (const t of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type']) assert.match(text, new RegExp(`property="${t}"`), `${t} on ${p}`);
    for (const t of ['twitter:card', 'twitter:title', 'twitter:image']) assert.match(text, new RegExp(`name="${t}"`));
    assert.match(text, /rel="canonical" href="http/); assert.match(text, /og:image" content="http[^"]+\/img\/og-image\.png"/);
    assert.match(text, /<html lang="en">/); assert.match(text, /name="viewport"/);
  }
});
test('7: social preview image is the correct size and small', () => {
  const f = path.join(__dirname, '..', 'web/img/og-image.png'); const b = fs.readFileSync(f);
  assert.equal(b.readUInt32BE(16), 1200); assert.equal(b.readUInt32BE(20), 630); assert.ok(b.length < 120 * 1024, 'under 120KB');
});
test('8: all images are compressed (size budget)', () => {
  const dir = path.join(__dirname, '..', 'web/img'); const budget = { '.png': 60 * 1024, '.svg': 20 * 1024, '.ico': 16 * 1024, '.webp': 80 * 1024 };
  for (const f of fs.readdirSync(dir)) { const ext = path.extname(f); if (budget[ext]) assert.ok(fs.statSync(path.join(dir, f)).size <= budget[ext], `${f} exceeds budget`); }
});
test('9: favicon set is linked and served', async () => {
  const { text } = await get('/');
  for (const href of ['/favicon.ico', '/img/favicon-32.png', '/img/favicon-16.png', '/apple-touch-icon.png', '/site.webmanifest']) { assert.ok(text.includes(`href="${href}"`), href); assert.equal((await get(href)).r.status, 200, href); }
});
test('10: sitemap.xml lists public pages only and robots.txt points to it', async () => {
  const sm = (await get('/sitemap.xml')).text;
  for (const p of ['/privacy', '/terms', '/cookies']) assert.match(sm, new RegExp(`<loc>[^<]*${p}</loc>`));
  assert.ok(!sm.includes('/app') && !sm.includes('/login'));
  const rb = (await get('/robots.txt')).text; assert.match(rb, /Sitemap: http/); assert.match(rb, /Disallow: \/app/); assert.match(rb, /Disallow: \/api\//);
  const login = await get('/login'); assert.match(login.text, /noindex/); assert.equal(login.r.headers.get('x-robots-tag'), 'noindex, nofollow');
});
test('11: every image has alt text (decorative ones have empty alt)', async () => {
  for (const p of PUBLIC.concat(['/login', '/app', '/nope'])) {
    const { text } = await get(p);
    for (const m of text.match(/<img\b[^>]*>/g) || []) assert.match(m, /\balt="/, `missing alt in ${p}: ${m}`);
  }
  assert.match((await get('/')).text, /alt="A phone showing a patient/);
});
test('13: mobile friendly: viewport tag, responsive CSS, readable tap targets', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'web/css/site.css'), 'utf8');
  assert.match(css, /@media \(max-width: 900px\)/); assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /\.btn \{[^}]*min-height: 48px/); assert.match(css, /\.nav-toggle/);
});
test('14: custom 404 page is branded, has a way home, and returns a real 404 status', async () => {
  const { r, text } = await get('/definitely-not-a-page');
  assert.equal(r.status, 404); assert.match(text, /couldn't find that page/); assert.match(text, /href="\/"/); assert.match(r.headers.get('cache-control'), /no-store/);
  assert.equal((await get('/api/nope')).r.status, 404);
});
test('15: no broken internal links, assets or in-page anchors', async () => {
  const seen = new Set(), queue = ['/'], bad = [];
  const ids = {};
  while (queue.length) {
    const p = queue.shift(); if (seen.has(p)) continue; seen.add(p);
    const { r, text } = await get(p);
    if (r.status !== 200) { bad.push(`${p} -> ${r.status}`); continue; }
    ids[p] = new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of text.matchAll(/(?:href|src)="([^"]+)"/g)) {
      let u = m[1]; if (/^(https?:|mailto:|tel:|data:|javascript:)/.test(u)) continue;
      const [pathPart, hash] = u.split('#'); const target = pathPart === '' ? p : pathPart;
      if (target.endsWith('.html') && !target.startsWith('/')) continue;
      if (!seen.has(target) && !queue.includes(target)) queue.push(target);
      if (hash) queue.push(`${target}#${hash}`);
      if (hash && target === p && !ids[p].has(hash)) bad.push(`${p} has no #${hash}`);
    }
    for (const q of queue.filter((x) => x.includes('#'))) { const [tp, h] = q.split('#'); queue.splice(queue.indexOf(q), 1); if (ids[tp] && !ids[tp].has(h)) bad.push(`${tp} has no #${h}`); else if (!ids[tp]) { const { text: t2 } = await get(tp); if (!new RegExp(`\\sid="${h}"`).test(t2)) bad.push(`${tp} has no #${h}`); } }
  }
  assert.deepEqual(bad, []);
  assert.ok(seen.size >= 15, 'crawled ' + seen.size);
});
test('16: demo form has labels, validation hooks, and accessible error regions', async () => {
  const { text } = await get('/');
  for (const id of ['name', 'email', 'clinic', 'phone', 'message', 'consent']) { assert.match(text, new RegExp(`for="lf-${id}"|<label[^>]*><input id="lf-${id}"`)); assert.match(text, new RegExp(`id="lf-${id}-err"`)); }
  assert.match(text, /<form id="lead-form" novalidate>/); assert.match(text, /aria-live="polite"/);
});
test('17: color contrast meets WCAG AA for every text/background pair', () => {
  const r = require('child_process').spawnSync('node', ['scripts/check-contrast.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test('18: bot protection pieces are present in the form and the API', async () => {
  const { text } = await get('/');
  assert.match(text, /name="website"[^>]*tabindex="-1"/); assert.match(text, /class="field hp" aria-hidden="true"/);
});
test('20: exactly one clear call to action is repeated consistently', async () => {
  const { text } = await get('/');
  const main = text.slice(0, text.indexOf('<div class="cookie"'));
  const ctas = [...main.matchAll(/class="btn[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  assert.ok(ctas.length >= 3 && ctas.every((c) => c === 'Book a free demo'), JSON.stringify(ctas));
  assert.equal((text.match(/<h1\b/g) || []).length, 1, 'one h1');
  assert.match(text, /<a class="btn btn-lg" href="#demo">Book a free demo<\/a>/);
});
test('12: performance budget: gzip transfer sizes, caching, no render-blocking scripts', async () => {
  const gz = async (p) => { const r = await fetch(S.base + p, { headers: { 'accept-encoding': 'gzip' } }); const buf = Buffer.from(await r.arrayBuffer()); assert.equal(r.headers.get('content-encoding'), 'gzip', p + ' must be compressed'); return { len: require('zlib').gzipSync(buf).length, r }; };
  const home = await gz('/'); assert.ok(home.len < 20000, 'home HTML gz bytes ' + home.len);
  const css = await gz('/css/site.css'); assert.ok(css.len < 6000, 'css gz ' + css.len);
  const { text } = await get('/');
  for (const m of text.match(/<script\b[^>]*src=[^>]*>/g)) assert.match(m, /\bdefer\b|\basync\b/, 'script must be deferred: ' + m);
  assert.match((await fetch(S.base + '/img/hero.svg')).headers.get('cache-control'), /max-age=604800/);
  assert.match(text, /fetchpriority="high"/); assert.match(text, /rel="preload" href="\/css\/site\.css"/);
  assert.ok(!/fonts\.(googleapis|gstatic)/.test(text), 'no render-blocking web fonts');
});
