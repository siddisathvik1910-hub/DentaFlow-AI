// Practice Management System adapter layer.
// The scheduling engine only talks to this interface, so each PMS is a plug-in.
//
// interface PmsAdapter {
//   name: string
//   testConnection(): Promise<{ok, message}>
//   listAppointments({ locationId, providerId, fromUtc, toUtc }): Appointment[]     (busy blocks, sync)
//   createAppointment(appt): string|null          returns external PMS appointment id
//   cancelAppointment(appt): void
// }
const { db, parse } = require('../../db');
const { decrypt } = require('../../crypto');

const native = require('./native');
const opendental = require('./opendental');

function getAdapter(locationId) {
  const row = db.prepare("SELECT * FROM integrations WHERE location_id=? AND status='connected' ORDER BY rowid DESC LIMIT 1").get(locationId);
  if (row && row.pms_type === 'opendental') {
    const cfg = parse(decrypt(row.config_enc), {});
    return opendental.create(cfg);
  }
  return native; // built-in calendar mode (system of record is this database)
}

module.exports = { getAdapter, native, opendental };
