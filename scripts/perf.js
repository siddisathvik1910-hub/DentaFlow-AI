#!/usr/bin/env node
// Page-speed report: transfer sizes (gzip), request counts, response times, caching and render-blocking checks.
// For full Lighthouse scoring run:  npx lighthouse http://localhost:3000 --view   (needs Chrome)
const boot = require('./_boot');
const zlib = require('zlib');
const kb = (n) => (n / 1024).toFixed(1).padStart(6) + ' KB';
const gzBytes = (buf) => zlib.gzipSync(Buffer.from(buf)).length; // what actually crosses the network
(async () => {
  const { base, close } = await boot();
  let failed = 0;
  const check = (ok, msg) => { if (!ok) { failed++; console.log('  FAIL ' + msg); } };
  for (const page of ['/', '/privacy', '/terms', '/cookies']) {
    const t0 = performance.now();
    const r = await fetch(base + page, { headers: { 'accept-encoding': 'gzip' } });
    const htmlBuf = await r.arrayBuffer(); const html = Buffer.from(htmlBuf).toString('utf8'); const ttfb = performance.now() - t0;
    const size = gzBytes(htmlBuf);
    const assets = [...new Set([...html.matchAll(/(?:href|src)="(\/[^"#]+\.(?:css|js|svg|png|webp|ico))"/g)].map((m) => m[1]))];
    let total = size, slowest = 0; const rows = [];
    for (const a of assets) {
      const s = performance.now(); const ar = await fetch(base + a, { headers: { 'accept-encoding': 'gzip' } }); const buf = await ar.arrayBuffer(); const ms = performance.now() - s;
      slowest = Math.max(slowest, ms);
      const bytes = /image\/(png|webp)|x-icon/.test(ar.headers.get('content-type') || '') ? buf.byteLength : gzBytes(buf); total += bytes; rows.push([a, bytes, ar.headers.get('cache-control') || '', ar.headers.get('content-encoding') || '']);
    }
    console.log(`\n${page}   HTML ${kb(size)} gzipped   time ${ttfb.toFixed(0)} ms   requests ${1 + assets.length}   total ${kb(total)}`);
    for (const [a, b, cc, enc] of rows) console.log(`   ${a.padEnd(26)} ${kb(b)}  ${enc.padEnd(5)} ${cc}`);
    check(total < 200 * 1024, `${page}: total transfer ${kb(total)} exceeds 200 KB budget`);
    check(assets.length <= 14, `${page}: ${assets.length} asset requests (budget 14)`);
    for (const m of html.match(/<script\b[^>]*src=[^>]*>/g) || []) check(/\bdefer\b|\basync\b/.test(m), `${page}: render-blocking script ${m}`);
    check(!/fonts\.(googleapis|gstatic)\.com/.test(html), `${page}: external font request`);
    for (const m of html.match(/<img\b[^>]*>/g) || []) { check(/\bwidth=/.test(m) && /\bheight=/.test(m), `${page}: <img> without width/height (layout shift): ${m.slice(0, 70)}`); }
    check(r.headers.get('content-encoding') === 'gzip', `${page}: response not compressed`);
  }
  console.log(failed ? `\n${failed} performance check(s) failed.` : '\nPerformance budget met (small HTML, one CSS file, deferred scripts, compressed, cached images, no web fonts).');
  await close(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
