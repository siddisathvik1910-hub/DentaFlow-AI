// Built-in conversation engine: a slot-filling state machine over the shared tool layer.
// It needs no API key, is fully deterministic, and doubles as the fallback if the LLM is unavailable.
const nlu = require('./nlu');
const tools = require('./tools');
const tz = require('../tz');
const core = require('../services/core');
const scheduling = require('../services/scheduling');
const comms = require('../services/comms');

const T = (ctx, name, args) => tools.runTool(ctx, name, args);
const isVoice = (ctx) => ctx.conv.channel === 'voice';
const ask = (ctx, step, reply) => { ctx.state.step = step; return { reply }; };
const joinReply = (prefix, r) => (prefix && r && r.reply ? { ...r, reply: `${prefix} ${r.reply}`.replace(/\s+/g, ' ').trim() } : r);
const first = (ctx) => ctx.state.patient && ctx.state.patient.first_name;
const last4 = (ctx) => { const m = tools.mobileFor(ctx); return m ? m.slice(-4) : null; };

function resetFlow(st) {
  for (const k of ['intent', 'reason', 'appointment_type_id', 'prefs', 'prefs_set', 'offered_slots', 'chosen', 'target_appt_id', 'appt_choices', 'rejections', 'relaxed', 'reason_asked', 'prefs_tries', 'name_tries', 'dob_tries', 'phone_tries', 'misses']) delete st[k];
  st.step = 'INTENT';
}
const mergePrefs = (a, b) => ({ ...(a || {}), ...Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== null && v !== false && !(Array.isArray(v) && !v.length) && k !== 'hasPref')), days: [...new Set([...(a?.days || []), ...(b.days || [])])] });

// Pull every recognizable detail out of a message, whatever step we are on
function harvest(ctx, text, expecting) {
  const st = ctx.state;
  st.patient = st.patient || {};
  const p = st.patient;
  const nm = nlu.extractName(text, expecting === 'name' || expecting === 'last');
  if (nm && !st.verified && !st.patient_id) {
    if (expecting === 'last' && !nm.last && p.first_name && nm.first) p.last_name = nm.first;
    else { if (nm.first && (!p.first_name || expecting === 'name' || nm.last)) p.first_name = nm.first; if (nm.last) p.last_name = nm.last; }
  }
  const dob = nlu.extractDOB(text, ctx.now());
  if (dob && !st.verified && !st.patient_id) p.dob = dob;
  const ph = nlu.extractPhone(text);
  if (ph) p.mobile = ph;
  const em = nlu.extractEmail(text);
  if (em) p.email = em;
  const status = nlu.patientStatus(text);
  if (status) st.declared_status = status;
  if (['book', 'reschedule'].includes(st.intent) || expecting === 'prefs') {
    const pr = nlu.extractPrefs(nlu.stripDOB(text), ctx.now(), ctx.loc.timezone);
    if (pr.hasPref) { st.prefs = mergePrefs(st.prefs, pr); st.prefs_set = true; }
  }
  if (expecting === 'insurance' || /\b(insurance|dental plan)\b/i.test(text)) {
    const ins = nlu.extractInsurance(text, ctx.loc.settings.accepted_insurance || []);
    if (ins && !st.insurance) { const r = T(ctx, 'record_insurance', { carrier: ins.carrier }); st.insurance_note = r.in_accepted_list; }
  }
}

function endWith(ctx, reply) { ctx.state.ended = true; return { reply, end: true }; }
function farewell(ctx) {
  const n = first(ctx);
  return endWith(ctx, isVoice(ctx) ? `Thanks for calling ${ctx.loc.name}${n ? ', ' + n : ''}. Take care, goodbye!` : `Thanks for chatting with ${ctx.loc.name}${n ? ', ' + n : ''}. Take care!`);
}
function anythingElse(ctx, lead) { ctx.state.step = 'CLOSE'; return { reply: `${lead ? lead + ' ' : ''}Is there anything else I can help you with?` }; }

