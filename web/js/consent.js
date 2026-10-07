/* Cookie consent. Choice is stored in localStorage under df_consent for 12 months.
   Analytics never runs until the visitor accepts. Equal-prominence Accept / Essential-only buttons. */
(function () {
  var KEY = 'df_consent', MAX_AGE = 365 * 24 * 3600 * 1000;
  function read() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && v.ts && Date.now() - v.ts < MAX_AGE) return v; } catch (e) { /* ignore */ }
    return null;
  }
  function write(analytics) {
    var v = { analytics: !!analytics, ts: Date.now(), v: 1 };
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* storage blocked: choice applies to this page view only */ }
    return v;
  }
  var banner = document.getElementById('cookie-banner');
  var lastFocus = null;
  function show() { if (!banner) return; lastFocus = document.activeElement; banner.hidden = false; var b = banner.querySelector('button'); if (b) b.focus(); }
  function hide() { if (!banner) return; banner.hidden = true; if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } } }
  function apply(analytics) {
    var v = write(analytics);
    hide();
    document.dispatchEvent(new CustomEvent('df:consent', { detail: v }));
  }
  window.DFConsent = { get: read, open: show };
  if (banner) {
    banner.addEventListener('click', function (e) {
      var t = e.target.closest('[data-consent]');
      if (t) apply(t.getAttribute('data-consent') === 'all');
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !banner.hidden && read()) hide(); });
    if (!read()) { lastFocus = null; banner.hidden = false; }
  }
  document.addEventListener('click', function (e) { if (e.target.closest('[data-cookie-settings]')) { e.preventDefault(); show(); } });
})();
