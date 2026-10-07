/* Consent-gated analytics. Runs ONLY after the visitor accepts analytics.
   - First-party beacon: path + referrer host + device class. No cookies, no IP stored.
   - Optional Google Analytics 4 / Plausible if IDs are configured on the server (/api/public/config). */
(function () {
  var started = false;
  function sid() {
    try { var s = sessionStorage.getItem('df_sid'); if (!s) { s = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('df_sid', s); } return s; } catch (e) { return null; }
  }
  function load(src, attrs) { var s = document.createElement('script'); s.async = true; s.src = src; for (var k in attrs || {}) s.setAttribute(k, attrs[k]); document.head.appendChild(s); }
  function start() {
    if (started) return; started = true;
    var payload = { path: location.pathname, referrer: document.referrer || undefined, session: sid() || undefined, consent: true };
    try { fetch('/api/public/collect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true }); } catch (e) { /* ignore */ }
    fetch('/api/public/config').then(function (r) { return r.json(); }).then(function (c) {
      if (c.ga4 && /^G-[A-Z0-9]+$/.test(c.ga4)) {
        window.dataLayer = window.dataLayer || [];
        window.gtag = function () { window.dataLayer.push(arguments); };
        window.gtag('js', new Date()); window.gtag('config', c.ga4, { anonymize_ip: true });
        load('https://www.googletagmanager.com/gtag/js?id=' + c.ga4);
      }
      if (c.plausibleDomain) load('https://plausible.io/js/script.js', { defer: '', 'data-domain': c.plausibleDomain });
    }).catch(function () { /* analytics must never break the page */ });
  }
  function stop() {
    started = false;
    try { sessionStorage.removeItem('df_sid'); } catch (e) { /* ignore */ }
    // remove Google Analytics cookies if they exist
    document.cookie.split(';').forEach(function (c) { var n = c.split('=')[0].trim(); if (n === '_ga' || n.indexOf('_ga_') === 0 || n === '_gid') { document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; } });
  }
  function init() {
    var c = window.DFConsent && window.DFConsent.get();
    if (c && c.analytics) start();
    document.addEventListener('df:consent', function (e) { if (e.detail && e.detail.analytics) start(); else stop(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