function handoff(ctx, reason) {
  const r = T(ctx, 'transfer_call', { reason });
  if (r.transferred) { ctx.state.ended = true; return { reply: 'Of course. I am connecting you with our team now. Please hold for just a moment.', end: true, transfer: true }; }
  ctx.state.ended = true;
  const phone = ctx.loc.phone ? ` You can also reach the office at ${ctx.loc.phone}.` : '';
  const closed = !core.isOpenNow(ctx.loc, ctx.now());
  return { reply: `${closed ? `Our office is closed right now (${core.hoursSpoken(ctx.loc)}). ` : ''}I've asked our team to follow up with you${closed ? ' first thing when we open' : ' shortly'}.${phone} Thank you for your patience.`, end: true };
}

// ------------------------------------------------------------------ identity
function identify(ctx, { allowNew }) {
  const st = ctx.state; const p = st.patient;
  if (st.verified) return null;
  if (st.identity_result === 'new' && allowNew) return null;
  if (!p.first_name) return ask(ctx, 'ASK_NAME', 'May I have your first and last name?');
  if (!p.last_name) return ask(ctx, 'ASK_LAST', `Thanks, ${p.first_name}. And your last name?`);
  if (!p.dob) return ask(ctx, 'ASK_DOB', 'Thank you. And your date of birth?');
  const r = T(ctx, 'verify_identity', { first_name: p.first_name, last_name: p.last_name, dob: p.dob });
  if (r.verified) return null;
  if (r.error && r.error.code === 'LOCKED') return endWith(ctx, "I'm sorry, I'm not able to verify your details. I've asked our team to call you back so we can help you directly. Thank you for your patience.");
  if (r.reason === 'no_record') {
    st.identity_result = 'new'; st.new_patient = true;
    if (allowNew) return null;
    comms.createTask({ tenantId: ctx.tenantId, locationId: ctx.locationId, kind: 'callback', conversationId: ctx.conv.id, title: `Could not find a record for ${p.first_name} ${p.last_name} (${ctx.conv.from_number || 'no number'})`, payload: { intent: st.intent } });
    tools.setConv(ctx, { outcome: 'callback' });
    return anythingElse(ctx, "I'm not finding a record under that name and date of birth, so I've asked our team to look into it and follow up with you.");
  }
  if (r.reason === 'dob_mismatch') {
    if (r.locked || r.attempts_left === 0) return endWith(ctx, "I'm sorry, that doesn't match what we have on file, and I'm not able to share account details without verifying. I've asked our team to call you back. Thank you for your patience.");
    p.dob = null;
    return ask(ctx, 'ASK_DOB', "That doesn't match what I have on file. Could you repeat your date of birth?");
  }
  if (r.error && r.error.code === 'BAD_DOB') { p.dob = null; return ask(ctx, 'ASK_DOB', "Sorry, I didn't catch that date. Could you say your date of birth, for example April 12th, 1988?"); }
  return handoff(ctx, 'Identity check failed');
}

