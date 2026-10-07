// Conversation orchestrator: lifecycle (start / turn / end), deterministic triage, engine selection,
// persistence of transcripts and tool traces, and the post-call pipeline.
const { db, uid, nowIso, j, parse } = require('../db');
const clock = require('../clock');
const tz = require('../tz');
const core = require('./core');
const comms = require('./comms');
const patients = require('./patients');
const scheduling = require('./scheduling');
const tools = require('../agent/tools');
const offline = require('../agent/offline');
const llm = require('../agent/llm');
const cfg = require('../config');

const getConversation = (id) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);

function greeting(loc, channel) {
  const s = loc.settings;
  if (s.greeting) return s.greeting.replace(/\{clinic\}/g, loc.name).replace(/\{agent\}/g, s.agent_name);
  if (channel === 'voice') {
    return `Thanks for calling ${loc.name}. This is ${s.agent_name}, the practice's virtual assistant${s.recording_disclosure ? ', and this call may be recorded for quality' : ''}. How can I help you today?`;
  }
  return `Hi! I'm ${s.agent_name}, the virtual assistant for ${loc.name}. I can help you book, reschedule or cancel an appointment, or answer questions about the practice. How can I help? (If this is a medical emergency, please call 911.)`;
}

function addMessage(conversationId, role, text, confidence = null) {
  db.prepare('INSERT INTO messages (id,conversation_id,role,text,redacted_text,confidence,ts) VALUES (?,?,?,?,?,?,?)')
    .run(uid(), conversationId, role, text, core.redact(text), confidence, nowIso());
}

// Start a conversation, or resume an active one for the same external id (SMS thread / chat session)
function start({ locationId, channel, externalId = null, from = null, resumeWithinMin = null, preState = null, silent = false }) {
  const loc = core.getLocation(locationId);
  if (!loc) throw new Error('Unknown location');
  if (externalId && resumeWithinMin) {
    const since = new Date(clock.now().getTime() - resumeWithinMin * 60000).toISOString();
    const ex = db.prepare("SELECT * FROM conversations WHERE location_id=? AND channel=? AND external_id=? AND status='active' AND last_activity>? ORDER BY started_at DESC LIMIT 1").get(locationId, channel, externalId, since);
    if (ex) return { conversation: ex, resumed: true, greeting: null };
  }
  const id = uid();
  const now = clock.now();
  const state = { step: 'INTENT', patient: {}, ...(preState || {}) };
  db.prepare(`INSERT INTO conversations (id,tenant_id,location_id,channel,external_id,from_number,state_json,status,after_hours,started_at,last_activity,language)
              VALUES (?,?,?,?,?,?,?,'active',?,?,?,?)`)
    .run(id, loc.tenant_id, locationId, channel, externalId, from ? core.normalizePhone(from) : null, j(state), core.isOpenNow(loc, now) ? 0 : 1, now.toISOString(), now.toISOString(), loc.settings.language || 'en');
  const g = greeting(loc, channel);
  if (!silent) addMessage(id, 'agent', g);
  core.emit(loc.tenant_id, 'conversation.started', { id, channel });
  return { conversation: getConversation(id), resumed: false, greeting: g };
}

function makeCtx(conv) {
  const loc = core.getLocation(conv.location_id);
  return { tenantId: conv.tenant_id, locationId: conv.location_id, loc, conv, state: parse(conv.state_json, {}), now: () => clock.now() };
}

function persist(ctx) {
  db.prepare('UPDATE conversations SET state_json=?, last_activity=?, engine=COALESCE(?, engine) WHERE id=?').run(j(ctx.state), nowIso(), ctx.engine || null, ctx.conv.id);
}

