/* Marketing site behaviour: mobile menu + demo-request form (client-side validation, accessible errors). */
(function () {
  var toggle = document.querySelector('.nav-toggle'), nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () { var open = nav.classList.toggle('open'); toggle.setAttribute('aria-expanded', open ? 'true' : 'false'); });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); } });
  }

  var form = document.getElementById('lead-form');
  if (!form) return;
  var status = document.getElementById('lead-status');
  var submit = document.getElementById('lead-submit');
  var token = '';
  fetch('/api/public/form-token').then(function (r) { return r.json(); }).then(function (d) { token = d.token; }).catch(function () { /* validated server-side */ });

  fetch('/api/public/config').then(function (r) { return r.json(); }).then(function (c) {
    if (c.turnstileSiteKey) {
      var s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'; s.async = true; s.defer = true;
      s.onload = function () { window.turnstile && window.turnstile.render('#turnstile-box', { sitekey: c.turnstileSiteKey }); };
      document.head.appendChild(s);
    }
  }).catch(function () { /* optional */ });

  var rules = {
    name: function (v) { return v.trim().length >= 2 ? '' : 'Please enter your name.'; },
    email: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Please enter a valid email address, like name@practice.com.'; },
    clinic: function (v) { return v.trim().length >= 2 ? '' : 'Please enter your practice name.'; },
    phone: function (v) { return !v.trim() || /^[\d\s()+.-]{7,30}$/.test(v.trim()) ? '' : 'Phone numbers can only include digits and + ( ) - .'; },
    message: function (v) { return v.length <= 1000 ? '' : 'Please keep your message under 1000 characters.'; },
    consent: function (v, el) { return el.checked ? '' : 'Please agree to be contacted so we can respond.'; }
  };
  function setErr(name, msg) {
    var el = form.elements[name], p = document.getElementById('lf-' + name + '-err');
    if (!el || !p) return;
    p.textContent = msg || '';
    if (msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
  }
  function check(name) { var el = form.elements[name]; var msg = rules[name](el.value || '', el); setErr(name, msg); return msg; }
  Object.keys(rules).forEach(function (n) {
    var el = form.elements[n];
    el.addEventListener('blur', function () { if (el.value || n === 'consent') check(n); });
    el.addEventListener('input', function () { if (el.getAttribute('aria-invalid')) check(n); });
    if (n === 'consent') el.addEventListener('change', function () { if (el.getAttribute('aria-invalid')) check(n); });
  });

  function banner(kind, text) { status.innerHTML = ''; var d = document.createElement('div'); d.className = 'form-msg ' + kind; d.textContent = text; status.appendChild(d); status.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    status.innerHTML = '';
    var firstBad = null;
    Object.keys(rules).forEach(function (n) { if (check(n) && !firstBad) firstBad = form.elements[n]; });
    if (firstBad) { firstBad.focus(); return; }
    submit.disabled = true; var label = submit.textContent; submit.textContent = 'Sending…';
    var tsEl = form.querySelector('[name="cf-turnstile-response"]');
    var el = form.elements; var body = { name: el.name.value, email: el.email.value, clinic: el.clinic.value, phone: el.phone.value, message: el.message.value, consent: el.consent.checked, website: el.website.value, t: token, turnstile: tsEl ? tsEl.value : undefined };
    fetch('/api/public/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) { form.reset(); form.hidden = true; banner('ok', 'Thank you! We received your request and will reply within one business day.'); return; }
        if (res.d.fields) { Object.keys(res.d.fields).forEach(function (k) { setErr(k, res.d.fields[k]); }); var f = form.querySelector('[aria-invalid="true"]'); if (f) f.focus(); }
        banner('bad', res.d.error || 'Something went wrong. Please try again.');
        fetch('/api/public/form-token').then(function (r) { return r.json(); }).then(function (d) { token = d.token; });
      })
      .catch(function () { banner('bad', 'We could not send your request. Please check your connection and try again.'); })
      .then(function () { submit.disabled = false; submit.textContent = label; });
  });
})();