// ------------------------------------------------------------------ booking
const listSlots = (ctx, slots) => {
  if (isVoice(ctx)) {
    // Group by day: "Thursday, October 16 at 8:00 AM with Dr. Patel, 9:00 AM with Dr. Lee, or Tuesday ..."
    const groups = [];
    for (const s of slots) {
      const i = s.spoken.lastIndexOf(' at ');
      const day = s.spoken.slice(0, i); const time = s.spoken.slice(i + 4);
      const g = groups.find((x) => x.day === day);
      const item = `${time} with ${s.provider_name}`;
      if (g) g.items.push(item); else groups.push({ day, items: [item] });
    }
    const orJoin = (a) => (a.length === 1 ? a[0] : `${a.slice(0, -1).join(', ')}, or ${a[a.length - 1]}`);
    if (groups.length === 1) return `${groups[0].day} at ${orJoin(groups[0].items)}`;
    const parts = groups.map((g) => `${g.day} at ${g.items.join(', ')}`);
    return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join('; ')}; or ${parts[parts.length - 1]}`;
  }
  return '\n' + slots.map((s, i) => `${i + 1}) ${s.spoken} with ${s.provider_name}`).join('\n');
};

function reasonMatched(ctx, text) {
  const t = String(text || '').toLowerCase();
  return scheduling.getTypes(ctx.locationId).some((ty) => ty.keywords.some((k) => k && t.includes(k.toLowerCase())));
}

function advanceBook(ctx) {
  const st = ctx.state; const p = st.patient;
  const idr = identify(ctx, { allowNew: true }); if (idr) return idr;
  if (!p.mobile && ctx.conv.from_number) p.mobile = ctx.conv.from_number;
  if (!p.mobile) return ask(ctx, 'ASK_PHONE', "What's the best mobile number to text your confirmation to?");
  if (!st.appointment_type_id) {
    const isNew = st.new_patient !== false;
    if (!st.urgent && !st.reason_asked && !isNew && !reasonMatched(ctx, st.reason)) { st.reason_asked = true; return ask(ctx, 'ASK_REASON', 'What brings you in: a cleaning, a checkup, or something else?'); }
    const type = scheduling.typeFromText(ctx.locationId, st.reason, { isNew, urgent: !!st.urgent });
    if (!type) return handoff(ctx, 'No appointment type configured');
    st.appointment_type_id = type.id;
  }
  const type = scheduling.getType(st.appointment_type_id);
  if (type.agent_permissions.book === false) {
    comms.createTask({ tenantId: ctx.tenantId, locationId: ctx.locationId, kind: 'callback', urgency: 'high', patientId: st.patient_id || null, conversationId: ctx.conv.id, title: `Schedule ${type.name} (staff only): ${p.first_name || ''} ${p.last_name || ''} ${p.mobile || ''}`.trim(), payload: { type: type.code } });
    tools.setConv(ctx, { outcome: 'callback' });
    return anythingElse(ctx, `${type.name} appointments need to be scheduled by our team so they can plan the right amount of time. I've sent them a request and they'll call you to set it up.`);
  }
  if (st.new_patient && !st.urgent && !st.insurance && !st.insurance_asked) { st.insurance_asked = true; return ask(ctx, 'ASK_INSURANCE', 'Do you have dental insurance? If so, who is the carrier?'); }
  if (!st.prefs_set && !st.urgent) return ask(ctx, 'ASK_PREFS', 'What days and times usually work best for you?');
  return searchAndOffer(ctx);
}

function searchAndOffer(ctx, prefix = '') {
  const st = ctx.state; const pr = st.prefs || {};
  const type = scheduling.getType(st.appointment_type_id);
  const base = { appointment_type: type.code, earliest_date: pr.fromDate || undefined, latest_date: pr.toDate || undefined, preferred_days: (pr.days || []).map(Number), time_of_day: pr.tod || undefined, after: pr.after || undefined, before: pr.before || undefined };
  let r = T(ctx, 'get_availability', { ...base, relax: 0 }); let relaxed = 0;
  if (r.error && !r.slots) return handoff(ctx, `Availability error: ${r.error.message}`);
  if (!(r.slots || []).length && !st.urgent) { r = T(ctx, 'get_availability', { ...base, relax: 1 }); relaxed = 1; }
  if (!(r.slots || []).length) { r = T(ctx, 'get_availability', { ...base, relax: 2 }); relaxed = 2; }
  if (!(r.slots || []).length) {
    return ask(ctx, 'WAITLIST_OFFER', `${prefix} I'm not seeing any openings for that right now. I can add you to our waitlist and text you as soon as something opens up. Would you like that?`.trim());
  }
  st.relaxed = relaxed;
  const slots = st.offered_slots;
  const note = relaxed ? "I don't have anything that exactly matches that, but here are the closest openings. " : (st.urgent ? 'Here are the earliest openings. ' : '');
  const intro = slots.length === 1 ? 'I have one opening:' : 'I have these openings:';
  const tail = slots.length === 1 ? ' Would that work for you?' : (isVoice(ctx) ? ' Which works best for you?' : '\nWhich works best for you?');
  return ask(ctx, 'OFFER', `${prefix} ${note}${isVoice(ctx) ? intro.replace(':', '') + ' ' : intro}${listSlots(ctx, slots)}${isVoice(ctx) ? '.' : ''}${tail}`.replace(/\.\./g, '.').replace(/\s+/g, (m) => (m.includes('\n') ? m : ' ')).trim());
}

