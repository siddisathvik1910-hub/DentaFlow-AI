// Open Dental REST adapter (SKELETON, NOT TESTED AGAINST A LIVE OFFICE).
// Verify endpoints, field names and licensing against Open Dental's current API documentation before use.
// Reads are made synchronously-compatible by caching the last sync; writes go through async push.
//
// Config (stored encrypted in integrations.config_enc):
//   { baseUrl: "https://api.opendental.com/api/v1", developerKey: "...", customerKey: "..." }
function create(cfg) {
  const headers = { Authorization: `ODFHIR ${cfg.developerKey}/${cfg.customerKey}`, 'Content-Type': 'application/json' };
  const base = (cfg.baseUrl || 'https://api.opendental.com/api/v1').replace(/\/$/, '');
  const cache = new Map(); // providerId -> busy blocks from last sync

  async function api(method, path, body) {
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) throw new Error(`Open Dental ${method} ${path} -> HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  return {
    name: 'opendental',
    async testConnection() {
      try { await api('GET', '/appointments?dateStart=' + new Date().toISOString().slice(0, 10)); return { ok: true, message: 'Connected to Open Dental.' }; }
      catch (e) { return { ok: false, message: e.message }; }
    },
    // Called by a sync job (every 1-5 min) to refresh the cache used by listAppointments
    async sync(providerMap, fromDate, toDate) {
      const rows = await api('GET', `/appointments?dateStart=${fromDate}&dateEnd=${toDate}`);
      cache.clear();
      for (const r of rows || []) {
        const pid = providerMap[r.provNum];
        if (!pid) continue;
        const start = new Date(r.AptDateTime).toISOString();
        const end = new Date(new Date(r.AptDateTime).getTime() + (String(r.Pattern || '').length || 6) * 5 * 60000).toISOString();
        if (!cache.has(pid)) cache.set(pid, []);
        cache.get(pid).push({ id: String(r.AptNum), provider_id: pid, start_utc: start, end_utc: end, block_end_utc: end, status: 'booked' });
      }
    },
    listAppointments({ providerId, fromUtc, toUtc }) {
      return (cache.get(providerId) || []).filter((a) => a.start_utc < toUtc && a.block_end_utc > fromUtc);
    },
    createAppointment() { return null; /* implement: POST /appointments and return AptNum */ },
    cancelAppointment() { /* implement: PUT /appointments/{AptNum}/Break or delete */ },
  };
}
module.exports = { create };
