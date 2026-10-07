// Lightweight, deterministic natural-language helpers used by the built-in (offline) agent engine
// and by the tool layer to validate what the LLM extracts. No network, no dependencies.
const tz = require('../tz');

const MONTHS = { january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12 };
const MONTH_RE = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const ONES = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const lower = (s) => clean(s).toLowerCase();

// "twenty one" / "twenty-first" -> number
function wordsToInt(words) {
  let total = 0, found = false;
  for (const w of words) {
    if (ONES[w] !== undefined) { total += ONES[w]; found = true; } else if (TENS[w]) { total += TENS[w]; found = true; } else if (ORD[w]) { total += ORD[w]; found = true; } else return null;
  }
  return found ? total : null;
}
// Convert spoken dates ("april twelfth nineteen eighty eight") to digits so one parser handles both forms
function spokenToDigits(t) {
  let s = ' ' + t.replace(/([a-z])-([a-z])/g, '$1 $2') + ' ';
  // years: "nineteen eighty eight", "two thousand five"
  s = s.replace(/\b(nineteen|twenty)\s+((?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:\s+(?:one|two|three|four|five|six|seven|eight|nine))?)|(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)|(?:oh\s+(?:one|two|three|four|five|six|seven|eight|nine)))\b/g, (m, a, b) => {
    const hi = a === 'nineteen' ? 19 : 20; const lo = wordsToInt(b.split(' ').filter((x) => x !== 'oh')); const ohOne = /^oh/.test(b);
    if (lo === null) return m; return String(hi * 100 + (ohOne ? lo : lo));
  });
  s = s.replace(/\btwo thousand(?:\s+and)?(?:\s+((?:(?:twenty|thirty|forty)(?:\s+(?:one|two|three|four|five|six|seven|eight|nine))?)|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)))?\b/g, (m, b) => String(2000 + (b ? wordsToInt(b.split(' ')) : 0)));
  // day ordinals/cardinals right after a month name
  s = s.replace(new RegExp(`\\b${MONTH_RE}\\s+((?:(?:twenty|thirty)\\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty))\\b`, 'g'),
    (m, mo, d) => { const n = wordsToInt(d.split(' ')); return n ? `${mo} ${n}` : m; });
  s = s.replace(new RegExp(`\\b((?:(?:twenty|thirty)\\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty))\\s+(of\\s+)?${MONTH_RE}\\b`, 'g'),
    (m, d, of, mo) => { const n = wordsToInt(d.split(' ')); return n ? `${n} ${of || ''}${mo}` : m; });
  return s.trim();
}

function validDate(y, m, d, now) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || dt > now) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function expandYear(yy, now) { if (yy >= 100) return yy; const cur = now.getUTCFullYear() % 100; return yy > cur ? 1900 + yy : 2000 + yy; }

function extractDOB(text, now = new Date()) {
  const t = spokenToDigits(lower(text));
  let m;
  if ((m = /\b((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(t))) return validDate(+m[1], +m[2], +m[3], now);
  if ((m = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})\b/.exec(t))) {
    let a = +m[1], b = +m[2]; const y = expandYear(+m[3], now);
    if (a > 12 && b <= 12) [a, b] = [b, a];
    return validDate(y, a, b, now);
  }
  if ((m = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?:of\\s+)?(\\d{4}|\\d{2})\\b`).exec(t))) return validDate(expandYear(+m[3], now), MONTHS[m[1]], +m[2], now);
  if ((m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(\\d{4}|\\d{2})\\b`).exec(t))) return validDate(expandYear(+m[3], now), MONTHS[m[2]], +m[1], now);
  return null;
}