function confirmText(ctx) {
  const st = ctx.state; const s = st.chosen; const p = st.patient;
  const l4 = last4(ctx);
  if (st.intent === 'reschedule') {
    const old = st.appt_choices.find((a) => a.id === st.target_appt_id);
    return `Just to confirm: I'll move your ${old.type_name} from ${old.spoken_abs} to ${s.spoken} with ${s.provider_name}. Shall I make that change?`;
  }
  return `Just to confirm: ${s.type_name} with ${s.provider_name} on ${s.spoken}, for ${p.first_name} ${p.last_name}${l4 ? `, and I'll text the confirmation to the number ending in ${l4}` : ''}. Shall I book that?`;
}

function executeBook(ctx) {
  const st = ctx.state; const p = st.patient; const s = st.chosen;
  const r = T(ctx, 'book_appointment', { slot_id: s.slot_id, hold_token: st.hold_token || undefined, confirmed_by_caller: true, reason: st.reason || undefined, patient: { first_name: p.first_name, last_name: p.last_name, dob: p.dob, mobile: p.mobile, email: p.email } });
  if (r.booked) {
    const a = r.appointment;
    const bits = [`You're all set${first(ctx) ? ', ' + first(ctx) : ''}! I've booked your ${a.type} with ${a.provider} on ${a.when}.`];
    if (r.sms_confirmation_sent && last4(ctx)) bits.push(`I'm texting a confirmation to the number ending in ${last4(ctx)}.`);
    if (st.new_patient) bits.push('Please arrive about ten minutes early and bring your photo ID and insurance card.');
    if (st.insurance && !/self|unsure/i.test(st.insurance.carrier)) bits.push(st.insurance_note ? `We work with ${st.insurance.carrier}, and our team will verify your benefits before your visit.` : `Our team will check your ${st.insurance.carrier} plan before your visit.`);
    st.new_patient = false;
    return anythingElse(ctx, bits.join(' '));
  }
  const code = r.error && r.error.code;
  if (code === 'SLOT_TAKEN' || code === 'SLOT_HELD' || code === 'LEAD_TIME') return searchAndOffer(ctx, "I'm sorry, that time was just taken.");
  if (code === 'MISSING_FIELDS') { if (!p.mobile) return ask(ctx, 'ASK_PHONE', "What's the best mobile number to text your confirmation to?"); if (!p.dob) { return ask(ctx, 'ASK_DOB', 'And your date of birth?'); } }
  if (code === 'NO_PERMISSION') return handoff(ctx, 'Appointment type needs staff scheduling');
  return handoff(ctx, `Booking failed: ${r.error && r.error.message}`);
}

function executeReschedule(ctx) {
  const st = ctx.state; const s = st.chosen;
  const r = T(ctx, 'reschedule_appointment', { appointment_id: st.target_appt_id, new_slot_id: s.slot_id, hold_token: st.hold_token || undefined, confirmed_by_caller: true });
  if (r.rescheduled) { const a = r.appointment; return anythingElse(ctx, `Done! Your ${a.type} is now ${a.when} with ${a.provider}.${last4(ctx) && ctx.conv.channel !== 'sms' ? " I'm texting you the new details." : ''}`); }
  const code = r.error && r.error.code;
  if (code === 'SLOT_TAKEN' || code === 'SLOT_HELD') return searchAndOffer(ctx, "I'm sorry, that time was just taken.");
  return handoff(ctx, `Reschedule failed: ${r.error && r.error.message}`);
}

