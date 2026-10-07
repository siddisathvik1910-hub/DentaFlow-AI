// Starts the app on a random port with a throwaway database (unless BASE_URL is given) for the audit scripts.
const fs = require('fs'), os = require('os'), path = require('path');
module.exports = async function boot() {
  if (process.env.BASE_URL && process.env.AUDIT_REMOTE === '1') return { base: process.env.BASE_URL, close: async () => {} };
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dentaflow-audit-'));
  process.env.DF_DISABLE_RATE_LIMIT = '1';
  const { createApp } = require('../server/index');
  const server = await new Promise((res) => { const s = createApp().listen(0, () => res(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
};
