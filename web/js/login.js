(function () {
  var form = document.getElementById('login-form'), msg = document.getElementById('login-msg');
  var codeField = document.getElementById('code-field'), submit = document.getElementById('login-submit');
  fetch('/api/public/config').then(function (r) { return r.json(); }).then(function (c) { if (c.demoWidgetKey) document.getElementById('demo-hint').hidden = false; }).catch(function () {});
  fetch('/api/auth/me').then(function (r) { if (r.ok) location.replace('/app'); }).catch(function () {});
  function err(id, text) { var p = document.getElementById(id + '-err'), el = form.elements[id]; p.textContent = text || ''; if (text) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
  form.addEventListener('submit', function (e) {
    e.preventDefault(); msg.textContent = ''; msg.className = '';
    var email = form.elements.email.value.trim(), pw = form.elements.password.value, bad = false;
    err('email', /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? '' : 'Enter a valid email address.'); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) bad = true;
    err('password', pw ? '' : 'Enter your password.'); if (!pw) bad = true;
    if (bad) { form.querySelector('[aria-invalid="true"]').focus(); return; }
    submit.disabled = true;
    fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, password: pw, code: form.elements.code.value.trim() || undefined }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.mfa_required) { codeField.hidden = false; form.elements.code.focus(); msg.className = 'form-msg ok'; msg.textContent = 'Enter the 6-digit code from your authenticator app.'; return; }
        if (res.ok) { location.replace('/app'); return; }
        msg.className = 'form-msg bad'; msg.textContent = res.d.error || 'Sign-in failed.';
      })
      .catch(function () { msg.className = 'form-msg bad'; msg.textContent = 'Could not reach the server. Check your connection.'; })
      .then(function () { submit.disabled = false; });
  });
})();