// ------------------------------------------------------------------ manage existing appointments
function loadAppointments(ctx) {
  const list = scheduling.listForPatient(ctx.state.patient_id);
  const loc = ctx.loc;
  ctx.state.appt_choices = list.map((a) => ({ id: a.id, type_id: a.type_id, type_name: a.type_name, provider_name: a.provider_name, local_date: a.local_date, local_time: a.local_time, start_utc: a.start_utc, spoken_abs: tz.speak(new Date(a.start_utc), loc.timezone) }));
  return ctx.state.appt_choices;
}

function advanceManage(ctx, kind) {
  const st = ctx.state;
  const idr = identify(ctx, { allowNew: false }); if (idr) return idr;
  if (!st.verified) return null;
  const appts = st.appt_choices || loadAppointments(ctx);
  if (!appts.length) {
    if (kind === 'reschedule' || kind === 'cancel') { return ask(ctx, 'REBOOK', `${first(ctx) ? first(ctx) + ', ' : ''}I don't see any upcoming appointments for you. Would you like to book one?`); }
    return ask(ctx, 'REBOOK', "I don't see any upcoming appointments for you. Would you like to book one?");
  }
  if (kind === 'lookup') {
    const lines = appts.map((a) => `${a.type_name} with ${a.provider_name} on ${a.spoken_abs}`);
    return anythingElse(ctx, `You have ${lines.length === 1 ? 'one upcoming appointment: ' + lines[0] : 'these upcoming appointments: ' + lines.join('; ')}.`);
  }
  if (!st.target_appt_id) {
    if (appts.length === 1) st.target_appt_id = appts[0].id;
    else return ask(ctx, 'PICK_APPT', `You have ${appts.length} upcoming appointments: ${appts.map((a, i) => `${i + 1}) ${a.type_name} on ${a.spoken_abs}`).join('; ')}. Which one would you like to ${kind === 'cancel' ? 'cancel' : 'move'}?`);
  }
  const a = appts.find((x) => x.id === st.target_appt_id);
  if (kind === 'cancel') {
    const late = (new Date(a.start_utc) - ctx.now()) / 3600000 < 24;
    return ask(ctx, 'CONFIRM_CANCEL', `I can cancel your ${a.type_name} on ${a.spoken_abs}.${late ? ' ' + ctx.loc.settings.cancellation_policy : ''} Would you like me to cancel it?`);
  }
  // reschedule
  st.appointment_type_id = a.type_id;
  if (!st.prefs_set) return ask(ctx, 'ASK_PREFS', `Sure. I'll move your ${a.type_name} (currently ${a.spoken_abs}). What days and times would work better?`);
  return searchAndOffer(ctx);
}

function advance(ctx) {
  const st = ctx.state;
  switch (st.intent) {
    case 'book': return advanceBook(ctx);
    case 'reschedule': return advanceManage(ctx, 'reschedule');
    case 'cancel': return advanceManage(ctx, 'cancel');
    case 'lookup': return advanceManage(ctx, 'lookup');
    default: return ask(ctx, 'INTENT', 'How can I help you today?');
  }
}

// ------------------------------------------------------------------ FAQ
function answerFaq(ctx, text) {
  const r = T(ctx, 'get_clinic_info', { question: text });
  if (!ctx.conv.outcome) tools.setConv(ctx, { outcome: 'faq', intent: 'faq' });
  if (r.answer) return anythingElse(ctx, r.answer);
  const phone = (ctx.state.patient && ctx.state.patient.mobile) || ctx.conv.from_number;
  if (phone) {
    T(ctx, 'create_task', { kind: 'message', title: `Question for staff: "${String(text).slice(0, 140)}" (${phone})` });
    return anythingElse(ctx, "I don't have that detail in front of me, so I've passed your question to our team and they'll follow up with you.");
  }
  ctx.state.pending_question = text;
  return ask(ctx, 'ASK_CALLBACK_PHONE', "I don't have that detail on hand, but our team can follow up. What's the best phone number to reach you?");
}

