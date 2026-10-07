#!/usr/bin/env node
// Crawls the site from "/" and reports broken links, missing assets and missing in-page anchors.
// Usage: npm run check-links            (starts a local copy)
//        AUDIT_REMOTE=1 BASE_URL=https://yoursite.com npm run check-links
const boot = require('./_boot');
(async () => {
  const { base, close } = await boot();
  const seen = new Set(); const queue = ['/']; const bad = []; const ids = {}; const anchors = [];
  const external = new Set();
  while (queue.length) {
    const p = queue.shift(); if (seen.has(p)) continue; seen.add(p);
    const r = await fetch(base + p, { redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) { bad.push(`${p} redirects (${r.status}) to ${r.headers.get('location')}`); continue; }
    if (r.status !== 200) { bad.push(`${p} -> HTTP ${r.status}`); continue; }
    if (!(r.headers.get('content-type') || '').includes('text/html')) continue;
    const html = await r.text();
    ids[p] = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const u = m[1];
      if (/^https?:/.test(u)) { external.add(u); continue; }
      if (/^(mailto:|tel:|data:|javascript:)/.test(u)) continue;
      const [pathPart, hash] = u.split('#');
      const target = pathPart || p;
      if (hash) anchors.push([p, target, hash]);
      if (!seen.has(target)) queue.push(target);
    }
  }
  for (const [from, target, hash] of anchors) {
    if (!ids[target]) continue; // non-HTML target
    if (!ids[target].has(hash)) bad.push(`${from}: link to ${target}#${hash} but #${hash} does not exist`);
  }
  console.log(`Crawled ${seen.size} internal URLs; ${anchors.length} anchors checked; ${external.size} external links not followed.`);
  if (external.size) console.log('External links:', [...external].join(', '));
  if (bad.length) { console.log('\nBROKEN:\n - ' + bad.join('\n - ')); await close(); process.exit(1); }
  console.log('No broken links.'); await close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
