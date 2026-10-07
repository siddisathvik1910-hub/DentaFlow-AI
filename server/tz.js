// Time-zone helpers built on Intl (no dependencies). Store UTC, think in clinic-local time.
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
}

function offsetMinutes(ms, tz) {
  const p = parts(new Date(ms), tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUtc - Math.floor(ms / 1000) * 1000) / 60000;
}

// Convert a clinic-local date + time ("2026-10-16", "15:00") to a UTC Date (DST-safe)
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - offsetMinutes(guess, tz) * 60000;
  const off2 = offsetMinutes(utc, tz);
  utc = guess - off2 * 60000;
  return new Date(utc);
}

function local(date, tz) {
  const p = parts(date, tz);
  const dateStr = `${p.year}-${p.month}-${p.day}`;
  const wd = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay();
  return {
    date: dateStr, time: `${p.hour}:${p.minute}`, minutes: +p.hour * 60 + +p.minute,
    weekday: wd, wd: WD[wd], weekdayName: WD_LONG[wd],
  };
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const weekdayOf = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fromMin = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// "Thursday, October 16 at 3:00 PM" (uses today/tomorrow when ref is supplied)
function speak(date, tz, ref) {
  const l = local(date, tz);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long', day: 'numeric' }).format(date);
  const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(date);
  let prefix = `${WD_LONG[l.weekday]}, ${f}`;
  if (ref) {
    const r = local(ref, tz).date;
    if (l.date === r) prefix = `today, ${f}`;
    else if (l.date === addDays(r, 1)) prefix = `tomorrow, ${WD_LONG[l.weekday]} ${f}`;
  }
  return `${prefix} at ${t}`;
}

function fmtTime12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, '0')} ${ap}` : `${hh} ${ap}`;
}

module.exports = { WD, WD_LONG, zonedToUtc, local, addDays, weekdayOf, toMin, fromMin, speak, fmtTime12, offsetMinutes };
