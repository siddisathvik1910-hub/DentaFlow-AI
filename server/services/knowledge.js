// Knowledge base: ingestion, BM25 retrieval (RAG without an external vector DB), structured facts, safe crawling.
const dns = require('dns').promises;
const net = require('net');
const { db, uid, nowIso } = require('../db');
const core = require('./core');
const tz = require('../tz');

const STOP = new Set('a an the and or of to in on at for with is are was were be been it this that do does did you your we our i me my can could would should will what when where how which who whom why from by as if about any have has had there their they them us please tell know want need like just get so than then also not no yes'.split(' '));
const tokenize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s'$%.-]/g, ' ').split(/\s+/).map((w) => w.replace(/^[.'-]+|[.'-]+$/g, '')).filter((w) => w && !STOP.has(w));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, (m) => (w.length > 5 ? '' : m));

function chunkText(text, max = 600) {
  const paras = String(text).split(/\n{2,}|\r\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  for (const p of paras) {
    if (p.length <= max) { chunks.push(p); continue; }
    let cur = '';
    for (const s of p.split(/(?<=[.!?])\s+/)) {
      if ((cur + ' ' + s).length > max && cur) { chunks.push(cur.trim()); cur = s; } else cur += ' ' + s;
    }
    if (cur.trim()) chunks.push(cur.trim());
  }
  return chunks;
}

function addDoc({ tenantId, locationId, title, content, source_type = 'text', source_url = null }) {
  const id = uid();
  db.prepare('INSERT INTO knowledge_docs (id,tenant_id,location_id,title,source_type,source_url,content,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, tenantId, locationId, title, source_type, source_url, content, nowIso());
  indexDoc(id, tenantId, locationId, content, source_type === 'canonical' ? title : null);
  return id;
}
function indexDoc(docId, tenantId, locationId, content, prefix) {
  db.prepare('DELETE FROM knowledge_chunks WHERE doc_id=?').run(docId);
  const ins = db.prepare('INSERT INTO knowledge_chunks (id,doc_id,tenant_id,location_id,text) VALUES (?,?,?,?,?)');
  for (const c of chunkText(content)) ins.run(uid(), docId, tenantId, locationId, prefix ? `${prefix} ${c}` : c);
}
function updateDoc(id, { title, content, active }) {
  const d = db.prepare('SELECT * FROM knowledge_docs WHERE id=?').get(id);
  if (!d) return null;
  db.prepare('UPDATE knowledge_docs SET title=?, content=?, active=?, version=version+1 WHERE id=?')
    .run(title ?? d.title, content ?? d.content, active === undefined ? d.active : (active ? 1 : 0), id);
  indexDoc(id, d.tenant_id, d.location_id, content ?? d.content, d.source_type === 'canonical' ? (title ?? d.title) : null);
  return db.prepare('SELECT * FROM knowledge_docs WHERE id=?').get(id);
}
const deleteDoc = (id) => db.prepare('DELETE FROM knowledge_docs WHERE id=?').run(id);

// ---------- Retrieval (BM25) ----------
function search(locationId, query, k = 3) {
  const rows = db.prepare(`SELECT c.id, c.text, d.title, d.source_type FROM knowledge_chunks c JOIN knowledge_docs d ON d.id=c.doc_id
                           WHERE c.location_id=? AND d.active=1`).all(locationId);
  const q = [...new Set(tokenize(query).map(stem))];
  if (!rows.length || !q.length) return [];
  const docs = rows.map((r) => { const toks = tokenize(r.text + ' ' + r.title).map(stem); return { r, toks, len: toks.length }; });
  const avg = docs.reduce((a, d) => a + d.len, 0) / docs.length || 1;
  const df = {};
  for (const t of q) df[t] = docs.filter((d) => d.toks.includes(t)).length;
  const N = docs.length, k1 = 1.4, b = 0.75;
  const scored = docs.map((d) => {
    let score = 0, matched = 0;
    for (const t of q) {
      const tf = d.toks.filter((x) => x === t).length;
      if (!tf) continue;
      matched++;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (d.len / avg))));
    }
    if (d.r.source_type === 'canonical') score *= 1.5; // staff-pinned answers win
    return { text: d.r.text, title: d.r.title, source_type: d.r.source_type, score, matched, coverage: matched / q.length };
  }).filter((s) => s.score > 0).sort((a, b2) => b2.score - a.score);
  return scored.slice(0, k);
}