async function turn({ conversationId, text, confidence = null }) {
  const conv = getConversation(conversationId);
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (conv.status !== 'active') return { reply: 'This conversation has ended. Please start a new one if you need anything else.', ended: true, conversation_id: conv.id };
  if (!clean) return { reply: "I'm sorry, I didn't catch that. Could you say it again?", ended: false, conversation_id: conv.id };

  const ctx = makeCtx(conv);
  const history = db.prepare('SELECT role, text FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 16').all(conv.id).reverse();
  addMessage(conv.id, 'patient', clean, confidence);
  core.recordUsage(ctx.tenantId, conv.id, 'llm_turn', 1);

  let result;
  // Layer 1: deterministic emergency triage on every caller turn (cannot be bypassed by the model)
  const tri = comms.triage(clean);
  if (tri.level === 'life_threatening') {
    const r = tools.applyTriage(ctx, { level: 'life_threatening', rule: tri.rule, text: clean });
    result = { reply: r.script, end: true };
    ctx.engine = 'triage';
  } else {
    if (tri.level === 'urgent') tools.applyTriage(ctx, { level: 'urgent', rule: tri.rule, text: clean });
    let out = null;
    if (cfg.anthropic.key) out = await llm.handleTurn(ctx, clean, history);
    if (out) { result = out; ctx.engine = out.degraded ? 'degraded' : 'claude'; }
    else { result = offline.handleTurn(ctx, clean); ctx.engine = 'builtin'; }
  }

  addMessage(conv.id, 'agent', result.reply);
  persist(ctx);
  core.emit(ctx.tenantId, 'conversation.updated', { id: conv.id });
  let ended = !!result.end || !!ctx.state.ended;
  if (ended) finalize(conv.id, result.transfer ? 'transferred' : 'completed');
  return { reply: result.reply, ended, transfer: result.transfer ? (ctx.state.transfer || { to: ctx.loc.phone }) : null, conversation_id: conv.id, engine: ctx.engine,
    state: { step: ctx.state.step, verified: !!ctx.state.verified, outcome: getConversation(conv.id).outcome } };
}

// ------------------------------------------------------------------ post-call pipeline
function buildSummary(conv, ctx) {
  const st = ctx.state; const p = st.patient || {};
  const who = p.first_name ? `${p.first_name} ${p.last_name || ''}`.trim() : 'Caller';
  const via = conv.channel === 'voice' ? 'call' : conv.channel === 'sms' ? 'text thread' : 'chat';
  const appt = st.appointment_id ? scheduling.getAppointment(st.appointment_id) : null;
  const parts = [];
  switch (conv.outcome) {
    case 'booked': parts.push(`${st.new_patient === false && conv.new_patient ? 'New patient ' : ''}${who} booked ${appt ? `${appt.type_name} with ${appt.provider_name} on ${tz.speak(new Date(appt.start_utc), ctx.loc.timezone)}` : 'an appointment'}.`); break;
    case 'rescheduled': parts.push(`${who} rescheduled${appt ? ` to ${appt.type_name} on ${tz.speak(new Date(appt.start_utc), ctx.loc.timezone)}` : ' an appointment'}.`); break;
    case 'cancelled': parts.push(`${who} cancelled an appointment.`); break;
    case 'emergency_911': parts.push(`${who} described possible life-threatening symptoms and was directed to 911 / the ER. Staff alerted.`); break;
    case 'faq': parts.push(`${who} asked a general question about the practice and was answered.`); break;
    case 'handoff': parts.push(`${who} was transferred to staff${st.handoff_reason ? ` (${st.handoff_reason})` : ''}.`); break;
    case 'callback': parts.push(`${who} needs a callback${st.handoff_reason ? `: ${st.handoff_reason}` : ''}.`); break;
    case 'waitlisted': parts.push(`${who} was added to the waitlist.`); break;
    default: parts.push(`${who} contacted the practice by ${via}${conv.intent ? ` about ${conv.intent}` : ''}; no action was completed.`);
  }
  if (st.urgent && conv.outcome !== 'emergency_911') parts.push('Urgent dental issue reported.');
  if (st.insurance) parts.push(`Insurance: ${st.insurance.carrier}.`);
  return parts.join(' ');
}

function scoreQuality(conv) {
  const errs = db.prepare("SELECT COUNT(*) n FROM tool_calls WHERE conversation_id=? AND status='error'").get(conv.id).n;
  const unanswered = db.prepare('SELECT COUNT(*) n FROM unanswered_questions WHERE conversation_id=?').get(conv.id).n;
  let s = 1 - Math.min(0.5, errs * 0.1) - Math.min(0.2, unanswered * 0.1);
  if (conv.handoff && conv.outcome !== 'emergency_911') s -= 0.15;
  if (conv.outcome === 'emergency_911') s = Math.max(s, 0.9);
  return Math.max(0, Math.round(s * 100) / 100);
}