const DIGIT_WORDS = { zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
function extractPhone(text) {
  let s = lower(text);
  const words = s.replace(/[^a-z\s]/g, ' ').split(/\s+/);
  const wordDigits = words.every((w) => !w) ? '' : words.map((w) => (DIGIT_WORDS[w] !== undefined ? String(DIGIT_WORDS[w]) : '')).join('');
  const m = /(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/.exec(s);
  if (m) { const d = m[1].replace(/\D/g, ''); if (d.length === 10 || (d.length === 11 && d[0] === '1')) return '+1' + d.slice(-10); }
  if (wordDigits.length >= 10) return '+1' + wordDigits.slice(-10);
  return null;
}
const extractEmail = (text) => (/[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text) || [null])[0];

const NAME_STOP = new Set(('hi hello hey yes yeah yep yup no nope nah please thanks thank you um uh uhh hmm well so okay ok sure fine good great right correct done all set here there just now then also still ' +
  'my name is its it\'s it this that these those i am i\'m im i\'d i\'ll ive i\'ve me mine we our us your you\'re youre he she they them their the a an and or but because as if at by for from in into of on to up with without about not ' +
  'are was were be been being what whats what\'s how do does did can could should would will shall might must have has had get got go going come coming ' +
  'calling looking want need like wanting wanted book booking schedule appointment appointments new patient existing for cleaning checkup check exam consultation whitening filling crown implant braces ' +
  'monday tuesday wednesday thursday friday saturday sunday tomorrow today tonight morning afternoon evening next week weekend weekday any anytime whenever soon asap noon pm am ' +
  'january february march april may june july august september october november december ' +
  'tooth teeth pain hurts hurt hurting dentist doctor dental insurance delta cigna aetna metlife guardian humana none self pay cash ' +
  'sorry last first spell dr mr mrs ms miss mister ' +
  'cancel reschedule move change help question questions hours open close closed location address parking cost price how much when where why who which ' +
  'human person someone somebody operator representative front desk transfer speak talk call phone number mobile cell birthday birth date born dob month day year ' +
  'one two three four five six seven eight nine ten').split(' '));
const NAME_BREAK = NAME_STOP;

function extractName(text, expecting = false) {
  const raw = clean(text).replace(/[.,!;:()"]/g, ' ').replace(/\s+/g, ' ');
  if (/\?/.test(text) && !/(my name|this is)/i.test(text)) return null;
  const r2 = raw.replace(/\?/g, '');
  const m = /(?:my (?:full )?name is|my name's|name is|this is|i am|i'm|im|call me|it's|its|it is)\s+(?:dr |mr |mrs |ms )?([a-z'’-]+(?:\s+[a-z'’-]+){0,3})/i.exec(r2);
  let toks = null;
  if (m) toks = m[1].split(' ');
  else if (expecting) {
    const t = r2.split(' ').filter(Boolean);
    if (t.length > 0 && t.length <= 5 && !/\d/.test(r2)) toks = t;
  }
  if (!toks) return null;
  const keep = [];
  let dropped = 0;
  for (const w of toks) {
    const lw = w.toLowerCase().replace(/^[-'’]+|[-'’]+$/g, '');
    if (!lw) continue;
    if (NAME_STOP.has(lw)) { if (!keep.length) { dropped++; continue; } break; }
    if (!/^[a-z'’-]{2,20}$/i.test(w)) { if (!keep.length) continue; break; }
    keep.push(w);
  }
  if (!keep.length) return null;
  if (!m && dropped > 3) return null;
  const tc = (w) => w.toLowerCase().replace(/(^|[-'’])([a-z])/g, (x, a, b) => a + b.toUpperCase());
  if (keep.length === 1) return { first: tc(keep[0]), last: null };
  return { first: tc(keep[0]), last: tc(keep[keep.length - 1]) };
}

// Remove date-of-birth phrases so they are not misread as appointment dates
function stripDOB(text) {
  let t = String(text);
  t = t.replace(/\b(19|20)\d{2}-\d{1,2}-\d{1,2}\b/g, ' ');
  t = t.replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, ' ');
  t = t.replace(new RegExp(`\\b${MONTH_RE}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:of\\s+)?\\d{2,4}\\b`, 'gi'), ' ');
  t = t.replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+\\d{2,4}\\b`, 'gi'), ' ');
  const sp = spokenToDigits(lower(t));
  if (sp !== lower(t)) { const m = new RegExp(`${MONTH_RE}\\s+\\d{1,2}\\s+\\d{4}`).exec(sp); if (m) return lower(t).split(/\s+/).filter((w) => !/^(nineteen|twenty|eighty|ninety|seventy|sixty|fifty|forty|thirty|oh|two|thousand)$/.test(w)).join(' '); }
  return t;
}

const CARRIERS = ['Delta Dental', 'Cigna', 'Aetna', 'MetLife', 'Guardian', 'United Healthcare', 'UnitedHealthcare', 'Humana', 'Blue Cross', 'Blue Shield', 'Anthem', 'Principal', 'Ameritas', 'Sun Life', 'Medicaid', 'Medicare', 'Kaiser', 'Careington', 'Spirit Dental'];
function extractInsurance(text, extra = []) {
  const t = lower(text);
  if (/\b(no insurance|don'?t have (any )?(dental )?insurance|do not have (any )?insurance|self[- ]?pay|paying cash|cash|out of pocket|uninsured|without insurance)\b/.test(t) || /^(none|no|nope|nothing)\b/.test(t)) return { carrier: 'Self-pay' };
  for (const c of [...extra, ...CARRIERS]) if (t.includes(c.toLowerCase())) return { carrier: c };
  if (/\b(not sure|don'?t know|unsure|i'?ll check)\b/.test(t)) return { carrier: 'Unsure' };
  const m = /(?:insurance (?:is|with|through)|i have|it'?s|with)\s+([a-z][a-z &]{2,30})/i.exec(clean(text));
  if (m && /insurance|dental|plan/i.test(t)) return { carrier: m[1].trim().replace(/\b\w/g, (c) => c.toUpperCase()) };
  return null;
}

function yesNo(text) {
  const t = lower(text).replace(/[.!,]+$/, '');
  if (/^(y|yes|yeah|yep|yup|sure|ok|okay|correct|right|that'?s (right|correct)|sounds good|perfect|please do|go ahead|absolutely|definitely|of course|confirm(ed)?|that works|works for me|i do|exactly|affirmative|yes please)\b/.test(t)) return 'yes';
  if (/^(n|no|nope|nah|not really|incorrect|wrong|that'?s (wrong|not right|incorrect)|don'?t|do not|never ?mind|negative|not (right|correct))\b/.test(t)) return 'no';
  return null;
}
const isGoodbye = (text) => /^(no|nope|nothing( else)?|that'?s (all|it)|i'?m (good|all set|done|fine)|all set|bye|good ?bye|thanks?|thank you|no thanks|no thank you|that will be all|that would be all|we'?re (good|done)|have a (good|great|nice))\b/.test(lower(text).replace(/[.!,]+$/, ''));
const wantsHuman = (text) => {
  const t = lower(text);
  return /\b(operator|real person|human|live person|live agent)\b/.test(t) || (/\b(speak|talk|transfer|connect|put me through|get me)\b.{0,25}\b(someone|somebody|person|receptionist|representative|front desk|staff|manager|dentist|doctor|office)\b/.test(t)) || /\bnot (a )?(robot|bot)\b/.test(t);
};
const patientStatus = (text) => {
  const t = lower(text);
  if (/\b(new patient|never (been|visited|seen)|first (time|visit)|haven'?t been (there|before)|i'?m new|am new|not a (current )?patient yet)\b/.test(t)) return 'new';
  if (/\b(existing|current patient|returning|i'?ve been|been (a patient|coming|seeing)|i'?m a patient|already a patient|regular patient|patient there)\b/.test(t)) return 'existing';
  return null;
};

function detectIntent(text) {
  const t = lower(text);
  if (/\bcancel\b/.test(t) && !/\b(can'?t|cannot|don'?t want to)\s+cancel\b/.test(t)) return 'cancel';
  if (/\b(re-?schedul\w*|move (my|the|our|it)|change (my|the) (appointment|time|date|visit|booking)|different (day|time)|push (it|my)|switch (my|the)|another (day|time) for my)\b/.test(t)
    || /\b(get|have|can i get|could i get)\b.{0,25}\bmoved\b|\bmoved\b.{0,25}\b(appointment|cleaning|visit|checkup|exam)\b|\b(appointment|cleaning|visit|checkup|exam)\b.{0,25}\bmoved\b|\b(can'?t|cannot|won'?t be able to|unable to) make (it|my|the)\b/.test(t)) return 'reschedule';
  if (/(when is my|what time is my|do i have an? (appointment|visit)|am i scheduled|check (on )?my (appointment|booking)|confirm my (appointment|visit)|my (next |upcoming )?(appointment|visit)\b.*\?)/.test(t) && !/\b(book|make|schedule)\b/.test(t)) return 'lookup';
  if (/\b(book|schedule|make|set up|setup|get|need|want|like|looking for|come in|see)\b.{0,40}\b(appointment|appt|visit|cleaning|check-?up|exam|consult\w*|whitening|filling|crown|implants?|braces|invisalign|root canal|x-?rays?|dentist|doctor)\b/.test(t)
    || /\b(new patient|teeth cleaning|dental cleaning|a cleaning|my cleaning|check-?up|toothache|tooth ache|broken tooth|chipped tooth|cracked tooth|wisdom tooth|tooth (hurts|pain)|(appointment|appt)s?\b)/.test(t)) return 'book';
  if (/\b(hours?|open|close|closing|where|address|location|located|parking|insurance|cost|price|prices|how much|financing|payment plan|accept|take|offer|do you (do|have|see|treat)|services?|emergency|what (is|are)|how (do|does|long)|can i|do i need|bring|forms?|x-?rays?|kids|children|sedation|covid|wait|policy)\b/.test(t) || /\?\s*$/.test(t)) return 'faq';
  return null;
}

// ---------- Scheduling preferences ----------
const DAY_RE = { 0: /\bsun(day)?\b/, 1: /\bmon(day)?\b/, 2: /\btue(s|sday)?\b/, 3: /\bwed(nesday)?\b/, 4: /\bthu(r|rs|rsday)?\b/, 5: /\bfri(day)?\b/, 6: /\bsat(urday)?\b/ };

// Clock times mentioned in text -> minutes since midnight. Bare 1-6 assumed PM, 7-11 AM (dental office hours).
function extractTimes(text) {
  const t = lower(text);
  const out = [];
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/g;
  let m;
  while ((m = re.exec(t))) {
    const hasMer = !!m[3], hasMin = m[2] !== undefined;
    const ctx = t.slice(Math.max(0, m.index - 6), m.index);
    if (!hasMer && !hasMin && !/(at|around|about|after|before|by|@)\s*$/.test(ctx)) continue;
    let h = +m[1]; const mi = m[2] ? +m[2] : 0;
    if (h > 12 && !hasMer) { if (h <= 23 && hasMin) { out.push(h * 60 + mi); } continue; }
    if (h < 1 || h > 12 || mi > 59) continue;
    if (hasMer) { const pm = /^p/.test(m[3]); h = (h % 12) + (pm ? 12 : 0); }
    else if (h >= 1 && h <= 6) h += 12; else if (h === 12) h = 12;
    out.push(h * 60 + mi);
  }
  if (/\bnoon\b/.test(t)) out.push(12 * 60);
  return out;
}

function nextWeekdayDate(todayStr, wd, strictlyAfter = false) {
  let d = todayStr;
  for (let i = strictlyAfter ? 1 : 0; i < 15; i++) { const c = tz.addDays(todayStr, i); if (tz.weekdayOf(c) === wd) { d = c; break; } }
  return d;
}

function extractPrefs(text, now, tzName) {
  const t = lower(text);
  const today = tz.local(now, tzName).date;
  const p = { days: [], tod: null, after: null, before: null, fromDate: null, toDate: null, any: false };
  const named = [];
  for (const [wd, re] of Object.entries(DAY_RE)) if (re.test(t)) named.push(+wd);
  if (named.length) p.days = named;
  if (/\bweekdays?\b/.test(t)) p.days = [1, 2, 3, 4, 5];
  if (/\btomorrow\b/.test(t)) { p.fromDate = p.toDate = tz.addDays(today, 1); }
  else if (/\b(today|tonight|this afternoon|this morning|asap|as soon as (possible|you can)|soonest|earliest|right away|right now|urgent)\b/.test(t)) { p.fromDate = today; p.any = true; }
  if (/\bnext week\b/.test(t)) { const wd = tz.weekdayOf(today); const mon = tz.addDays(today, ((8 - wd) % 7) || 7); p.fromDate = mon; p.toDate = tz.addDays(mon, 6); }
  else if (/\bthis week\b/.test(t)) { const wd = tz.weekdayOf(today); p.fromDate = today; p.toDate = tz.addDays(today, (7 - wd) % 7); }
  const nextDay = /\bnext (sun|mon|tue|wed|thu|fri|sat)\w*/.exec(t);
  if (nextDay && named.length === 1) { p.fromDate = nextWeekdayDate(today, named[0], true); p.toDate = p.fromDate; }
  // explicit dates: "october 14", "10/14"
  let m = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(spokenToDigits(t));
  if (m) {
    const y = +today.slice(0, 4); let d = `${y}-${String(MONTHS[m[1]]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
    if (d < today) d = `${y + 1}${d.slice(4)}`;
    p.fromDate = p.toDate = d; p.days = [];
  } else if ((m = /\b(\d{1,2})\/(\d{1,2})\b(?!\/)/.exec(t)) && +m[1] <= 12 && +m[2] <= 31 && !/:/.test(m[0])) {
    const y = +today.slice(0, 4); let d = `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
    if (d < today) d = `${y + 1}${d.slice(4)}`; p.fromDate = p.toDate = d; p.days = [];
  }
  if (/\b(mornings?|early|a\.?m\.? appointments?)\b/.test(t)) p.tod = 'morning';
  if (/\b(afternoons?|after lunch|midday|mid-day)\b/.test(t)) p.tod = 'afternoon';
  if (/\b(evenings?|after work|late|end of the day)\b/.test(t)) p.tod = 'evening';
  const times = extractTimes(t);
  const afterM = /\b(after|later than|no earlier than)\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon)/.exec(t);
  const beforeM = /\b(before|earlier than|by|no later than)\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon)/.exec(t);
  if (afterM) { const tm = extractTimes(`at ${afterM[2]}`)[0]; if (tm !== undefined) p.after = tz.fromMin(tm); }
  if (beforeM) { const tm = extractTimes(`at ${beforeM[2]}`)[0]; if (tm !== undefined) p.before = tz.fromMin(tm); }
  if (!afterM && !beforeM && times.length === 1 && /\b(at|around|about|@)\b|\d\s*(a\.?m|p\.?m)|\d:\d\d/.test(t)) { p.after = tz.fromMin(Math.max(0, times[0] - 30)); p.before = tz.fromMin(Math.min(1439, times[0] + 91)); }
  if (/\b(any ?time|whenever|anything|doesn'?t matter|no preference|flexible|whatever works|any day|open)\b/.test(t)) p.any = true;
  p.hasPref = !!(p.days.length || p.tod || p.after || p.before || p.fromDate || p.any);
  return p;
}

// Which offered slot did the caller pick? -> index | 'none' | null (unclear)
function chooseOption(text, slots, tzName) {
  const t = lower(text);
  if (!slots || !slots.length) return null;
  if (/\b(none|neither|other|different|something else|another|more options|none of (those|them)|don'?t work|doesn'?t work|nothing)\b/.test(t) && !/\b(the other one)\b/.test(t)) return 'none';
  let idx = [];
  // 1) clock time
  const times = extractTimes(t.replace(/\boption\s*\d\b/g, ''));
  if (times.length) {
    const hits = slots.map((s, i) => (times.includes(tz.toMin(s.local_time)) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) idx = hits;
  }
  // 2) weekday / tomorrow
  const dayHits = [];
  for (const [wd, re] of Object.entries(DAY_RE)) if (re.test(t)) dayHits.push(+wd);
  if (dayHits.length) {
    const hits = (idx.length ? idx : slots.map((_, i) => i)).filter((i) => dayHits.includes(tz.weekdayOf(slots[i].local_date)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) idx = hits;
  }
  // 3) ordinals
  const pool = idx.length ? idx : slots.map((_, i) => i);
  if (/\b(first|1st|number one|option (1|one)|the earliest|earliest)\b/.test(t)) return pool[0];
  if (/\b(second|2nd|number two|option (2|two)|middle)\b/.test(t) && pool[1] !== undefined) return pool[1];
  if (/\b(third|3rd|number three|option (3|three))\b/.test(t) && pool[2] !== undefined) return pool[2];
  if (/\b(last|latest|final)\b/.test(t)) return pool[pool.length - 1];
  const bare = /^\s*(?:option |number |#)?(\d)\s*[.!]?\s*$/.exec(t);
  if (bare && +bare[1] >= 1 && +bare[1] <= slots.length) return +bare[1] - 1;
  if (/^\s*(one|two|three)\s*[.!]?\s*$/.test(t)) return { one: 0, two: 1, three: 2 }[t.trim().replace(/[.!]/g, '')];
  if (idx.length === 1) return idx[0];
  // 4) acceptance when only one choice was offered
  if (slots.length === 1 && yesNo(t) === 'yes') return 0;
  return null;
}

module.exports = {
  clean, lower, extractDOB, extractPhone, extractEmail, extractName, extractInsurance, extractPrefs, extractTimes, chooseOption, yesNo, isGoodbye, wantsHuman,
  patientStatus, detectIntent, spokenToDigits, stripDOB, CARRIERS,
};
