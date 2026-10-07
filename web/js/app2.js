/* DentaFlow AI dashboard, part 2: Waitlist & recall, Knowledge base, Analytics, Test the agent,
   Messages, Settings, Billing, Audit. Depends on app.js (window.DF). */
(function () {
  'use strict';
  const DF = window.DF;
  const { h, api, state, routes, clear, form, modal, toast, confirmDlg, table, tag, fmt, money, pct, ago } = DF;
  const $ = DF.$;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const render = () => DF.render();

  // ================================================================== WAITLIST & RECALL
  routes.waitlist = {
    title: 'Waitlist & recall', live: true,
    async render(v) {
      const [w, c] = await Promise.all([api('/waitlist'), api('/campaigns')]);
      v.append(DF.pageHead('Waitlist & recall', 'Fill cancelled slots automatically and bring back patients who are overdue.', [h('button', { class: 'btn sm', type: 'button', onclick: addWait }, 'Add to waitlist'), h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: runRecall }, 'Run recall campaign')]));
      v.append(h('div', { class: 'panel flush' }, h('h2', {}, 'Waitlist'), table(['Patient', 'Wants', 'Preferences', 'Status', ''], w.entries.map((e) => h('tr', {},
        h('td', {}, `${e.first_name} ${e.last_name}`), h('td', {}, e.type_name), h('td', {}, [(e.prefs.days || []).map((d) => DAYS[d].slice(0, 3)).join(', '), e.prefs.tod].filter(Boolean).join(' · ') || 'Any time'), h('td', {}, tag(e.status, e.status === 'filled' ? 'ok' : '')),
        h('td', {}, e.status === 'active' ? h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: async () => { await api('/waitlist/' + e.id, { method: 'DELETE' }); render(); } }, 'Remove') : null))), { empty: 'Nobody is on the waitlist. When a patient cannot find a time, the agent offers to add them.' })));
      v.append(h('div', { class: 'panel flush' }, h('h2', {}, 'Slot offers sent'), table(['Sent', 'Patient', 'Slot', 'Status'], w.offers.map((o) => h('tr', {}, h('td', {}, fmt(o.sent_at)), h('td', {}, `${o.first_name} ${o.last_name}`), h('td', {}, o.slot.spoken + ' · ' + o.slot.provider_name), h('td', {}, tag(o.status.replace('_', ' '), o.status === 'accepted' ? 'ok' : o.status === 'pending' ? 'info' : '')))), { empty: 'No offers yet. Cancel an appointment to see backfill in action.' })));
      v.append(h('div', { class: 'panel flush' }, h('h2', {}, 'Recall campaigns'), table(['Campaign', 'Started', 'Contacted', 'Skipped', 'Booked'], c.campaigns.map((x) => h('tr', {}, h('td', {}, x.name), h('td', {}, fmt(x.created_at)), h('td', {}, x.funnel.contacted + x.funnel.queued), h('td', {}, x.funnel.skipped), h('td', {}, x.funnel.booked))), { empty: 'No campaigns yet.' })));
    },
  };
  async function addWait() {
    const [types, pats] = await Promise.all([api('/appointment-types'), api('/patients')]);
    const f = form([
      { key: 'patient_id', label: 'Patient', type: 'select', required: true, options: [{ value: '', label: 'Select…' }].concat(pats.patients.map((p) => ({ value: p.id, label: `${p.last_name}, ${p.first_name}` }))) },
      { key: 'type_id', label: 'Appointment type', type: 'select', required: true, options: [{ value: '', label: 'Select…' }].concat(types.types.filter((t) => t.active && !t.is_emergency).map((t) => ({ value: t.id, label: t.name }))) },
      { key: 'tod', label: 'Time of day', type: 'select', options: [{ value: '', label: 'Any' }, 'morning', 'afternoon', 'evening'] },
      { key: 'days', label: 'Preferred days', type: 'list', optional: true, help: 'e.g. Tue, Thu (leave blank for any day)' },
    ]);
    modal({ title: 'Add to waitlist', body: f.el, actions: [{ label: 'Cancel', ghost: true }, { label: 'Add', onclick: async () => { const v = f.values(); if (!v) return false; const days = v.days.map((d) => WD.findIndex((w) => d.toLowerCase().startsWith(w))).filter((i) => i >= 0); await api('/waitlist', { method: 'POST', body: { patient_id: v.patient_id, type_id: v.type_id, days, tod: v.tod || null } }); toast('Added to waitlist', 'ok'); render(); } }] });
  }
  async function runRecall() {
    if (!(await confirmDlg('Text every patient who is overdue for a visit AND has agreed to marketing messages? Patients without marketing consent, on do-not-contact, or already scheduled are skipped. Messages are sent only outside quiet hours (9 PM to 8 AM).', 'Run campaign'))) return;
    const r = await api('/campaigns/recall', { method: 'POST', body: {} });
    toast(`Campaign created: ${r.queued} queued, ${r.skipped} skipped`, 'ok'); render();
  }

  // ================================================================== KNOWLEDGE BASE
  routes.knowledge = {
    title: 'Knowledge base', live: false,
    async render(v) {
      v.append(DF.pageHead('Knowledge base', 'The only information the agent will use to answer questions about your practice. If it is not here, the agent says it will follow up.', [
        h('button', { class: 'btn sm', type: 'button', onclick: () => docDialog() }, 'Add information'), h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => docDialog({ canonical: true }) }, 'Add Q&A answer'), h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: crawlDialog }, 'Import from website')]));
      const tester = h('input', { type: 'text', placeholder: 'Try a question patients might ask…', 'aria-label': 'Test a question', maxlength: 300 });
      const out = h('div', { class: 'stack' });
      const run = async () => { if (tester.value.trim().length < 2) return; clear(out); try { const r = await api('/knowledge/test', { method: 'POST', body: { question: tester.value } }); out.append(r.answer ? h('div', { class: 'alert ok' }, r.answer, h('div', { class: 'muted' }, 'Source: ' + r.source)) : h('div', { class: 'alert warn' }, 'No approved answer found. The agent would offer a staff follow-up. Add information below to fix this.')); } catch (e) { out.append(h('div', { class: 'alert bad' }, e.message)); } };
      tester.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
      v.append(h('div', { class: 'panel' }, h('h2', {}, 'Test what the agent would say'), h('div', { class: 'row' }, tester, h('button', { class: 'btn sm', type: 'button', onclick: run }, 'Ask')), out));
      const [d, u] = await Promise.all([api('/knowledge'), api('/unanswered')]);
      if (u.questions.length) v.append(h('div', { class: 'panel flush' }, h('h2', {}, 'Questions the agent could not answer'), table(['Question', 'Asked', ''], u.questions.map((q) => h('tr', {}, h('td', {}, q.question), h('td', {}, ago(q.ts)), h('td', {}, h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => docDialog({ canonical: true, question: q.question, resolve: q.id }) }, 'Add answer'), h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: async () => { await api('/unanswered/' + q.id + '/resolve', { method: 'POST' }); render(); } }, 'Ignore'))))))));
      v.append(h('div', { class: 'panel flush' }, h('h2', {}, 'Approved information'), table(['Title', 'Type', 'Size', 'Version', 'Active', ''], d.docs.map((x) => h('tr', {}, h('td', {}, x.title, h('div', { class: 'muted' }, x.preview.slice(0, 110) + (x.size > 110 ? '…' : ''))), h('td', {}, tag(x.source_type === 'canonical' ? 'Pinned Q&A' : x.source_type === 'crawl' ? 'Website' : 'Text', x.source_type === 'canonical' ? 'info' : '')), h('td', {}, x.size.toLocaleString() + ' chars'), h('td', {}, 'v' + x.version),
        h('td', {}, h('input', { type: 'checkbox', checked: !!x.active, 'aria-label': 'Active: ' + x.title, onchange: async (e) => { await api('/knowledge/' + x.id, { method: 'PATCH', body: { active: e.target.checked } }); toast('Updated', 'ok'); } })),
        h('td', {}, h('div', { class: 'row' }, h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: async () => { const full = await api('/knowledge/' + x.id); docDialog({ doc: full.doc, canonical: full.doc.source_type === 'canonical' }); } }, 'Edit'), h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { if (await confirmDlg(`Delete "${x.title}"?`, 'Delete')) { await api('/knowledge/' + x.id, { method: 'DELETE' }); render(); } } }, 'Delete'))))), { empty: 'No information yet.' })));
    },
  };
  function docDialog(o) {
    o = o || {};
    const f = form([
      { key: 'title', label: o.canonical ? 'Question patients ask' : 'Title', required: true, maxlength: 200 },
      { key: 'content', label: o.canonical ? 'Approved answer' : 'Content', type: 'textarea', rows: 7, required: true, maxlength: 40000, help: o.canonical ? 'This exact answer is preferred over everything else.' : 'Paste policies, FAQs, service descriptions. Separate topics with a blank line.' },
    ], o.doc || { title: o.question || '' });
    modal({ title: o.doc ? 'Edit information' : o.canonical ? 'Add Q&A answer' : 'Add information', body: f.el, actions: [{ label: 'Cancel', ghost: true }, { label: 'Save', onclick: async () => { const v = f.values(); if (!v) return false; if (o.doc) await api('/knowledge/' + o.doc.id, { method: 'PATCH', body: v }); else await api('/knowledge', { method: 'POST', body: Object.assign({ type: o.canonical ? 'canonical' : 'text' }, v) }); if (o.resolve) await api('/unanswered/' + o.resolve + '/resolve', { method: 'POST' }); toast('Saved', 'ok'); render(); } }] });
  }
  function crawlDialog() {
    const f = form([{ key: 'url', label: 'Page address', type: 'text', required: true, placeholder: 'https://yourpractice.com/new-patients', pattern: '^https?://.+', patternMsg: 'Enter a full address starting with https://' }]);
    modal({ title: 'Import from your website', body: h('div', { class: 'stack' }, f.el, h('p', { class: 'muted' }, 'We read the text of one public page (redirects and private addresses are blocked). Review it afterwards.')), actions: [{ label: 'Cancel', ghost: true }, { label: 'Import', onclick: async () => { const v = f.values(); if (!v) return false; await api('/knowledge/crawl', { method: 'POST', body: { url: v.url } }); toast('Page imported', 'ok'); render(); } }] });
  }

  // ================================================================== ANALYTICS
  routes.analytics = {
    title: 'Analytics', live: false,
    async render(v) {
      const days = parseInt(new URLSearchParams(location.hash.split('?')[1] || '').get('days') || '30', 10);
      const sel = h('select', { 'aria-label': 'Date range', onchange: (e) => { location.hash = '#/analytics?days=' + e.target.value; } }, [7, 30, 90].map((d) => h('option', { value: d, selected: d === days }, 'Last ' + d + ' days')));
      v.append(DF.pageHead('Analytics', 'Is the agent paying for itself? Revenue figures are estimates based on the value you set for each appointment type.', [sel]));
      const a = await api('/analytics/summary', { qs: { days } });
      const kpi = (val, l, n) => h('div', { class: 'kpi' }, h('div', { class: 'v' }, val), h('div', { class: 'l' }, l), n ? h('div', { class: 'n' }, n) : null);
      v.append(h('div', { class: 'kpis' }, kpi(a.conversations, 'Conversations', `${a.calls_answered} phone calls`), kpi(a.after_hours_captured, 'After-hours captures', 'Would have hit voicemail'), kpi(a.appointments_booked, 'Appointments booked', `${a.new_patient_bookings} new patients`), kpi(money(a.estimated_production), 'Estimated production'),
        kpi(pct(a.new_patient_conversion), 'New-patient conversion'), kpi(pct(a.containment_rate), 'Resolved without staff', pct(a.handoff_rate) + ' handoff'), kpi(pct(a.no_show_rate), 'No-show rate', 'Completed visits only'), kpi(a.slots_recovered, 'Slots recovered by waitlist'), kpi(a.staff_hours_saved + ' h', 'Staff hours saved', 'Estimate'), kpi(a.emergencies, 'Emergencies flagged')));
      const max = Math.max(1, ...a.daily.map((d) => Math.max(d.conversations, d.bookings)));
      const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'Daily conversations and bookings' });
      a.daily.forEach((d) => { const b1 = h('div', { class: 'bar', title: `${d.date}: ${d.conversations} conversations` }); b1.style.height = Math.round((d.conversations / max) * 100) + '%'; const b2 = h('div', { class: 'bar b2', title: `${d.date}: ${d.bookings} bookings` }); b2.style.height = Math.round((d.bookings / max) * 100) + '%'; bars.append(b1, b2); });
      v.append(h('div', { class: 'panel' }, h('h2', {}, 'Conversations and bookings per day'), h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'lg1' }), 'Conversations'), h('span', {}, h('i', { class: 'lg2' }), 'Bookings')), bars, h('div', { class: 'axis' }, h('span', {}, a.daily[0] ? a.daily[0].date : ''), h('span', {}, a.daily.length ? a.daily[a.daily.length - 1].date : ''))));
      document.querySelectorAll('.legend .lg1').forEach((e) => { e.style.background = 'var(--brand)'; }); document.querySelectorAll('.legend .lg2').forEach((e) => { e.style.background = 'var(--teal)'; });
      const hb = (title, map, labels) => { const entries = Object.entries(map).sort((x, y) => y[1] - x[1]); const m = Math.max(1, ...entries.map((e) => e[1])); const p = h('div', { class: 'panel' }, h('h2', {}, title)); if (!entries.length) p.append(h('p', { class: 'muted' }, 'No data yet.')); entries.forEach(([k, n]) => { const fill = h('div', { class: 'fill' }); fill.style.width = Math.round((n / m) * 100) + '%'; p.append(h('div', { class: 'hbar' }, h('span', { class: 'name' }, (labels && labels[k]) || k.replace(/_/g, ' ')), h('div', { class: 'track' }, fill), h('span', { class: 'num' }, n))); }); return p; };
      v.append(h('div', { class: 'cols' }, hb('Outcomes', a.outcomes), hb('What callers wanted', a.intents), hb('Channels', a.channels, { voice: 'Phone', sms: 'Text', chat: 'Web chat' })));
      const hours = a.hourly.map((n, i) => [i, n]).filter(([, n]) => n > 0).reduce((o, [i, n]) => { o[(i % 12 || 12) + (i < 12 ? ' AM' : ' PM')] = n; return o; }, {});
      v.append(hb('Busiest hours (clinic local time)', hours));
      v.append(h('p', { class: 'muted' }, a.note));
    },
  };

  // ================================================================== TEST THE AGENT
  routes.test = {
    title: 'Test the agent', live: false,
    async render(v) {
      v.append(DF.pageHead('Test the agent', 'Talk to your agent exactly as a patient would. Conversations here are real and appear in Calls & chats.', []));
      const info = state.me.features;
      v.append(h('div', { class: 'alert info' }, `AI engine: ${info.agent_engine === 'claude' ? 'Claude' : 'built-in engine (no API key needed; add your Claude API key to the .env file on your server to use Claude)'} · Text messages: ${info.sms_provider === 'twilio' ? 'sent via Twilio' : 'simulated, see Messages sent'} · Phone: ${info.voice_provider === 'twilio' ? 'Twilio number' : 'use the microphone below to simulate a call'}`));
      // --- chat / voice simulator
      const log = h('div', { class: 'sim-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
      const input = h('input', { type: 'text', 'aria-label': 'Your message', placeholder: 'Type what the patient says…', maxlength: 500, disabled: true });
      const sendBtn = h('button', { class: 'btn sm', type: 'submit', disabled: true }, 'Send');
      const mic = h('button', { class: 'btn sm btn-ghost', type: 'button', disabled: true, 'aria-pressed': 'false', title: 'Speak instead of typing' }, '🎤 Speak');
      const speakCb = h('input', { type: 'checkbox', id: 'speak-cb' });
      const mode = h('select', { 'aria-label': 'Channel' }, h('option', { value: 'voice' }, 'Phone call'), h('option', { value: 'chat' }, 'Web chat'));
      const from = h('input', { type: 'tel', value: '+15125550199', 'aria-label': 'Caller phone number', maxlength: 20 });
      let convId = null, busy = false;
      const add = (role, text) => { const b = h('div', { class: 'bubble ' + (role === 'agent' ? 'agent' : 'patient') }, text); log.append(b); log.scrollTop = log.scrollHeight; return b; };
      const say = (t) => { if (speakCb.checked && 'speechSynthesis' in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(t)); } };
      const start = async () => {
        clear(log); const r = await api('/simulate/start', { method: 'POST', body: { channel: mode.value, from: mode.value === 'voice' ? from.value : undefined } });
        convId = r.conversation_id; add('agent', r.greeting); say(r.greeting); input.disabled = sendBtn.disabled = mic.disabled = false; input.focus();
      };
      const send = async (text) => {
        if (!text || busy || !convId) return; busy = true; add('patient', text); input.value = '';
        const typing = add('agent', '…');
        try { const r = await api('/simulate/turn', { method: 'POST', body: { conversation_id: convId, text } }); typing.textContent = r.reply; say(r.reply); if (r.transfer) add('agent', `[Call would be transferred to ${r.transfer.to}]`); if (r.ended) { input.disabled = sendBtn.disabled = mic.disabled = true; add('agent', '— conversation ended —'); } }
        catch (e) { typing.textContent = 'Error: ' + e.message; }
        busy = false; if (!input.disabled) input.focus();
      };
      const sim = h('form', { class: 'sim-form' }, input, mic, sendBtn);
      sim.addEventListener('submit', (e) => { e.preventDefault(); send(input.value.trim()); });
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { mic.title = 'Speech recognition is not supported in this browser. Try Chrome or Edge.'; mic.addEventListener('click', () => toast('Speech recognition needs Chrome or Edge. You can type instead.', 'bad')); }
      else mic.addEventListener('click', () => { const rec = new SR(); rec.lang = 'en-US'; rec.interimResults = false; mic.classList.add('mic-on'); mic.setAttribute('aria-pressed', 'true'); rec.onresult = (e) => send(e.results[0][0].transcript); rec.onend = () => { mic.classList.remove('mic-on'); mic.setAttribute('aria-pressed', 'false'); }; rec.onerror = () => { mic.classList.remove('mic-on'); toast('Could not hear you. Check microphone permission.', 'bad'); }; rec.start(); });
      const scenarios = [['New patient', 'Hi, I need to book an appointment. I am a new patient.'], ['Cleaning', 'I need to book a cleaning'], ['Reschedule', 'I need to reschedule my appointment'], ['Cancel', 'I want to cancel my appointment'], ['Toothache', 'I have a bad toothache and I am in a lot of pain'], ['Emergency', 'I am having trouble breathing and my throat is swelling'], ['Hours', 'What are your hours?'], ['Insurance', 'Do you take Delta Dental?'], ['Human', 'Can I speak to a person?']];
      const left = h('div', { class: 'panel' }, h('h2', {}, 'Phone and chat simulator'),
        h('div', { class: 'row' }, h('label', { for: 'sim-ch' }, 'Channel'), Object.assign(mode, { id: 'sim-ch' }), h('label', { for: 'sim-from' }, 'Caller ID'), Object.assign(from, { id: 'sim-from' }), h('button', { class: 'btn sm', type: 'button', onclick: start }, 'Start new conversation')),
        h('div', { class: 'row' }, speakCb, h('label', { for: 'speak-cb' }, 'Speak the assistant\'s replies aloud')),
        log, sim, h('p', { class: 'muted' }, 'Quick phrases:'), h('div', { class: 'row' }, scenarios.map(([l, t]) => h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => { if (!convId || input.disabled) { toast('Start a new conversation first.', 'bad'); return; } send(t); } }, l))));
      // --- SMS simulator + clock
      const smsFrom = h('input', { type: 'tel', value: '+15125550102', id: 'sms-from', maxlength: 20 });
      const smsBody = h('input', { type: 'text', id: 'sms-body', placeholder: 'Text message…', maxlength: 300 });
      const smsLog = h('div', { class: 'sim-log' });
      const sendSms = async (body) => { if (!body) return; smsLog.append(h('div', { class: 'bubble patient' }, body)); smsBody.value = ''; try { const r = await api('/simulate/sms', { method: 'POST', body: { from: smsFrom.value, body } }); if (r.reply) smsLog.append(h('div', { class: 'bubble agent' }, r.reply)); } catch (e) { smsLog.append(h('div', { class: 'bubble agent' }, 'Error: ' + e.message)); } smsLog.scrollTop = smsLog.scrollHeight; };
      const smsForm = h('form', { class: 'sim-form' }, smsBody, h('button', { class: 'btn sm', type: 'submit' }, 'Send'));
      smsForm.addEventListener('submit', (e) => { e.preventDefault(); sendSms(smsBody.value.trim()); });
      const right = h('div', {},
        h('div', { class: 'panel' }, h('h2', {}, 'Text-message simulator'), h('p', { class: 'muted' }, 'Reply as a patient to reminders and offers. Use a seeded patient number such as +15125550102.'), h('div', { class: 'row' }, h('label', { for: 'sms-from' }, 'From'), smsFrom), smsLog, smsForm,
          h('div', { class: 'row' }, ['C', 'R', 'X', 'YES', 'BOOK', 'HELP', 'STOP', 'START'].map((k) => h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => sendSms(k) }, k)))),
        h('div', { class: 'panel' }, h('h2', {}, 'Time travel (testing only)'), h('p', { class: 'muted' }, 'Jump the clock forward to trigger appointment reminders, then check Messages sent.'), h('div', { class: 'row' }, [24, 48, 72].map((hrs) => h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: async () => { try { const r = await api('/simulate/advance-clock', { method: 'POST', body: { hours: hrs } }); toast(`Clock +${hrs}h: ${r.reminders_sent} reminder(s) sent`, 'ok'); } catch (e) { toast(e.message, 'bad'); } } }, '+' + hrs + ' hours')))),
        h('div', { class: 'panel' }, h('h2', {}, 'Put it on your website'), h('p', { class: 'muted' }, 'Paste this before </body> on your clinic site:'), h('div', { class: 'trace' }, `<script src="${info.base_url}/js/widget.js" data-key="${state.me.location.widget_key}" defer></script>`)));
      v.append(h('div', { class: 'sim' }, left, right));
    },
  };

  // ================================================================== MESSAGES
  routes.messages = {
    title: 'Messages sent', live: true,
    async render(v) {
      v.append(DF.pageHead('Messages sent', state.me.features.sms_provider === 'twilio' ? 'Text messages sent through Twilio.' : 'Text messages are SIMULATED in this setup. Add Twilio keys to send real texts.', []));
      const d = await api('/outbox');
      v.append(h('div', { class: 'panel flush' }, table(['When', 'To', 'Type', 'Message', 'Status'], d.messages.map((m) => h('tr', {}, h('td', {}, fmt(m.created_at)), h('td', {}, m.to_addr || ''), h('td', {}, tag(m.kind || 'message')), h('td', {}, m.body), h('td', {}, tag(m.status.replace(/_/g, ' '), m.status === 'sent' || m.status === 'simulated' ? 'ok' : m.status === 'failed' || m.status.startsWith('blocked') ? 'bad' : 'info')))), { empty: 'No messages yet.' })));
    },
  };

  // ================================================================== SETTINGS
  const TABS = [['general', 'General & hours'], ['agent', 'Agent & routing'], ['providers', 'Providers'], ['types', 'Appointment types'], ['rules', 'Rules & policies'], ['emergency', 'Emergency & alerts'], ['integrations', 'Integrations'], ['users', 'Users'], ['security', 'My security'], ['versions', 'History']];
  routes.settings = {
    title: 'Settings', live: false,
    async render(v, tab) {
      tab = tab || 'general';
      v.append(DF.pageHead('Settings', 'Changes are versioned and can be rolled back from History.', []));
      const tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, l]) => h('button', { role: 'tab', type: 'button', 'aria-selected': String(k === tab), onclick: () => { location.hash = '#/settings/' + k; } }, l)));
      v.append(tabs);
      const body = h('div', {}); v.append(body);
      const fn = { general, agent, providers, types, rules, emergency, integrations, users, security, versions }[tab] || general;
      const ro = !['owner', 'manager'].includes(state.me.user.role);
      if (ro && !['security'].includes(tab)) body.append(h('div', { class: 'alert warn' }, 'You have view-only access to these settings. Ask an owner or manager to make changes.'));
      await fn(body, ro);
    },
  };
  const saveSettings = async (body, msg) => { await api('/settings', { method: 'PATCH', body }); toast(msg || 'Settings saved', 'ok'); };
  async function loadLoc() { return (await api('/settings')).location; }

  async function general(b, ro) {
    const L = await loadLoc();
    const f = form([{ key: 'name', label: 'Practice name', required: true, maxlength: 120 }, { key: 'address', label: 'Address', maxlength: 250 }, { key: 'phone', label: 'Office phone', type: 'tel', maxlength: 30 },
      { key: 'timezone', label: 'Time zone', type: 'select', options: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'Europe/London', 'Australia/Sydney'].concat(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'Europe/London', 'Australia/Sydney'].includes(L.timezone) ? [] : [L.timezone]) }], L);
    const hours = {};
    const hgrid = h('div', { class: 'fgrid' }, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => { const cur = L.hours[d]; const o = h('input', { type: 'time', value: cur ? cur[0] : '', 'aria-label': DAYS[WD.indexOf(d)] + ' opens' }); const c = h('input', { type: 'time', value: cur ? cur[1] : '', 'aria-label': DAYS[WD.indexOf(d)] + ' closes' }); hours[d] = [o, c]; return h('div', { class: 'field' }, h('label', {}, DAYS[WD.indexOf(d)]), h('div', { class: 'row' }, o, ' to ', c), h('p', { class: 'help' }, 'Leave blank if closed')); }));
    b.append(h('div', { class: 'panel' }, h('h2', {}, 'Practice'), f.el), h('div', { class: 'panel' }, h('h2', {}, 'Opening hours'), hgrid));
    if (!ro) b.append(h('button', { class: 'btn', type: 'button', onclick: async () => { const v = f.values(); if (!v) return; const hrs = {}; for (const d in hours) { const [o, c] = hours[d]; if (o.value && c.value) { if (o.value >= c.value) { toast(`${DAYS[WD.indexOf(d)]}: closing time must be after opening time`, 'bad'); return; } hrs[d] = [o.value, c.value]; } else hrs[d] = null; } try { await saveSettings({ name: v.name, address: v.address, phone: v.phone, timezone: v.timezone, hours: hrs }); state.tz = v.timezone; } catch (e) { toast(e.message, 'bad'); } } }, 'Save'));
  }
  async function agent(b, ro) {
    const S = (await loadLoc()).settings;
    const f = form([{ key: 'agent_name', label: 'Assistant name', required: true, maxlength: 30 }, { key: 'greeting', label: 'Custom greeting', type: 'textarea', optional: true, maxlength: 400, help: 'Leave blank for the default. Use {clinic} and {agent}. Keep the AI disclosure in your greeting.' },
      { key: 'recording_disclosure', label: 'Say that calls may be recorded', type: 'checkbox', help: 'Required in many states. Keep on unless your counsel says otherwise.' },
      { key: 'routing_mode', label: 'Call routing', type: 'select', options: [{ value: 'always', label: 'Agent answers every call' }, { value: 'after_hours', label: 'Office rings first during hours; agent after hours' }, { value: 'overflow', label: 'Agent answers when the office does not pick up' }] },
      { key: 'overflow_ring_seconds', label: 'Ring the office for (seconds)', type: 'number', min: 5, max: 60 }, { key: 'transfer_number', label: 'Transfer number (front desk)', type: 'tel', optional: true, maxlength: 30 },
      { key: 'transfer_only_in_hours', label: 'Only transfer during office hours', type: 'checkbox' }], S);
    b.append(h('div', { class: 'panel' }, f.el));
    if (!ro) b.append(h('button', { class: 'btn', type: 'button', onclick: async () => { const v = f.values(); if (v) try { await saveSettings({ settings: v }); } catch (e) { toast(e.message, 'bad'); } } }, 'Save'));
  }
  async function rules(b, ro) {
    const S = (await loadLoc()).settings;
    const f = form([{ key: 'new_patient_daily_cap', label: 'Max new-patient exams per dentist per day', type: 'number', min: 0, max: 50 }, { key: 'emergency_reserve_minutes', label: 'Minutes reserved for emergencies each morning', type: 'number', min: 0, max: 240, help: 'Released at noon on the same day.' },
      { key: 'reminder_cadence_hours', label: 'Send reminders this many hours before', type: 'list', help: 'e.g. 72, 24, 2' }, { key: 'waitlist_mode', label: 'Waitlist offers', type: 'select', options: [{ value: 'batch', label: 'Offer to up to 3 patients at once (first YES wins)' }, { value: 'sequential', label: 'One patient at a time' }] },
      { key: 'offer_ttl_min', label: 'Offer expires after (minutes)', type: 'number', min: 1, max: 240 }, { key: 'cancellation_policy', label: 'Cancellation policy wording', type: 'textarea', maxlength: 500, help: 'Read to patients who cancel within 24 hours. The agent never waives fees.' },
      { key: 'accepted_insurance', label: 'Accepted insurance carriers', type: 'list', help: 'Comma-separated. The agent only says whether a carrier is on this list.' }, { key: 'spend_cap_usd', label: 'Monthly usage spend cap (USD)', type: 'number', min: 0 }], S);
    b.append(h('div', { class: 'panel' }, f.el));
    if (!ro) b.append(h('button', { class: 'btn', type: 'button', onclick: async () => { const v = f.values(); if (!v) return; v.reminder_cadence_hours = v.reminder_cadence_hours.map(Number).filter((n) => n > 0); try { await saveSettings({ settings: v }); } catch (e) { toast(e.message, 'bad'); } } }, 'Save'));
    // block-outs
    const bl = h('div', { class: 'panel flush' }, h('h2', {}, 'Block-outs (holidays, time off)'));
    const provs = (await api('/providers')).providers;
    bl.append(table(['Date', 'Who', 'Hours', ''], (S.blockouts || []).map((x, i) => h('tr', {}, h('td', {}, x.date), h('td', {}, x.provider_id ? (provs.find((p) => p.id === x.provider_id) || {}).name : 'Whole practice'), h('td', {}, x.start ? `${x.start}–${x.end}` : 'All day'), h('td', {}, ro ? null : h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: async () => { const list = S.blockouts.filter((_, j) => j !== i); await saveSettings({ settings: { blockouts: list } }); render(); } }, 'Remove')))), { empty: 'No block-outs.' }));
    if (!ro) bl.append(h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => { const bf = form([{ key: 'date', label: 'Date', type: 'date', required: true }, { key: 'provider_id', label: 'Who', type: 'select', options: [{ value: '', label: 'Whole practice' }].concat(provs.map((p) => ({ value: p.id, label: p.name }))) }, { key: 'start', label: 'From (blank = all day)', type: 'text', optional: true, pattern: '^\\d{2}:\\d{2}$', patternMsg: 'Use HH:MM, e.g. 13:00' }, { key: 'end', label: 'To', type: 'text', optional: true, pattern: '^\\d{2}:\\d{2}$', patternMsg: 'Use HH:MM' }]); modal({ title: 'Add block-out', body: bf.el, actions: [{ label: 'Cancel', ghost: true }, { label: 'Add', onclick: async () => { const v = bf.values(); if (!v) return false; const item = { date: v.date }; if (v.provider_id) item.provider_id = v.provider_id; if (v.start && v.end) { item.start = v.start; item.end = v.end; } await saveSettings({ settings: { blockouts: (S.blockouts || []).concat([item]) } }); render(); } }] }); } }, 'Add block-out')));
    b.append(bl);
  }
  async function emergency(b, ro) {
    const S = (await loadLoc()).settings; const E = S.emergency_policy;
    const f = form([{ key: 'on_call_number', label: 'On-call dentist number', type: 'tel', optional: true, maxlength: 30, help: 'Given to patients with urgent problems when the office is closed.' }, { key: 'script_urgent', label: 'What the agent says for urgent dental problems', type: 'textarea', maxlength: 600 }, { key: 'script_life', label: 'What the agent says for life-threatening symptoms', type: 'textarea', maxlength: 600, help: 'Always directs to 911. Keep it short and clear. Have your dentist approve the wording.' }], E);
    const g = form([{ key: 'notify_phones', label: 'Text urgent alerts to', type: 'list', optional: true, help: 'Phone numbers, comma-separated' }, { key: 'notify_emails', label: 'Email urgent alerts to', type: 'list', optional: true, validate: (v) => (String(v).split(/[,\n]/).map((s) => s.trim()).filter(Boolean).every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) ? '' : 'Enter valid email addresses.') }], S);
    b.append(h('div', { class: 'panel' }, h('h2', {}, 'Emergency policy'), f.el), h('div', { class: 'panel' }, h('h2', {}, 'Staff alerts'), g.el));
    if (!ro) b.append(h('button', { class: 'btn', type: 'button', onclick: async () => { const v = f.values(), w = g.values(); if (!v || !w) return; try { await saveSettings({ settings: { emergency_policy: v, notify_phones: w.notify_phones, notify_emails: w.notify_emails } }); } catch (e) { toast(e.message, 'bad'); } } }, 'Save'));
  }

  async function providers(b, ro) {
    const d = await api('/providers');
    const sched = (p) => WD.filter((w) => (p.schedule[w] || []).length).map((w) => w[0].toUpperCase() + w.slice(1) + ' ' + p.schedule[w].map((x) => x.join('–')).join(', ')).join(' · ') || 'No hours';
    b.append(h('div', { class: 'panel flush' }, table(['Name', 'Role', 'New patients', 'Hours', 'Active', ''], d.providers.map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, p.type), h('td', {}, p.accepts_new ? 'Yes' : 'No'), h('td', {}, sched(p)), h('td', {}, tag(p.active ? 'Active' : 'Inactive', p.active ? 'ok' : '')), h('td', {}, ro ? null : h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => providerDialog(p) }, 'Edit')))), { empty: 'No providers.' })));
    if (!ro) b.append(h('button', { class: 'btn', type: 'button', onclick: () => providerDialog() }, 'Add provider'));
  }
  function providerDialog(p) {
    const f = form([{ key: 'name', label: 'Name', required: true, maxlength: 80 }, { key: 'type', label: 'Role', type: 'select', options: ['dentist', 'hygienist', 'specialist'] }, { key: 'accepts_new', label: 'Accepts new patients', type: 'checkbox', default: true }, { key: 'active', label: 'Active (bookable)', type: 'checkbox', default: true }], p || {});
    const inputs = {}; const grid = h('div', { class: 'fgrid' }, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => { const cur = (p && p.schedule[d] || []).map((x) => x.join('-')).join(', '); const i = h('input', { type: 'text', value: cur, placeholder: '08:00-12:00, 13:00-17:00', 'aria-label': DAYS[WD.indexOf(d)] + ' hours' }); inputs[d] = i; return h('div', { class: 'field' }, h('label', {}, DAYS[WD.indexOf(d)]), i); }));
    modal({ title: p ? 'Edit provider' : 'Add provider', body: h('div', { class: 'stack' }, f.el, h('h2', {}, 'Weekly hours'), h('p', { class: 'muted' }, 'Format 08:00-12:00, 13:00-17:00. Leave blank for days off. Clinic hours still apply.'), grid), actions: [{ label: 'Cancel', ghost: true }, { label: 'Save', onclick: async () => {
      const v = f.values(); if (!v) return false; const schedule = {};
      for (const d in inputs) { const parts = inputs[d].value.split(',').map((s) => s.trim()).filter(Boolean); schedule[d] = []; for (const part of parts) { const m = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(part); if (!m || m[1] >= m[2]) { inputs[d].setAttribute('aria-invalid', 'true'); inputs[d].focus(); throw new Error(`${DAYS[WD.indexOf(d)]}: use HH:MM-HH:MM with the end after the start.`); } schedule[d].push([m[1], m[2]]); } }
      if (p) await api('/providers/' + p.id, { method: 'PATCH', body: { name: v.name, accepts_new: v.accepts_new, active: v.active, schedule } }); else await api('/providers', { method: 'POST', body: { name: v.name, type: v.type, accepts_new: v.accepts_new, schedule } });
      toast('Provider saved', 'ok'); render(); } }] });
  }
  async function types(b, ro) {
    const d = await api('/appointment-types');
    b.append(h('div', { class: 'alert info' }, 'These rules control exactly what the agent can book. "Agent may book" off means the agent hands that request to your team instead.'));
    b.append(h('div', { class: 'panel flush' }, table(['Type', 'Code', 'Length', 'Who', 'Patients', 'Agent may', 'Value', ''], d.types.map((t) => h('tr', {}, h('td', {}, t.name, t.is_emergency ? [' ', tag('Emergency', 'bad')] : null, !t.active ? [' ', tag('Inactive')] : null), h('td', {}, h('code', {}, t.code)), h('td', {}, t.duration_min + ' min'), h('td', {}, t.allowed_provider_types.join(', ')), h('td', {}, t.new_patient_only ? 'New only' : t.existing_only ? 'Existing only' : 'Any'),
      h('td', {}, ['book', 'reschedule', 'cancel'].filter((k) => t.agent_permissions[k]).join(', ') || 'nothing'), h('td', {}, money(t.value_estimate)), h('td', {}, ro ? null : h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: () => typeDialog(t) }, 'Edit')))), { empty: 'No appointment types.' })));
    if (!ro) b.append(h('button', { class: 'btn', type: 'button', onclick: () => typeDialog() }, 'Add appointment type'));
  }
  function typeDialog(t) {
    const init = t ? Object.assign({}, t, { allowed_provider_types: t.allowed_provider_types, perm_book: t.agent_permissions.book, perm_reschedule: t.agent_permissions.reschedule, perm_cancel: t.agent_permissions.cancel }) : { duration_min: 30, buffer_min: 0, lead_time_min: 60, max_horizon_days: 90, perm_book: true, perm_reschedule: true, perm_cancel: true, allowed_provider_types: ['dentist'], active: true };
    const f = form([
      { key: 'name', label: 'Name', required: true, maxlength: 80 }, t ? null : { key: 'code', label: 'Code', required: true, pattern: '^[A-Z0-9_]{2,30}$', patternMsg: 'Capital letters, numbers, underscore', placeholder: 'SEALANT' },
      { key: 'duration_min', label: 'Length (minutes)', type: 'number', min: 5, max: 480, required: true }, { key: 'buffer_min', label: 'Cleanup buffer after (minutes)', type: 'number', min: 0, max: 120 },
      { key: 'allowed_provider_types', label: 'Who can perform it', type: 'list', help: 'dentist, hygienist, specialist' }, { key: 'lead_time_min', label: 'Minimum notice (minutes)', type: 'number', min: 0, max: 100000 }, { key: 'max_horizon_days', label: 'Book up to (days ahead)', type: 'number', min: 1, max: 365 },
      { key: 'min_age', label: 'Minimum age', type: 'number', min: 0, max: 120, nullable: true, optional: true }, { key: 'max_age', label: 'Maximum age', type: 'number', min: 0, max: 120, nullable: true, optional: true },
      { key: 'value_estimate', label: 'Estimated value per visit (USD)', type: 'number', min: 0, help: 'Used only for the ROI estimate' }, { key: 'keywords', label: 'Words callers use for this', type: 'list', optional: true, help: 'e.g. cleaning, hygiene, teeth cleaning' },
      { key: 'new_patient_only', label: 'New patients only', type: 'checkbox' }, { key: 'existing_only', label: 'Existing patients only', type: 'checkbox' }, { key: 'is_emergency', label: 'Emergency visit (can use reserved slots)', type: 'checkbox' }, { key: 'active', label: 'Active', type: 'checkbox' },
      { key: 'perm_book', label: 'Agent may book', type: 'checkbox' }, { key: 'perm_reschedule', label: 'Agent may reschedule', type: 'checkbox' }, { key: 'perm_cancel', label: 'Agent may cancel', type: 'checkbox' },
    ].filter(Boolean), init);
    modal({ title: t ? 'Edit appointment type' : 'Add appointment type', body: f.el, actions: [{ label: 'Cancel', ghost: true }, { label: 'Save', onclick: async () => { const v = f.values(); if (!v) return false; if (v.new_patient_only && v.existing_only) throw new Error('A type cannot be both new-only and existing-only.'); const body = Object.assign({}, v, { agent_permissions: { book: v.perm_book, reschedule: v.perm_reschedule, cancel: v.perm_cancel } }); delete body.perm_book; delete body.perm_reschedule; delete body.perm_cancel; if (body.min_age === undefined) body.min_age = null; if (body.max_age === undefined) body.max_age = null; if (t) await api('/appointment-types/' + t.id, { method: 'PATCH', body }); else await api('/appointment-types', { method: 'POST', body }); toast('Saved', 'ok'); render(); } }] });
  }

  async function integrations(b, ro) {
    const d = await api('/integrations');
    b.append(h('div', { class: 'panel' }, h('h2', {}, 'Scheduling system'), h('p', {}, 'Active: ', tag(d.active === 'native' ? 'Built-in calendar' : d.active, 'ok')),
      h('p', { class: 'muted' }, 'The built-in calendar needs no setup. The Open Dental adapter included here is a starting point that must be verified against your office and Open Dental\'s current API documentation before production use.'),
      h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: async () => { const r = await api('/integrations/test', { method: 'POST' }); toast(r.message, r.ok ? 'ok' : 'bad'); } }, 'Test connection')));
    if (state.me.user.role === 'owner') {
      const f = form([{ key: 'pms_type', label: 'System', type: 'select', options: [{ value: 'native', label: 'Built-in calendar' }, { value: 'opendental', label: 'Open Dental (experimental)' }] }, { key: 'baseUrl', label: 'API base URL', optional: true, placeholder: 'https://api.opendental.com/api/v1' }, { key: 'developerKey', label: 'Developer key', type: 'password', optional: true }, { key: 'customerKey', label: 'Customer key', type: 'password', optional: true }], { pms_type: d.active });
      b.append(h('div', { class: 'panel' }, h('h2', {}, 'Change integration'), f.el, h('p', { class: 'muted' }, 'Keys are encrypted on the server and never shown again.'), h('button', { class: 'btn', type: 'button', onclick: async () => { const v = f.values(); if (!v) return; try { const body = { pms_type: v.pms_type }; if (v.baseUrl) body.baseUrl = v.baseUrl; if (v.developerKey) body.developerKey = v.developerKey; if (v.customerKey) body.customerKey = v.customerKey; const r = await api('/integrations', { method: 'POST', body }); toast(r.test.message, r.test.ok ? 'ok' : 'bad'); render(); } catch (e) { toast(e.message, 'bad'); } } }, 'Save integration')));
    }
    const base = state.me.features.base_url;
    b.append(h('div', { class: 'panel' }, h('h2', {}, 'Phone and text (Twilio)'), h('p', { class: 'muted' }, 'In your Twilio console, set your number\'s webhooks to:'), h('div', { class: 'trace' }, `Voice (HTTP POST):  ${base}/webhooks/twilio/voice\nCall status:        ${base}/webhooks/twilio/voice/status\nMessaging (POST):   ${base}/webhooks/twilio/sms`), h('p', { class: 'muted' }, 'These addresses must be publicly reachable over HTTPS (use a tunnel such as ngrok while testing locally and set BASE_URL in .env). Status: ' + (state.me.features.sms_provider === 'twilio' ? 'Twilio credentials detected.' : 'No Twilio credentials set, so calls and texts are simulated.'))));
  }
  async function users(b, ro) {
    const d = await api('/users');
    b.append(h('div', { class: 'panel flush' }, table(['Name', 'Email', 'Role', 'Two-step sign-in', 'Last sign-in', ''], d.users.map((u) => h('tr', {}, h('td', {}, u.name), h('td', {}, u.email), h('td', {}, tag(u.role)), h('td', {}, tag(u.mfa_enabled ? 'On' : 'Off', u.mfa_enabled ? 'ok' : 'warn')), h('td', {}, u.last_login ? ago(u.last_login) : 'Never'),
      h('td', {}, state.me.user.role === 'owner' && u.id !== state.me.user.id ? h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { if (await confirmDlg('Remove ' + u.email + '?', 'Remove')) { await api('/users/' + u.id, { method: 'DELETE' }); render(); } } }, 'Remove') : null))), { empty: 'No users.' })));
    if (state.me.user.role === 'owner') b.append(h('button', { class: 'btn', type: 'button', onclick: () => { const f = form([{ key: 'name', label: 'Full name', required: true, maxlength: 80 }, { key: 'email', label: 'Email', type: 'email', required: true }, { key: 'role', label: 'Role', type: 'select', options: ['manager', 'staff', 'readonly'] }, { key: 'password', label: 'Temporary password', type: 'password', required: true, pattern: '^(?=.*[A-Za-z])(?=.*\\d).{10,}$', patternMsg: 'At least 10 characters with a letter and a number.' }]); modal({ title: 'Add user', body: f.el, actions: [{ label: 'Cancel', ghost: true }, { label: 'Add user', onclick: async () => { const v = f.values(); if (!v) return false; await api('/users', { method: 'POST', body: v }); toast('User added', 'ok'); render(); } }] }); } }, 'Add user'));
  }
  async function security(b) {
    const u = state.me.user;
    const mfa = h('div', { class: 'panel' }, h('h2', {}, 'Two-step sign-in (authenticator app)'));
    if (u.mfa_enabled) mfa.append(h('p', {}, tag('Enabled', 'ok')), h('button', { class: 'btn sm danger', type: 'button', onclick: () => { const f = form([{ key: 'password', label: 'Confirm your password', type: 'password', required: true }]); modal({ title: 'Turn off two-step sign-in', body: f.el, actions: [{ label: 'Cancel', ghost: true }, { label: 'Turn off', danger: true, onclick: async () => { const v = f.values(); if (!v) return false; await DF.authApi('/mfa/disable', { password: v.password }); state.me.user.mfa_enabled = 0; toast('Turned off', 'ok'); render(); } }] }); } }, 'Turn off'));
    else mfa.append(h('p', { class: 'muted' }, 'Strongly recommended: protects patient data if your password is stolen.'), h('button', { class: 'btn sm', type: 'button', onclick: async () => { const s = await DF.authApi('/mfa/setup'); const f = form([{ key: 'code', label: '6-digit code from your app', required: true, pattern: '^\\d{6}$', patternMsg: 'Enter the 6 digits.' }]); modal({ title: 'Set up two-step sign-in', body: h('div', { class: 'stack' }, h('p', {}, 'Add this key to Google Authenticator, Authy or 1Password (choose "enter a setup key"):'), h('div', { class: 'trace' }, s.secret), h('p', { class: 'muted' }, 'Then enter the code it shows.'), f.el), actions: [{ label: 'Cancel', ghost: true }, { label: 'Turn on', onclick: async () => { const v = f.values(); if (!v) return false; await DF.authApi('/mfa/enable', { code: v.code }); state.me.user.mfa_enabled = 1; toast('Two-step sign-in is on', 'ok'); render(); } }] }); } }, 'Set up'));
    const pf = form([{ key: 'current', label: 'Current password', type: 'password', required: true }, { key: 'next', label: 'New password', type: 'password', required: true, pattern: '^(?=.*[A-Za-z])(?=.*\\d).{10,}$', patternMsg: 'At least 10 characters with a letter and a number.' }]);
    b.append(mfa, h('div', { class: 'panel' }, h('h2', {}, 'Change password'), pf.el, h('button', { class: 'btn', type: 'button', onclick: async () => { const v = pf.values(); if (!v) return; try { await DF.authApi('/password', v); toast('Password changed', 'ok'); render(); } catch (e) { toast(e.message, 'bad'); } } }, 'Change password')));
  }
  async function versions(b, ro) {
    if (ro) return;
    const d = await api('/settings/versions');
    b.append(h('div', { class: 'panel flush' }, table(['When', 'Changed by', ''], d.versions.map((x) => h('tr', {}, h('td', {}, fmt(x.ts)), h('td', {}, x.author), h('td', {}, h('button', { class: 'btn sm btn-ghost', type: 'button', onclick: async () => { if (await confirmDlg('Restore the settings as they were before this change?', 'Restore')) { await api('/settings/versions/' + x.id + '/rollback', { method: 'POST' }); toast('Settings restored', 'ok'); render(); } } }, 'Restore previous settings')))), { empty: 'No changes yet.' })));
  }

  // ================================================================== BILLING & AUDIT
  routes.billing = {
    title: 'Billing & usage', live: false,
    async render(v) {
      const d = await api('/billing/usage');
      v.append(DF.pageHead('Billing & usage', 'Usage over the last 30 days.', []));
      const names = { voice_min: 'Phone minutes', sms: 'Text messages', llm_turn: 'AI turns', llm_token_k: 'AI tokens (thousands)' };
      v.append(h('div', { class: 'kpis' }, h('div', { class: 'kpi' }, h('div', { class: 'v' }, d.plan), h('div', { class: 'l' }, 'Plan'), h('div', { class: 'n' }, '$' + d.plan_price_usd + ' per location / month')), h('div', { class: 'kpi' }, h('div', { class: 'v' }, '$' + d.variable_cost_usd.toFixed(2)), h('div', { class: 'l' }, 'Metered usage cost'), h('div', { class: 'n' }, 'Cap: $' + d.spend_cap_usd))));
      v.append(h('div', { class: 'panel flush' }, table(['Usage', 'Quantity', 'Cost'], d.usage.map((u) => h('tr', {}, h('td', {}, names[u.kind] || u.kind), h('td', {}, u.quantity), h('td', {}, '$' + u.cost_usd.toFixed(2)))), { empty: 'No usage yet.' })));
      if (state.me.user.role === 'owner') v.append(h('div', { class: 'panel' }, h('h2', {}, 'Subscription'), d.stripe_configured ? h('button', { class: 'btn', type: 'button', onclick: async () => { try { const r = await api('/billing/checkout', { method: 'POST' }); location.href = r.url; } catch (e) { toast(e.message, 'bad'); } } }, 'Manage subscription (Stripe)') : h('p', { class: 'muted' }, 'Stripe is not configured. Add your Stripe keys to the .env file on your server (see the README) to enable checkout.')));
      v.append(h('p', { class: 'muted' }, 'Unit costs shown are placeholders you should set to your real vendor rates.'));
    },
  };
  routes.audit = {
    title: 'Audit log', live: false,
    async render(v) {
      v.append(DF.pageHead('Audit log', 'Who accessed or changed what. Entries cannot be edited.', []));
      if (!['owner', 'manager'].includes(state.me.user.role)) { v.append(h('div', { class: 'alert warn' }, 'Only owners and managers can view the audit log.')); return; }
      const d = await api('/audit', { qs: { limit: 200 } });
      v.append(h('div', { class: 'panel flush' }, table(['When', 'Who', 'Action', 'Resource', 'Detail'], d.logs.map((l) => h('tr', {}, h('td', {}, fmt(l.ts)), h('td', {}, l.actor), h('td', {}, tag(l.action.replace(/_/g, ' '))), h('td', {}, l.resource || ''), h('td', { class: 'muted' }, (l.detail || '').slice(0, 120)))), { empty: 'No entries.' })));
    },
  };
})();
