// Injectable clock so scheduling, reminders and tests are deterministic.
let offsetMs = 0;
let fixed = null;
module.exports = {
  now() { return fixed ? new Date(fixed) : new Date(Date.now() + offsetMs); },
  iso() { return this.now().toISOString(); },
  setNow(d) { fixed = d ? new Date(d).getTime() : null; },
  shiftMs(ms) { offsetMs += ms; },
  reset() { fixed = null; offsetMs = 0; },
};