function bestSentences(text, query, n = 2) {
  const q = new Set(tokenize(query).map(stem));
  const sents = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const scored = sents.map((s, i) => ({ s, i, o: tokenize(s).map(stem).filter((w) => q.has(w)).length }));
  const picked = scored.filter((x) => x.o > 0).sort((a, b) => b.o - a.o).slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.s);
  return (picked.length ? picked : sents.slice(0, n)).join(' ');
}

// ---------- Structured facts (always preferred over semantic search) ----------
function structuredAnswer(loc, query) {
  const q = query.toLowerCase();
  if (/\b(hours?|open|close|closing|opening|when are you)\b/.test(q) && !/appointment|book|schedule/.test(q.replace(/open (an )?appointment/, ''))) {
    return { topic: 'hours', text: `Our hours are ${core.hoursSpoken(loc)}.` };
  }
  if (/\b(address|where are you|located|location|directions|how do i get)\b/.test(q)) {
    return { topic: 'address', text: loc.address ? `We're located at ${loc.address}.` : null };
  }
  if (/\b(phone number|call you|contact number|number to call)\b/.test(q)) {
    return { topic: 'phone', text: loc.phone ? `You can reach the office at ${loc.phone}.` : null };
  }
  if (/\b(insurance|insured|coverage|delta|cigna|aetna|metlife|guardian|humana|united ?healthcare|in.?network|ppo|hmo|medicaid)\b/.test(q)) {
    const list = loc.settings.accepted_insurance || [];
    const named = list.find((n) => q.includes(n.toLowerCase().split(' ')[0].toLowerCase()));
    if (named) return { topic: 'insurance', text: `Yes, we work with ${named} plans. Our team will verify your specific benefits before your visit, and I can't promise coverage amounts.` };
    if (list.length) return { topic: 'insurance', text: `We work with ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}. If your plan isn't listed, our team can check for you. I can't promise specific coverage amounts, our team verifies benefits before treatment.` };
  }
  if (/\bemergenc(y|ies)\b|after hours/.test(q) && /(policy|how|what|do you|see)/.test(q)) {
    return { topic: 'emergency', text: 'If you have a dental emergency we will try to see you the same day. If you have trouble breathing or swallowing, uncontrolled bleeding, or serious facial swelling or injury, please call 911 or go to the nearest emergency room.' };
  }
  return null;
}

// Returns {text, source, confidence, topic}; logs unanswered questions
function answer(loc, query, conversationId = null) {
  const s = structuredAnswer(loc, query);
  if (s && s.text) return { text: s.text, source: 'clinic_facts', confidence: 1, topic: s.topic };
  const hits = search(loc.id, query, 3);
  const top = hits[0];
  const strong = top && top.score >= 1.6 && (top.coverage >= 0.34);
  if (strong) {
    return { text: bestSentences(top.text, query, 2), source: top.source_type === 'canonical' ? 'canonical' : top.title, confidence: Math.min(1, top.score / 6), topic: 'kb', chunks: hits.map((h) => h.text) };
  }
  db.prepare('INSERT INTO unanswered_questions (id,tenant_id,location_id,question,conversation_id,ts) VALUES (?,?,?,?,?,?)')
    .run(uid(), loc.tenant_id, loc.id, String(query).slice(0, 300), conversationId, nowIso());
  return { text: null, source: null, confidence: 0, topic: 'unknown', chunks: [] };
}

// ---------- Safe website crawl (SSRF protected) ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l === '::'; }
  return true;
}
async function assertPublicUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('URL points to a private or unreachable address');
  return u;
}
function htmlToText(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  const body = html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|section|article|tr|br)>/gi, '\n\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
  return { title: title.replace(/\s+/g, ' ').trim(), text: body };
}
async function crawl({ tenantId, locationId, url }) {
  const u = await assertPublicUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(u, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': 'DentaFlowBot/1.0' } });
    if (res.status >= 300 && res.status < 400) throw new Error('Redirects are not followed; use the final URL');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = (await res.text()).slice(0, 1_500_000);
    const { title, text } = htmlToText(html);
    if (text.length < 40) throw new Error('No readable text found on that page');
    return addDoc({ tenantId, locationId, title: title || u.hostname, content: text.slice(0, 40000), source_type: 'crawl', source_url: u.toString() });
  } finally { clearTimeout(timer); }
}

module.exports = { addDoc, updateDoc, deleteDoc, search, answer, structuredAnswer, crawl, chunkText, tokenize, assertPublicUrl, htmlToText };
