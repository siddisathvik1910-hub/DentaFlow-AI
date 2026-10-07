/* DentaFlow AI dashboard (vanilla JS, no build step, CSP-safe: no inline handlers or styles).
   Core + Today / Calls / Tasks / Appointments / Patients. Settings, Knowledge, Analytics etc. live in app2.js. */
(function () {
  'use strict';
  const state = { me: null, locationId: null, tz: 'America/New_York', tasksOpen: 0, route: null };
  const routes = {};
  const DF = (window.DF = { state, routes });

  // ------------------------------------------------------------------ tiny DOM helper
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let deferredValue;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') deferredValue = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'disabled' || k === 'hidden' || k === 'required' || k === 'selected' || k === 'multiple') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) { if (kid === null || kid === undefined || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
    if (deferredValue !== undefined) el.value = deferredValue;
    return el;
  }
  const $ = (s, r) => (r || document).querySelector(s);
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  DF.h = h; DF.$ = $; DF.clear = clear;

  // ------------------------------------------------------------------ API
  async function api(path, opts) {
    opts = opts || {};
    const url = new URL('/api/v1' + path, location.origin);
    if (state.locationId) url.searchParams.set('location_id', state.locationId);
    for (const [k, v] of Object.entries(opts.qs || {})) if (v !== undefined && v !== '' && v !== null) url.searchParams.set(k, v);
    const res = await fetch(url, { method: opts.method || 'GET', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'DentaFlow' }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    if (res.status === 401) { location.replace('/login'); throw new Error('Signed out'); }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw Object.assign(new Error((data && data.error) || 'Request failed'), { status: res.status, data });
    return data;
  }
  async function authApi(path, body) {
    const res = await fetch('/api/auth' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'DentaFlow' }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  DF.api = api; DF.authApi = authApi;

  // ------------------------------------------------------------------ formatting
  const dtf = (opts) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: state.tz }, opts));
  const fmt = (iso) => (iso ? dtf({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '');
  const fmtDay = (iso) => dtf({ weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
  const fmtTime = (iso) => dtf({ hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
  const pct = (x) => (x === null || x === undefined ? 'n/a' : Math.round(x * 100) + '%');
  const ago = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; if (m < 1440) return Math.round(m / 60) + ' h ago'; return Math.round(m / 1440) + ' d ago'; };
  const todayStr = (offset) => { const d = new Date(Date.now() + (offset || 0) * 86400000); return new Intl.DateTimeFormat('en-CA', { timeZone: state.tz }).format(d); };
  const OUTCOME = { booked: ['Booked', 'ok'], rescheduled: ['Rescheduled', 'ok'], cancelled: ['Cancelled', 'warn'], emergency_911: ['Emergency: 911', 'bad'], handoff: ['Transferred', 'info'], callback: ['Needs callback', 'warn'], faq: ['Answered', 'info'], waitlisted: ['Waitlisted', 'info'], no_action: ['No action', ''] };
  const tag = (text, kind) => h('span', { class: 'tag' + (kind ? ' ' + kind : '') }, text);
  const outcomeTag = (o, active) => (active ? tag('In progress', 'info') : (OUTCOME[o] ? tag(OUTCOME[o][0], OUTCOME[o][1]) : tag(o || 'No action')));
  const urgencyTag = (u) => (u === 'urgent' || u === 'life_threatening' ? tag(u === 'life_threatening' ? 'Emergency' : 'Urgent', 'bad') : u === 'high' ? tag('High', 'warn') : null);
  const chan = (c) => ({ voice: 'Phone', sms: 'Text', chat: 'Web chat' }[c] || c);
  Object.assign(DF, { fmt, fmtDay, fmtTime, money, pct, ago, todayStr, tag, outcomeTag, urgencyTag, chan });

  // ------------------------------------------------------------------ toasts & dialogs
  function toast(msg, kind) {
    const t = h('div', { class: 'toast ' + (kind || '') }, msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3800);
  }
  function modal(opts) {
    const dlg = $('#dlg'); clear(dlg);
    const err = h('div', { class: 'alert bad', role: 'alert', hidden: true });
    const close = () => { if (dlg.open) dlg.close(); };
    const body = h('div', { class: 'dlg-body' }, err, opts.body);
    const foot = h('div', { class: 'dlg-foot' }, (opts.actions || [{ label: 'Close', ghost: true }]).map((a) => h('button', {
      type: 'button', class: 'btn sm' + (a.ghost ? ' btn-ghost' : '') + (a.danger ? ' danger' : ''), onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true; err.hidden = true;
        try { const r = a.onclick ? await a.onclick({ close, setError }) : undefined; if (r !== false) close(); } catch (ex) { setError(ex.message); }
        b.disabled = false;
      }
    }, a.label)));
    function setError(m) { err.textContent = m; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); }
    dlg.append(h('div', { class: 'dlg-head' }, h('h2', { id: 'dlg-title' }, opts.title), h('button', { class: 'dlg-x', type: 'button', 'aria-label': 'Close dialog', onclick: close }, '×')), body, foot);
    dlg.showModal();
    return { close, setError };
  }
  const confirmDlg = (message, label) => new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal({ title: 'Please confirm', body: h('p', {}, message), actions: [{ label: 'Cancel', ghost: true, onclick: () => fin(false) }, { label: label || 'Confirm', danger: true, onclick: () => fin(true) }] });
    $('#dlg').addEventListener('close', () => fin(false), { once: true });
  });
  Object.assign(DF, { toast, modal, confirmDlg });

  // ------------------------------------------------------------------ form builder with validation
  function form(fields, initial) {
    initial = initial || {};
    const root = h('div', { class: 'fgrid' });
    const inputs = {};
    fields.forEach((f) => {
      const id = 'f-' + f.key + '-' + Math.random().toString(36).slice(2, 6);
      let val = initial[f.key] !== undefined && initial[f.key] !== null ? initial[f.key] : (f.default !== undefined ? f.default : '');
      if (f.type === 'list' && Array.isArray(val)) val = val.join(', ');
      const base = { id, 'aria-describedby': id + '-e' };
      let input;
      if (f.type === 'select') input = h('select', base, f.options.map((o) => { const v = o.value !== undefined ? o.value : o; return h('option', { value: v, selected: String(v) === String(val) }, o.label || o); }));
      else if (f.type === 'textarea' || f.type === 'list') { input = h('textarea', Object.assign({ rows: f.rows || 3 }, base)); input.value = val; }
      else if (f.type === 'checkbox') input = h('input', Object.assign({ type: 'checkbox', checked: !!val }, base));
      else input = h('input', Object.assign({ type: f.type || 'text', value: val, min: f.min, max: f.max, step: f.step, maxlength: f.maxlength, placeholder: f.placeholder, autocomplete: 'off' }, base));
      const err = h('p', { class: 'err', id: id + '-e' });
      const label = f.type === 'checkbox' ? h('label', { class: 'check' }, input, h('span', {}, f.label)) : h('label', { for: id }, f.label, f.optional ? h('span', { class: 'opt' }, ' (optional)') : null);
      root.append(h('div', { class: 'field' }, label, f.type === 'checkbox' ? null : input, f.help ? h('p', { class: 'help' }, f.help) : null, err));
      inputs[f.key] = { input, err, f };
    });
    function values() {
      const out = {}; let first = null;
      for (const k of Object.keys(inputs)) {
        const { input, err, f } = inputs[k];
        let v = f.type === 'checkbox' ? input.checked : input.value;
        let msg = '';
        if (f.type !== 'checkbox' && typeof v === 'string') v = v.trim();
        if (f.required && (v === '' || v === undefined)) msg = 'This field is required.';
        else if (v !== '' && f.type === 'number') { const n = Number(v); if (Number.isNaN(n)) msg = 'Enter a number.'; else if (f.min !== undefined && n < f.min) msg = `Must be at least ${f.min}.`; else if (f.max !== undefined && n > f.max) msg = `Must be at most ${f.max}.`; v = n; }
        else if (v !== '' && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) msg = 'Enter a valid email address.';
        else if (v !== '' && f.pattern && !new RegExp(f.pattern).test(v)) msg = f.patternMsg || 'Invalid format.';
        if (!msg && f.validate) msg = f.validate(v) || '';
        err.textContent = msg;
        if (msg) { input.setAttribute('aria-invalid', 'true'); if (!first) first = input; } else input.removeAttribute('aria-invalid');
        if (f.type === 'list') v = String(v).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        if (f.type === 'number' && v === '') v = f.nullable ? null : undefined;
        out[k] = v;
      }
      if (first) { first.focus(); return null; }
      return out;
    }
    return { el: root, values, inputs };
  }
  DF.form = form;

  const table = (cols, rows, opts) => {
    opts = opts || {};
    if (!rows.length) return h('div', { class: 'empty' }, opts.empty || 'Nothing here yet.');
    return h('div', { class: 'scroll-x' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, c)))), h('tbody', {}, rows)));
  };
  DF.table = table;

  // ------------------------------------------------------------------ router / shell
  const NAV = [
    ['today', 'Today'], ['calls', 'Calls & chats'], ['tasks', 'Tasks'], ['appointments', 'Appointments'], ['patients', 'Patients'], ['waitlist', 'Waitlist & recall'],
    ['sep', 'Configure'], ['knowledge', 'Knowledge base'], ['settings', 'Settings'], ['test', 'Test the agent'],
    ['sep2', 'Insights'], ['analytics', 'Analytics'], ['messages', 'Messages sent'], ['billing', 'Billing & usage'], ['audit', 'Audit log'],
  ];
  function buildNav() {
    const ul = clear($('#nav-list'));
    NAV.forEach(([key, label]) => {
      if (key.startsWith('sep')) { ul.append(h('li', { class: 'sep', 'aria-hidden': 'true' }, label)); return; }
      ul.append(h('li', {}, h('a', { href: '#/' + key, 'data-nav': key }, label, key === 'tasks' && state.tasksOpen ? h('span', { class: 'badge', 'aria-label': state.tasksOpen + ' open tasks' }, state.tasksOpen) : null)));
    });
    markNav();
  }
  function markNav() { document.querySelectorAll('[data-nav]').forEach((a) => { if (a.getAttribute('data-nav') === (state.route && state.route.name)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }); }

  async function render() {
    const m = /^#\/([\w-]+)(?:\/([\w-]+))?/.exec(location.hash) || [];
    const name = routes[m[1]] ? m[1] : 'today';
    state.route = { name, arg: m[2] || null };
    markNav();
    $('#sidebar').classList.remove('open'); $('#menu-btn').setAttribute('aria-expanded', 'false');
    const view = $('#view');
    try {
      await routes[name].render(clear(view), state.route.arg);
      document.title = `${routes[name].title || 'Dashboard'} | DentaFlow AI`;
    } catch (e) {
      if (e.message === 'Signed out') return;
      clear(view).append(h('div', { class: 'alert bad', role: 'alert' }, 'Could not load this page: ' + e.message), h('button', { class: 'btn sm', type: 'button', onclick: render }, 'Try again'));
    }
  }
  DF.render = render;
  DF.pageHead = (title, sub, actions) => h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null), h('div', { class: 'row' }, actions || []));

  async function refreshTaskBadge() {
    try { const d = await api('/tasks', { qs: { status: 'open' } }); const n = d.tasks.length; if (n !== state.tasksOpen) { state.tasksOpen = n; buildNav(); } } catch (_) { /* ignore */ }
  }
  DF.refreshTaskBadge = refreshTaskBadge;

  let liveTimer = null;
  function connectStream() {
    const es = new EventSource('/api/v1/stream?location_id=' + encodeURIComponent(state.locationId));
    $('#live-pill').hidden = false; $('#live-pill').className = 'pill live';
    const bump = () => { clearTimeout(liveTimer); liveTimer = setTimeout(() => { refreshTaskBadge(); const r = routes[state.route && state.route.name]; if (r && r.live && !document.querySelector('dialog[open]')) render(); }, 500); };
    ['conversation.started', 'conversation.updated', 'conversation.ended', 'task.created', 'task.updated', 'appointment.created', 'appointment.cancelled', 'appointment.rescheduled', 'appointment.confirmed', 'waitlist.offers', 'message.sent'].forEach((t) => es.addEventListener(t, bump));
    es.addEventListener('emergency', (e) => { let d = {}; try { d = JSON.parse(e.data); } catch (_) { /* ignore */ } toast(d.level === 'life_threatening' ? 'Possible medical emergency on a live conversation' : 'Urgent dental issue reported', 'bad'); bump(); });
    es.onerror = () => { $('#live-pill').className = 'pill'; $('#live-pill').textContent = 'Reconnecting…'; };
    es.onopen = () => { $('#live-pill').className = 'pill live'; $('#live-pill').textContent = 'Live'; };
  }

  // ================================================================== TODAY
  routes.today = {
    title: 'Today', live: true,
    async render(v) {
      const d = await api('/overview');
      const k = d.kpi;
      v.append(DF.pageHead('Today', `${state.me.location.name} is ${d.is_open ? 'open' : 'closed'} right now. Last 7 days below.`, [h('a', { class: 'btn sm', href: '#/test' }, 'Try the agent')]));
      const kpi = (val, label, note) => h('div', { class: 'kpi' }, h('div', { class: 'v' }, val), h('div', { class: 'l' }, label), note ? h('div', { class: 'n' }, note) : null);
      v.append(h('div', { class: 'kpis' },
        kpi(k.conversations, 'Calls & chats handled', `${k.after_hours_captured} after hours`),
        kpi(k.appointments_booked, 'Appointments booked by agent', `${k.new_patient_bookings} new patients`),
        kpi(money(k.estimated_production), 'Estimated production', 'Estimate from your type values'),
        kpi(pct(k.containment_rate), 'Resolved without staff', `${pct(k.handoff_rate)} handed off`),
        kpi(d.open_tasks, 'Open tasks', d.attention.length + ' need attention')));
      const attention = h('div', { class: 'panel' }, h('h2', {}, 'Needs attention'));
      if (!d.attention.length) attention.append(h('p', { class: 'muted' }, 'Nothing urgent right now.'));
      d.attention.forEach((t) => attention.append(h('div', { class: 'row' }, urgencyTag(t.urgency), h('a', { href: '#/tasks' }, t.title), h('span', { class: 'muted' }, ago(t.created_at)))));
      const live = h('div', { class: 'panel' }, h('h2', {}, 'Live now'));
      if (!d.live.length) live.append(h('p', { class: 'muted' }, 'No active conversations.'));
      d.live.forEach((c) => live.append(h('div', { class: 'row' }, tag(chan(c.channel), 'info'), h('a', { href: '#/calls/' + c.id }, c.name || c.intent || 'Conversation in progress'), h('span', { class: 'muted' }, ago(c.started_at)))));
      v.append(h('div', { class: 'cols' }, attention, live));
      const appts = h('div', { class: 'panel flush' }, h('h2', {}, "Today's appointments"),
        table(['Time', 'Patient', 'Type', 'Provider', 'Status'], d.today_appointments.map((a) => h('tr', {}, h('td', {}, fmtTime(a.start_utc)), h('td', {}, a.patient_name), h('td', {}, a.type_name), h('td', {}, a.provider_name), h('td', {}, tag(a.status, a.status === 'completed' ? 'ok' : ''), ' ', a.source === 'agent' ? tag('Agent', 'info') : null))), { empty: 'No appointments today.' }));
      v.append(appts);
      v.append(h('div', { class: 'panel flush' }, h('h2', {}, 'Recent conversations'), callsTable(d.recent)));
    },
  };

  function callsTable(rows) {
    return table(['When', 'Channel', 'Outcome', 'Summary', ''], rows.map((c) => h('tr', { class: 'click', onclick: () => { location.hash = '#/calls/' + c.id; } },
      h('td', {}, fmt(c.started_at), c.after_hours ? h('div', {}, tag('After hours', 'info')) : null), h('td', {}, chan(c.channel)), h('td', {}, outcomeTag(c.outcome, c.status === 'active'), ' ', urgencyTag(c.urgency)),
      h('td', {}, c.summary || (c.status === 'active' ? 'Conversation in progress' : '')), h('td', {}, h('a', { href: '#/calls/' + c.id, 'aria-label': 'Open conversation from ' + fmt(c.started_at) }, 'Open')))), { empty: 'No conversations yet. Try the agent from "Test the agent".' });
  }

  // ================================================================== CALLS
  routes.calls = {
    title: 'Calls & chats', live: true,
    async render(v, id) {
      if (id) return callDetail(v, id);
      const qs = Object.fromEntries(new URLSearchParams((location.hash.split('?')[1]) || ''));
      const sel = (name, opts, cur) => h('select', { 'aria-label': 'Filter by ' + name, onchange: (e) => { const p = new URLSearchParams(location.hash.split('?')[1] || ''); if (e.target.value) p.set(name, e.target.value); else p.delete(name); location.hash = '#/calls?' + p.toString(); } }, opts.map(([val, l]) => h('option', { value: val, selected: val === (cur || '') }, l)));
      const search = h('input', { type: 'text', placeholder: 'Search summaries or numbers', 'aria-label': 'Search conversations', value: qs.q || '', onkeydown: (e) => { if (e.key === 'Enter') { const p = new URLSearchParams(location.hash.split('?')[1] || ''); if (e.target.value) p.set('q', e.target.value); else p.delete('q'); location.hash = '#/calls?' + p.toString(); } } });
      const actions = [search, sel('outcome', [['', 'All outcomes'], ['booked', 'Booked'], ['rescheduled', 'Rescheduled'], ['cancelled', 'Cancelled'], ['faq', 'Answered'], ['callback', 'Needs callback'], ['handoff', 'Transferred'], ['emergency_911', 'Emergency']], qs.outcome), sel('channel', [['', 'All channels'], ['voice', 'Phone'], ['sms', 'Text'], ['chat', 'Web chat']], qs.channel)];
      if (['owner', 'manager'].includes(state.me.user.role)) actions.push(h('a', { class: 'btn sm btn-ghost', href: '/api/v1/export/conversations.csv?location_id=' + state.locationId, download: 'conversations.csv' }, 'Export CSV'));
      v.append(DF.pageHead('Calls & chats', 'Every conversation with transcript, actions taken and outcome.', actions));
      const d = await api('/conversations', { qs: { outcome: qs.outcome, channel: qs.channel, q: qs.q, limit: 100 } });
      v.append(h('div', { class: 'panel flush' }, callsTable(d.conversations)), h('p', { class: 'muted' }, `${d.total} conversation${d.total === 1 ? '' : 's'}`));
    },
  };

  async function callDetail(v, id) {
    const c = await api('/conversations/' + id);
    v.append(DF.pageHead(`${chan(c.channel)} conversation`, `${fmt(c.started_at)}${c.from_number ? ' · from ' + c.from_number.slice(0, -4).replace(/\d/g, '•') + c.from_number.slice(-4) : ''}`, [h('a', { class: 'btn sm btn-ghost', href: '#/calls' }, '← All conversations')]));
    const head = h('div', { class: 'panel' },
      h('div', { class: 'row' }, outcomeTag(c.outcome, c.status === 'active'), urgencyTag(c.urgency), c.after_hours ? tag('After hours', 'info') : null, c.handoff ? tag('Handoff', 'warn') : null, tag('Engine: ' + (c.engine || 'n/a')), c.qa_score !== null ? tag('Quality ' + Math.round(c.qa_score * 100) + '%', c.qa_score >= 0.8 ? 'ok' : 'warn') : null),
      h('p', {}, c.summary || 'Summary will appear when the conversation ends.'));
    const fb = h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Was the agent right?'),
      ...['up', 'down'].map((r) => h('button', { type: 'button', class: 'btn sm btn-ghost', 'aria-pressed': String((c.feedback || '').includes('"' + r + '"')), onclick: async () => { await api('/conversations/' + id + '/feedback', { method: 'POST', body: { rating: r } }); toast(r === 'up' ? 'Marked as correct. Thank you.' : 'Flagged for review. Thank you.', 'ok'); } }, r === 'up' ? '👍 Yes' : '👎 No')),
      c.status === 'active' ? h('button', { type: 'button', class: 'btn sm', onclick: async () => { await api('/conversations/' + id + '/end', { method: 'POST' }); render(); } }, 'End conversation') : null);
    head.append(fb);
    v.append(head);
    const chat = h('div', { class: 'chat', role: 'log', 'aria-label': 'Transcript' }, c.messages.map((m) => h('div', { class: 'bubble ' + (m.role === 'agent' ? 'agent' : 'patient') }, m.text, h('small', {}, (m.role === 'agent' ? 'Assistant' : 'Caller') + ' · ' + fmtTime(m.ts)))));
    const side = h('div', {});
    const panel = (t, ...k) => h('div', { class: 'panel' }, h('h2', {}, t), ...k);
    if (c.appointments.length) side.append(panel('Appointments', ...c.appointments.map((a) => h('p', {}, h('strong', {}, a.type_name), h('br'), a.spoken, ' with ', a.provider_name, h('br'), tag(a.status, a.status === 'booked' ? 'ok' : 'warn')))));
    if (c.tasks.length) side.append(panel('Tasks created', ...c.tasks.map((t) => h('p', {}, urgencyTag(t.urgency), ' ', t.title, ' ', tag(t.status)))));
    if (c.triage.length) side.append(panel('Emergency triage', ...c.triage.map((t) => h('p', {}, tag(t.level === 'life_threatening' ? 'Life-threatening' : 'Urgent', 'bad'), ' rule: ', h('code', {}, t.rule), ' → ', t.action))));
    const trace = panel('Agent actions (' + c.tool_calls.length + ')');
    if (!c.tool_calls.length) trace.append(h('p', { class: 'muted' }, 'No tools were called.'));
    c.tool_calls.forEach((t) => trace.append(h('details', {}, h('summary', {}, tag(t.status, t.status === 'ok' ? 'ok' : 'bad'), ' ', h('strong', {}, t.name), ' ', h('span', { class: 'muted' }, t.latency_ms + ' ms')), h('div', { class: 'trace' }, 'args: ' + JSON.stringify(t.args, null, 1), '\n', h('span', { class: t.status === 'ok' ? '' : 'e' }, 'result: ' + JSON.stringify(t.result, null, 1))))));
    side.append(trace);
    v.append(h('div', { class: 'cols' }, h('div', { class: 'panel' }, h('h2', {}, 'Transcript'), chat), side));
  }

  // ================================================================== TASKS
  routes.tasks = {
    title: 'Tasks', live: true,
    async render(v) {
      const cur = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || 'open';
      const sel = h('select', { 'aria-label': 'Task status', onchange: (e) => { location.hash = '#/tasks?status=' + e.target.value; } }, [['open', 'Open'], ['in_progress', 'In progress'], ['done', 'Done'], ['dismissed', 'Dismissed'], ['all', 'All']].map(([val, l]) => h('option', { value: val, selected: val === cur }, l)));
      v.append(DF.pageHead('Tasks', 'Callbacks, insurance checks and follow-ups the agent created for your team.', [sel, h('button', { class: 'btn sm', type: 'button', onclick: addTask }, 'Add task')]));
      const d = await api('/tasks', { qs: { status: cur } });
      const set = async (t, status) => { await api('/tasks/' + t.id, { method: 'PATCH', body: { status } }); toast('Task updated', 'ok'); render(); refreshTaskBadge(); };
      v.append(h('div', { class: 'panel flush' }, table(['Priority', 'Task', 'Patient', 'Created', 'Status', 'Actions'], d.tasks.map((t) => h('tr', {},
        h('td', {}, urgencyTag(t.urgency) || tag('Normal')), h('td', {}, t.title, t.conversation_id ? h('div', {}, h('a', { href: '#/calls/' + t.conversation_id }, 'View conversation')) : null),
        h('td', {}, t.patient_name || ''), h('td', {}, fmt(t.created_at)), h('td', {}, tag(t.status.replace('_', ' '), t.status === 'done' ? 'ok' : '')),
        h('td', {}, h('div', { class: 'row' },
          t.status === 'open' ? h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => set(t, 'in_progress') }, 'Start') : null,
          ['open', 'in_progress'].includes(t.status) ? h('button', { class: 'btn sm', type: 'button', onclick: () => set(t, 'done') }, 'Done') : null,
          ['open', 'in_progress'].includes(t.status) ? h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => set(t, 'dismissed') }, 'Dismiss') : null,
          t.kind === 'verify_insurance' && t.status !== 'done' ? h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: async () => { const r = await api('/tasks/' + t.id + '/run-eligibility', { method: 'POST' }); toast('Eligibility (simulated): ' + r.status.replace(/_/g, ' '), 'ok'); } }, 'Check eligibility') : null)))), { empty: 'No tasks in this view.' })));
    },
  };
  function addTask() {
    const f = form([{ key: 'title', label: 'What needs to be done?', required: true, maxlength: 200 }, { key: 'urgency', label: 'Priority', type: 'select', options: [['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']], default: 'normal' }]);
    modal({ title: 'Add task', body: f.el, actions: [{ label: 'Cancel', ghost: true }, { label: 'Add task', onclick: async () => { const v = f.values(); if (!v) return false; await api('/tasks', { method: 'POST', body: { title: v.title, urgency: v.urgency, kind: 'other' } }); toast('Task added', 'ok'); render(); } }] });
  }

  // ================================================================== APPOINTMENTS
  routes.appointments = {
    title: 'Appointments', live: true,
    async render(v) {
      const p = new URLSearchParams(location.hash.split('?')[1] || '');
      const from = p.get('from') || todayStr(0), to = p.get('to') || todayStr(14);
      const go = () => { location.hash = `#/appointments?from=${$('#ap-from').value}&to=${$('#ap-to').value}`; };
      v.append(DF.pageHead('Appointments', 'Everything on the schedule, including what the agent booked.', [
        h('label', { class: 'muted', for: 'ap-from' }, 'From'), h('input', { id: 'ap-from', type: 'date', value: from, onchange: go }),
        h('label', { class: 'muted', for: 'ap-to' }, 'To'), h('input', { id: 'ap-to', type: 'date', value: to, onchange: go }),
        h('button', { class: 'btn sm', type: 'button', onclick: () => bookDialog() }, 'New appointment')]));
      const d = await api('/appointments', { qs: { from, to } });
      const act = async (path, body, msg) => { try { await api(path, { method: 'POST', body }); toast(msg, 'ok'); render(); } catch (e) { toast(e.message, 'bad'); } };
      v.append(h('div', { class: 'panel flush' }, table(['When', 'Patient', 'Type', 'Provider', 'Status', 'Source', 'Actions'], d.appointments.map((a) => {
        const live = ['booked', 'confirmed'].includes(a.status);
        return h('tr', {}, h('td', {}, fmt(a.start_utc)), h('td', {}, h('a', { href: '#/patients/' + a.patient_id }, a.patient_name)), h('td', {}, a.type_name), h('td', {}, a.provider_name),
          h('td', {}, tag(a.status.replace('_', ' '), a.status === 'completed' || a.status === 'confirmed' ? 'ok' : a.status === 'cancelled' || a.status === 'no_show' ? 'bad' : ''), a.confirmation_status === 'confirmed' && a.status === 'booked' ? [' ', tag('confirmed', 'ok')] : null),
          h('td', {}, a.source === 'agent' ? tag('Agent', 'info') : a.source === 'waitlist' ? tag('Waitlist', 'info') : tag(a.source)),
          h('td', {}, h('div', { class: 'row' },
            live && a.confirmation_status !== 'confirmed' ? h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => act('/appointments/' + a.id + '/confirm', {}, 'Confirmed') }, 'Confirm') : null,
            live ? h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => rescheduleDialog(a) }, 'Move') : null,
            live && new Date(a.start_utc) < new Date() ? [h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => act('/appointments/' + a.id + '/outcome', { status: 'completed' }, 'Marked completed') }, 'Completed'), h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => act('/appointments/' + a.id + '/outcome', { status: 'no_show' }, 'Marked no-show') }, 'No-show')] : null,
            live ? h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { if (await confirmDlg(`Cancel ${a.patient_name}'s ${a.type_name} on ${fmt(a.start_utc)}? The slot will be offered to the waitlist.`, 'Cancel appointment')) act('/appointments/' + a.id + '/cancel', {}, 'Cancelled'); } }, 'Cancel') : null)));
      }), { empty: 'No appointments in this date range.' })));
    },
  };

  async function slotPicker(typeId, patientId) {
    const d = await api('/availability', { qs: { type_id: typeId, patient_id: patientId, limit: 12 } });
    return d;
  }
  async function rescheduleDialog(a) {
    const box = h('div', {}, h('p', {}, `Move ${a.patient_name}'s ${a.type_name} (now ${fmt(a.start_utc)}) to:`), h('div', { class: 'stack', id: 'slots' }, h('p', { class: 'muted' }, 'Loading openings…')));
    const m = modal({ title: 'Reschedule appointment', body: box, actions: [{ label: 'Close', ghost: true }] });
    try {
      const d = await api('/availability', { qs: { type_id: a.type_id, patient_id: a.patient_id, limit: 12 } });
      const holder = clear($('#slots', box));
      if (!d.slots.length) holder.append(h('p', { class: 'muted' }, d.message || 'No openings found.'));
      d.slots.forEach((s) => holder.append(h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: async () => { try { await api('/appointments/' + a.id + '/reschedule', { method: 'POST', body: { slot_id: s.slot_id } }); toast('Appointment moved', 'ok'); m.close(); render(); } catch (e) { m.setError(e.message); } } }, `${s.spoken} · ${s.provider_name}`)));
    } catch (e) { m.setError(e.message); }
  }
  async function bookDialog(preset) {
    const [types, pats] = await Promise.all([api('/appointment-types'), api('/patients')]);
    const f = form([
      { key: 'patient', label: 'Patient', type: 'select', required: true, options: [{ value: '', label: 'Select a patient…' }].concat(pats.patients.map((p) => ({ value: p.id, label: `${p.last_name}, ${p.first_name}` }))), default: preset && preset.patient_id },
      { key: 'type', label: 'Appointment type', type: 'select', required: true, options: [{ value: '', label: 'Select a type…' }].concat(types.types.filter((t) => t.active).map((t) => ({ value: t.id, label: `${t.name} (${t.duration_min} min)` }))) },
    ]);
    const slots = h('div', { class: 'stack' }); let chosen = null;
    const load = async () => {
      const v = f.values(); clear(slots); chosen = null; if (!v) return;
      slots.append(h('p', { class: 'muted' }, 'Finding openings…'));
      try {
        const d = await api('/availability', { qs: { type_id: v.type, patient_id: v.patient, limit: 12 } }); clear(slots);
        if (!d.slots.length) { slots.append(h('p', { class: 'muted' }, d.message || 'No openings found.')); return; }
        slots.append(h('p', {}, h('strong', {}, 'Choose a time')));
        d.slots.forEach((s) => { const b = h('button', { class: 'btn sm btn-ghost', type: 'button', 'aria-pressed': 'false', onclick: () => { chosen = s; slots.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); b.className = 'btn sm'; slots.querySelectorAll('button[aria-pressed=false]').forEach((x) => { x.className = 'btn sm btn-ghost'; }); } }, `${s.spoken} · ${s.provider_name}`); slots.append(b, ' '); });
      } catch (e) { clear(slots).append(h('div', { class: 'alert bad' }, e.message)); }
    };
    f.inputs.patient.input.addEventListener('change', load); f.inputs.type.input.addEventListener('change', load);
    modal({ title: 'New appointment', body: h('div', { class: 'stack' }, f.el, slots), actions: [{ label: 'Cancel', ghost: true }, { label: 'Book', onclick: async ({ setError }) => { const v = f.values(); if (!v) return false; if (!chosen) { setError('Choose a time first.'); return false; } await api('/appointments', { method: 'POST', body: { patient_id: v.patient, slot_id: chosen.slot_id } }); toast('Appointment booked', 'ok'); render(); } }] });
  }
  DF.bookDialog = bookDialog;

  // ================================================================== PATIENTS
  routes.patients = {
    title: 'Patients', live: false,
    async render(v, id) {
      if (id) return patientDetail(v, id);
      const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
      const search = h('input', { type: 'text', placeholder: 'Search by name', 'aria-label': 'Search patients', value: q, onkeydown: (e) => { if (e.key === 'Enter') location.hash = '#/patients?q=' + encodeURIComponent(e.target.value); } });
      v.append(DF.pageHead('Patients', 'Sensitive details are encrypted. Viewing a record is written to the audit log.', [search, h('button', { class: 'btn sm', type: 'button', onclick: addPatient }, 'Add patient')]));
      const d = await api('/patients', { qs: { q } });
      v.append(h('div', { class: 'panel flush' }, table(['Name', 'Last visit', 'Recall due', 'No-shows', ''], d.patients.map((p) => h('tr', { class: 'click', onclick: () => { location.hash = '#/patients/' + p.id; } },
        h('td', {}, h('a', { href: '#/patients/' + p.id }, `${p.first_name} ${p.last_name}`), p.do_not_contact ? [' ', tag('Do not contact', 'bad')] : null), h('td', {}, p.last_visit || '—'), h('td', {}, p.recall_due || '—'), h('td', {}, p.no_shows), h('td', {}, h('a', { href: '#/patients/' + p.id }, 'Open')))), { empty: 'No patients match.' })), h('p', { class: 'muted' }, `${d.total} patient${d.total === 1 ? '' : 's'}`));
    },
  };
  function addPatient() {
    const f = form([
      { key: 'first_name', label: 'First name', required: true, maxlength: 60 }, { key: 'last_name', label: 'Last name', required: true, maxlength: 60 },
      { key: 'dob', label: 'Date of birth', type: 'date', required: true, max: todayStr(0) }, { key: 'phone', label: 'Mobile phone', type: 'tel', optional: true, pattern: '^[\\d\\s()+.-]{7,30}$', patternMsg: 'Use digits, spaces, + ( ) - only.' },
      { key: 'email', label: 'Email', type: 'email', optional: true },
    ]);
    modal({ title: 'Add patient', body: f.el, actions: [{ label: 'Cancel', ghost: true }, { label: 'Save patient', onclick: async () => { const v = f.values(); if (!v) return false; const r = await api('/patients', { method: 'POST', body: v }); toast('Patient added', 'ok'); location.hash = '#/patients/' + r.patient.id; } }] });
  }
  async function patientDetail(v, id) {
    const d = await api('/patients/' + id);
    const p = d.patient;
    v.append(DF.pageHead(`${p.first_name} ${p.last_name}`, 'Patient record', [h('a', { class: 'btn sm btn-ghost', href: '#/patients' }, '← All patients'), h('button', { class: 'btn sm', type: 'button', onclick: () => bookDialog({ patient_id: p.id }) }, 'Book appointment')]));
    const row = (l, val) => h('p', {}, h('strong', {}, l + ': '), val || '—');
    const consentBtn = (purpose, status) => h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: async () => { await api(`/patients/${id}/consent`, { method: 'POST', body: { purpose, status } }); toast('Consent updated', 'ok'); render(); } }, status === 'granted' ? 'Record consent' : 'Revoke');
    v.append(h('div', { class: 'cols' },
      h('div', { class: 'panel' }, h('h2', {}, 'Details'), row('Date of birth', p.dob), row('Mobile', p.phone), row('Email', p.email), row('Last visit', p.last_visit), row('Recall due', p.recall_due), row('No-shows', p.no_shows),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.do_not_contact, onchange: async (e) => { await api('/patients/' + id, { method: 'PATCH', body: { do_not_contact: e.target.checked } }); toast('Updated', 'ok'); } }), h('span', {}, 'Do not contact'))),
      h('div', { class: 'panel' }, h('h2', {}, 'Text-message consent'),
        h('p', {}, 'Appointment messages: ', tag(d.consent.transactional, d.consent.transactional === 'revoked' ? 'bad' : 'ok'), ' ', d.consent.transactional === 'revoked' ? consentBtn('transactional', 'granted') : consentBtn('transactional', 'revoked')),
        h('p', {}, 'Marketing / recall: ', tag(d.consent.marketing, d.consent.marketing === 'granted' ? 'ok' : ''), ' ', d.consent.marketing === 'granted' ? consentBtn('marketing', 'revoked') : consentBtn('marketing', 'granted')),
        h('h2', {}, 'Insurance'), d.insurance.length ? d.insurance.map((i) => h('p', {}, i.carrier, ' ', i.member_id_masked ? '(' + i.member_id_masked + ') ' : '', tag(i.status.replace('_', ' '), i.status === 'verified' ? 'ok' : ''))) : h('p', { class: 'muted' }, 'None on file.'))));
    v.append(h('div', { class: 'panel flush' }, h('h2', {}, 'Appointments'), table(['When', 'Type', 'Provider', 'Status'], d.appointments.map((a) => h('tr', {}, h('td', {}, fmt(a.start_utc)), h('td', {}, a.type_name), h('td', {}, a.provider_name), h('td', {}, tag(a.status.replace('_', ' '))))), { empty: 'No appointments.' })));
    v.append(h('div', { class: 'panel flush' }, h('h2', {}, 'Conversations'), callsTable(d.conversations.map((c) => Object.assign({ status: 'ended' }, c)))));
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    try {
      state.me = await api('/me');
    } catch (e) { return; }
    state.locationId = state.me.location.id; state.tz = state.me.location.timezone;
    $('#engine-pill').textContent = state.me.features.agent_engine === 'claude' ? 'AI: Claude' : 'AI: built-in engine';
    $('#menu-btn').addEventListener('click', () => { const open = $('#sidebar').classList.toggle('open'); $('#menu-btn').setAttribute('aria-expanded', String(open)); });
    $('#logout-btn').addEventListener('click', async () => { await authApi('/logout'); location.replace('/login'); });
    $('#dlg').addEventListener('click', (e) => { if (e.target === $('#dlg')) $('#dlg').close(); });
    await refreshTaskBadge(); buildNav();
    window.addEventListener('hashchange', render);
    connectStream();
    if (!location.hash) location.hash = '#/today'; else render();
    setInterval(refreshTaskBadge, 60000);
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