// ------------------------------------------------------------------ main turn handler
function intro(ctx) { return ''; }

function startIntent(ctx, text) {
  const st = ctx.state;
  const intent = nlu.detectIntent(text);
  if (st.urgent && !['cancel', 'reschedule', 'lookup'].includes(intent)) { st.intent = 'book'; st.reason = text; tools.setConv(ctx, { intent: 'book' }); return advance(ctx); }
  if (intent === 'book') { st.intent = 'book'; st.reason = text; tools.setConv(ctx, { intent: 'book' }); return advance(ctx); }
  if (['cancel', 'reschedule', 'lookup'].includes(intent)) { st.intent = intent; tools.setConv(ctx, { intent }); return advance(ctx); }
  if (intent === 'faq') return answerFaq(ctx, text);
  st.misses = (st.misses || 0) + 1;
  if (st.misses >= 3) return handoff(ctx, 'Could not understand the request');
  return ask(ctx, 'INTENT', st.misses === 1 ? `I can help you book, reschedule or cancel an appointment, or answer questions about ${ctx.loc.name}. What would you like to do?` : "I'm sorry, I didn't quite catch that. Are you looking to book, change or cancel an appointment, or do you have a question?");
}

function handleTurn(ctx, text) {
  const st = ctx.state;
  text = String(text || '').trim();
  if (st.ended) return { reply: 'This conversation has ended. Please call or message again if you need anything else.', end: true };
  if (!st.step) st.step = 'INTENT';
  st.patient = st.patient || {};

  // Urgent (non life-threatening) dental problem: acknowledge once, then book the earliest emergency slot
  let prefix = '';
  if (st.urgent && !st.urgent_ack) {
    st.urgent_ack = true;
    const pol = ctx.loc.settings.emergency_policy;
    const open = core.isOpenNow(ctx.loc, ctx.now());
    prefix = pol.script_urgent + (!open && pol.on_call_number ? ` If you'd like to speak with our on-call dentist right now, you can call ${pol.on_call_number}.` : '');
    if (!['reschedule', 'cancel'].includes(st.intent)) { st.intent = 'book'; st.reason = text; st.appointment_type_id = null; st.prefs = { days: [], fromDate: tz.local(ctx.now(), ctx.loc.timezone).date, any: true }; st.prefs_set = true; tools.setConv(ctx, { intent: 'book' }); }
    harvest(ctx, text, null);
    return joinReply(prefix, advance(ctx));
  }

  if (nlu.wantsHuman(text)) return handoff(ctx, 'Caller asked for a person');
  if (/^(start over|never ?mind|forget it|cancel that|nothing|scratch that)\b/i.test(text) && !['CONFIRM_CANCEL'].includes(st.step)) { resetFlow(st); return ask(ctx, 'INTENT', 'No problem. How else can I help?'); }

  const step = st.step;
  switch (step) {
    case 'INTENT': {
      harvest(ctx, text, null);
      return startIntent(ctx, text);
    }
    case 'ASK_NAME': case 'ASK_LAST': {
      harvest(ctx, text, step === 'ASK_NAME' ? 'name' : 'last');
      const p = st.patient;
      if (!p.first_name || (step === 'ASK_LAST' && !p.last_name)) {
        st.name_tries = (st.name_tries || 0) + 1;
        if (st.name_tries >= 3) return handoff(ctx, 'Could not capture name');
        return ask(ctx, step, step === 'ASK_NAME' ? "Sorry, I didn't catch your name. Could you say your first and last name?" : 'And your last name?');
      }
      return advance(ctx);
    }
    case 'ASK_DOB': {
      harvest(ctx, text, 'dob');
      if (!st.patient.dob) {
        st.dob_tries = (st.dob_tries || 0) + 1;
        if (st.dob_tries >= 3) return handoff(ctx, 'Could not capture date of birth');
        return ask(ctx, 'ASK_DOB', "Sorry, I didn't catch that date. Could you say your date of birth, for example April 12th, 1988?");
      }
      return advance(ctx);
    }
    case 'ASK_PHONE': {
      harvest(ctx, text, 'phone');
      if (!st.patient.mobile) {
        st.phone_tries = (st.phone_tries || 0) + 1;
        if (st.phone_tries >= 3) return handoff(ctx, 'Could not capture phone number');
        return ask(ctx, 'ASK_PHONE', 'Sorry, I need a 10-digit mobile number to text your confirmation to. Could you repeat it?');
      }
      return advance(ctx);
    }
    case 'ASK_REASON': { st.reason = text; harvest(ctx, text, null); return advance(ctx); }
    case 'ASK_INSURANCE': {
      harvest(ctx, text, 'insurance');
      let note = '';
      if (st.insurance) note = /self/i.test(st.insurance.carrier) ? 'No problem, we can go over self-pay options at your visit.' : (st.insurance_note ? `We work with ${st.insurance.carrier} plans, and our team will verify your benefits before your visit.` : `Thanks, I've noted ${st.insurance.carrier}. I'm not sure we're in network with that plan, so our team will check before your visit.`);
      return joinReply(note, advance(ctx));
    }
    case 'ASK_PREFS': {
      harvest(ctx, text, 'prefs');
      if (!st.prefs_set) {
        if (nlu.yesNo(text) === 'yes') { st.prefs = { days: [], any: true }; st.prefs_set = true; }
        else {
          st.prefs_tries = (st.prefs_tries || 0) + 1;
          if (st.prefs_tries >= 2) { st.prefs = { days: [], any: true }; st.prefs_set = true; }
          else return ask(ctx, 'ASK_PREFS', 'Do you prefer mornings or afternoons, and are there any days that work best?');
        }
      }
      return advance(ctx);
    }
    case 'OFFER': {
      const slots = st.offered_slots || [];
      let choice = nlu.chooseOption(text, slots, ctx.loc.timezone);
      if (choice === null && nlu.yesNo(text) === 'no') choice = 'none';
      if (choice === 'none') {
        st.rejections = (st.rejections || 0) + 1;
        if (st.rejections >= 2) { return ask(ctx, 'WAITLIST_OFFER', "I'm sorry none of those work. I can add you to our waitlist and text you when something opens that fits, or have our team call you. Would you like me to add you to the waitlist?"); }
        st.prefs_set = false; st.prefs = null;
        return ask(ctx, 'ASK_PREFS', 'No problem. What other days or times would work for you?');
      }
      if (choice === null) {
        const pr = nlu.extractPrefs(nlu.stripDOB(text), ctx.now(), ctx.loc.timezone);
        if (pr.hasPref) { st.prefs = pr; st.prefs_set = true; return searchAndOffer(ctx); }
        if (nlu.yesNo(text) === 'yes' && slots.length > 1) return ask(ctx, 'OFFER', 'Great. Which one would you like: the first, second' + (slots.length > 2 ? ', or third' : '') + '?');
        return ask(ctx, 'OFFER', `Which of those works best? You can say "the first one", or name the day or time.`);
      }
      const slot = slots[choice];
      const h = T(ctx, 'hold_slot', { slot_id: slot.slot_id });
      if (h.error) return searchAndOffer(ctx, "I'm sorry, that time was just taken.");
      st.chosen = slot; st.hold_token = ctx.state.hold_token;
      return ask(ctx, 'CONFIRM', confirmText(ctx));
    }
    case 'CONFIRM': {
      const yn = nlu.yesNo(text);
      if (yn === 'yes') return st.intent === 'reschedule' ? executeReschedule(ctx) : executeBook(ctx);
      if (yn === 'no') { st.prefs_set = false; st.prefs = null; st.chosen = null; return ask(ctx, 'ASK_PREFS', 'No problem. What day and time would you like instead?'); }
      return ask(ctx, 'CONFIRM', 'Please say yes if you would like me to go ahead, or no to choose a different time.');
    }
    case 'PICK_APPT': {
      const appts = st.appt_choices || [];
      const c = nlu.chooseOption(text, appts.map((a) => ({ ...a })), ctx.loc.timezone);
      if (c === null || c === 'none') return ask(ctx, 'PICK_APPT', 'Which appointment do you mean? You can say the first one, or name the day.');
      st.target_appt_id = appts[c].id;
      return advance(ctx);
    }
    case 'CONFIRM_CANCEL': {
      const yn = nlu.yesNo(text);
      if (yn === 'no') { resetFlow(st); return anythingElse(ctx, "Okay, I've left your appointment as it is."); }
      if (yn !== 'yes') return ask(ctx, 'CONFIRM_CANCEL', 'Would you like me to cancel that appointment? Please say yes or no.');
      const r = T(ctx, 'cancel_appointment', { appointment_id: st.target_appt_id, reason: 'Patient request via assistant', confirmed_by_caller: true });
      if (r.cancelled) {
        const a = (st.appt_choices || []).find((x) => x.id === st.target_appt_id);
        if (a) st.appointment_type_id = a.type_id;
        st.step = 'REBOOK';
        return { reply: `Your appointment has been cancelled.${r.late_cancellation && r.policy ? ' ' + r.policy : ''} Would you like to book a new time instead?` };
      }
      return handoff(ctx, `Cancel failed: ${r.error && r.error.message}`);
    }
    case 'REBOOK': {
      const yn = nlu.yesNo(text);
      if (yn === 'yes') { const typeId = st.appointment_type_id; resetFlow(st); st.intent = 'book'; st.appointment_type_id = typeId || null; st.new_patient = st.new_patient === true ? true : false; tools.setConv(ctx, { intent: 'book' }); harvest(ctx, text, null); return advance(ctx); }
      if (nlu.detectIntent(text) === 'book') { resetFlow(st); return startIntent(ctx, text); }
      return anythingElse(ctx, 'No problem.');
    }
    case 'WAITLIST_OFFER': {
      const yn = nlu.yesNo(text);
      if (yn === 'yes') {
        const pr = st.prefs || {};
        const r = T(ctx, 'join_waitlist', { appointment_type: scheduling.getType(st.appointment_type_id).code, preferred_days: (pr.days || []).map(Number), time_of_day: pr.tod });
        if (r.waitlisted) return anythingElse(ctx, "You're on the waitlist. We'll text you the moment a matching time opens up, and you can reply YES to take it.");
        return handoff(ctx, `Waitlist failed: ${r.error && r.error.message}`);
      }
      T(ctx, 'create_task', { kind: 'callback', title: `Wanted ${scheduling.getType(st.appointment_type_id).name} but no matching openings: ${st.patient.first_name || ''} ${st.patient.last_name || ''} ${st.patient.mobile || ctx.conv.from_number || ''}`.trim(), urgency: 'high' });
      return anythingElse(ctx, "No problem. I've asked our team to call you with other options.");
    }
    case 'ASK_CALLBACK_PHONE': {
      const ph = nlu.extractPhone(text);
      if (!ph) return ask(ctx, 'ASK_CALLBACK_PHONE', "Sorry, I didn't get a 10-digit number. What's the best number to reach you?");
      st.patient.mobile = ph;
      T(ctx, 'create_task', { kind: 'message', title: `Question for staff: "${String(st.pending_question || '').slice(0, 140)}" (${ph})` });
      return anythingElse(ctx, "Thank you, I've passed that along and our team will follow up.");
    }
    case 'CLOSE': {
      if (nlu.isGoodbye(text) && !nlu.detectIntent(text)) return farewell(ctx);
      resetFlow(st);
      harvest(ctx, text, null);
      const intent = nlu.detectIntent(text);
      if (!intent) return ask(ctx, 'INTENT', 'Sure. What else can I help with?');
      return startIntent(ctx, text);
    }
    default:
      resetFlow(st);
      return startIntent(ctx, text);
  }
}

module.exports = { handleTurn, resetFlow };
