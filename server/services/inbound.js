// Inbound SMS handling: compliance keywords, reminder replies (C/R/X), waitlist offers (YES),
// recall replies (BOOK), and free-form conversations with the agent.
const { db } = require('../db');
const core = require('./core');
const patients = require('./patients');
const scheduling = require('./scheduling');
const waitlist = require('./waitlist');
const campaigns = require('./campaigns');
const conversations = require('./conversations');
const tz = require('../tz');
const clock = require('../clock');

const OPT_OUT = /^\s*(stop|stopall|unsubscribe|quit|end|opt ?out)\s*[.!]*\s*$/i;
const OPT_IN = /^\s*(start|unstop|subscribe)\s*[.!]*\s*$/i;
const HELP = /^\s*help\s*[.!]*\s*$/i;
const YES = /^\s*(yes|y|yeah|yep|yup|ok|okay|sure|take it|book it)\s*[.!]*\s*$/i;
const CONFIRM = /^\s*(c|confirm|confirmed|yes|y)\s*[.!]*\s*$/i;
const RESCHED = /^\s*(r|reschedule)\s*[.!]*\s*$/i;
const CANCEL = /^\s*(x|cancel)\s*[.!]*\s*$/i;
const BOOK = /^\s*(book|schedule)\s*[.!]*\s*$/i;

function upcomingFor(locationId, phone) {
  const ps = patients.findByPhone(locationId, phone);
  const appts = [];
  for (const p of ps) for (const a of scheduling.listForPatient(p.id)) appts.push({ ...a, patient: p });
  return appts.sort((a, b) => a.start_utc.localeCompare(b.start_utc));
}

// Returns { reply, ended }
async function handleSms({ locationId, from, body }) {
  const loc = core.getLocation(locationId);
  const phone = core.normalizePhone(from);
  const text = String(body || '').trim();
  const base = { tenantId: loc.tenant_id };

  if (OPT_OUT.test(text)) {
    patients.recordConsent({ ...base, phone, purpose: 'all', status: 'revoked', source: 'sms_stop' });
    return { reply: `You've been unsubscribed from ${loc.name} text messages. Reply START to resubscribe.`, ended: true };
  }
  if (OPT_IN.test(text)) {
    patients.recordConsent({ ...base, phone, purpose: 'all', status: 'granted', source: 'sms_start' });
    patients.recordConsent({ ...base, phone, purpose: 'transactional', status: 'granted', source: 'sms_start' });
    return { reply: `Welcome back! You'll receive appointment messages from ${loc.name}. Reply STOP to opt out.`, ended: true };
  }
  if (HELP.test(text)) return { reply: `${loc.name}: reply C to confirm, R to reschedule, X to cancel an appointment. Call us at ${loc.phone || 'the office'}. Reply STOP to opt out.`, ended: true };

  // Waitlist offer acceptance
  if (YES.test(text)) {
    const ps = patients.findByPhone(locationId, phone);
    const r = waitlist.acceptOffer(ps.map((p) => p.id));
    if (r) return { reply: r.reply, ended: true };
  }
  // Reminder replies
  if (CONFIRM.test(text) || CANCEL.test(text)) {
    const appts = upcomingFor(locationId, phone);
    const next = appts.find((a) => a.confirmation_status !== 'confirmed') || appts[0];
    if (next && CONFIRM.test(text)) {
      scheduling.confirmAppointment(next.id, 'sms');
      return { reply: `Thank you! You're confirmed for ${next.type_name} on ${tz.speak(new Date(next.start_utc), loc.timezone)}. See you then!`, ended: true };
    }
    if (next && CANCEL.test(text)) {
      scheduling.cancelAppointment({ appointmentId: next.id, actor: 'patient_sms', reason: 'Cancelled by text reply' });
      const late = (new Date(next.start_utc) - clock.now()) / 3600000 < 24;
      return { reply: `Your ${next.type_name} on ${tz.speak(new Date(next.start_utc), loc.timezone)} has been cancelled.${late ? ' ' + loc.settings.cancellation_policy : ''} Reply BOOK to schedule a new time.`, ended: true };
    }
  }
  const sess = { locationId, channel: 'sms', externalId: phone, from: phone, resumeWithinMin: 24 * 60 };
  if (RESCHED.test(text)) {
    const { conversation } = conversations.start({ ...sess, resumeWithinMin: null, silent: true, preState: { intent: 'reschedule', step: 'INTENT' } });
    const r = await conversations.turn({ conversationId: conversation.id, text: 'I need to reschedule my appointment' });
    return { reply: r.reply, ended: r.ended };
  }
  if (BOOK.test(text)) {
    const member = campaigns.memberForPhone(phone);
    const { conversation } = conversations.start({ ...sess, resumeWithinMin: null, silent: true });
    const r = await conversations.turn({ conversationId: conversation.id, text: member ? 'I would like to book my cleaning' : 'I would like to book an appointment' });
    return { reply: r.reply, ended: r.ended };
  }
  const { conversation } = conversations.start({ ...sess, silent: true });
  const r = await conversations.turn({ conversationId: conversation.id, text });
  return { reply: r.reply, ended: r.ended };
}

module.exports = { handleSms };