function finalize(conversationId, reason = 'completed') {
  const conv = getConversation(conversationId);
  if (!conv || conv.status === 'ended') return conv;
  const ctx = makeCtx(conv);
  const st = ctx.state;
  scheduling.releaseHoldsFor(conv.id);
  // Booking intent that never completed -> make sure staff can follow up
  const done = ['booked', 'rescheduled', 'cancelled', 'emergency_911', 'handoff', 'callback', 'waitlisted', 'faq'].includes(conv.outcome);
  if (!done && st.intent === 'book' && (st.patient?.mobile || conv.from_number) && (st.patient?.first_name)) {
    comms.createTask({ tenantId: conv.tenant_id, locationId: conv.location_id, kind: 'callback', urgency: st.urgent ? 'high' : 'normal', conversationId: conv.id, patientId: st.patient_id || null,
      title: `Unfinished booking: ${st.patient.first_name} ${st.patient.last_name || ''} (${st.patient.mobile || conv.from_number}) wanted an appointment`.replace(/\s+/g, ' '), payload: { reason: 'incomplete_booking' } });
    db.prepare("UPDATE conversations SET outcome='callback' WHERE id=? AND outcome IS NULL").run(conv.id);
    conv.outcome = 'callback';
  }
  const fresh = getConversation(conv.id);
  const summary = buildSummary(fresh, ctx);
  const durMin = Math.max(0.2, (clock.now() - new Date(conv.started_at)) / 60000);
  db.prepare("UPDATE conversations SET status='ended', ended_at=?, summary=?, qa_score=?, outcome=COALESCE(outcome, ?) WHERE id=?")
    .run(nowIso(), summary, scoreQuality(fresh), fresh.outcome || (fresh.intent === 'faq' ? 'faq' : 'no_action'), conv.id);
  if (conv.channel === 'voice') core.recordUsage(conv.tenant_id, conv.id, 'voice_min', Math.round(durMin * 100) / 100);
  core.emit(conv.tenant_id, 'conversation.ended', { id: conv.id, reason });
  // Optional richer LLM summary (async, best effort)
  if (cfg.anthropic.key) {
    const tr = db.prepare('SELECT role,text FROM messages WHERE conversation_id=? ORDER BY ts').all(conv.id).map((m) => `${m.role}: ${core.redact(m.text)}`).join('\n');
    llm.summarize(tr).then((s) => { if (s) db.prepare('UPDATE conversations SET summary=? WHERE id=?').run(s, conv.id); }).catch(() => {});
  }
  return getConversation(conv.id);
}

function endIdle(maxIdleMin = 20) {
  const cutoff = new Date(clock.now().getTime() - maxIdleMin * 60000).toISOString();
  const rows = db.prepare("SELECT id FROM conversations WHERE status='active' AND last_activity<?").all(cutoff);
  for (const r of rows) finalize(r.id, 'idle');
  return rows.length;
}

function detail(conversationId) {
  const conv = getConversation(conversationId);
  if (!conv) return null;
  const messages = db.prepare('SELECT id, role, text, confidence, ts FROM messages WHERE conversation_id=? ORDER BY rowid').all(conv.id);
  const calls = db.prepare('SELECT id,name,args_json,result_json,status,latency_ms,ts FROM tool_calls WHERE conversation_id=? ORDER BY rowid').all(conv.id)
    .map((c) => ({ ...c, args: parse(c.args_json, {}), result: parse(c.result_json, {}) }));
  const triage = db.prepare('SELECT * FROM triage_events WHERE conversation_id=?').all(conv.id);
  const tasks = db.prepare('SELECT id,kind,status,urgency,title FROM tasks WHERE conversation_id=?').all(conv.id);
  const appts = db.prepare('SELECT id FROM appointments WHERE conversation_id=?').all(conv.id).map((a) => scheduling.getAppointment(a.id));
  const st = parse(conv.state_json, {});
  const { state_json, ...rest } = conv;
  return { ...rest, patient_name: st.patient && st.patient.first_name ? `${st.patient.first_name} ${st.patient.last_name || ''}`.trim() : null, messages, tool_calls: calls, triage, tasks, appointments: appts };
}

module.exports = { start, turn, finalize, endIdle, detail, getConversation, greeting, addMessage, makeCtx };
