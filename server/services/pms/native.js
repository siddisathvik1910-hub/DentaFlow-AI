// Built-in calendar mode: this database is the system of record.
// Works with no external integration, which is how pilots start.
const { db } = require('../../db');

module.exports = {
  name: 'native',
  async testConnection() { return { ok: true, message: 'Built-in calendar is active.' }; },
  listAppointments({ locationId, providerId, fromUtc, toUtc }) {
    return db.prepare(`SELECT id, provider_id, start_utc, end_utc, block_end_utc, status FROM appointments
      WHERE location_id=? AND provider_id=? AND status IN ('booked','confirmed') AND start_utc < ? AND block_end_utc > ?`)
      .all(locationId, providerId, toUtc, fromUtc);
  },
  createAppointment() { return null; },
  cancelAppointment() { /* nothing external to update */ },
};
