/* Embeddable chat widget. Usage on any clinic website:
   <script src="https://YOUR-DOMAIN/js/widget.js" data-key="WIDGET_KEY" defer></script>
   On this site (data-demo="true") it uses the demo clinic. Messages go to /api/public/chat/*. */
(function () {
  var me = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var origin = (me && me.src) ? new URL(me.src).origin : location.origin;
  var key = me && me.getAttribute('data-key');
  var demo = me && me.getAttribute('data-demo') === 'true';
  var panel, log, form, input, convId = null, started = false, sending = false;

  function api(path, body) {
    return fetch(origin + '/api/public/chat/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Request failed'); return d; }); });
  }
  function add(role, text) {
    var d = document.createElement('div'); d.className = 'cw-msg ' + role; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
  }
  function build(title) {
    var launch = document.createElement('button');
    launch.className = 'cw-launch'; launch.type = 'button'; launch.setAttribute('aria-haspopup', 'dialog');
    launch.textContent = demo ? 'Chat with the demo assistant' : 'Chat with us';
    panel = document.createElement('div'); panel.className = 'cw-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Chat with ' + title);
    var head = document.createElement('div'); head.className = 'cw-head';
    var h = document.createElement('strong'); h.textContent = title;
    var x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', 'Close chat'); x.textContent = '×';
    head.appendChild(h); head.appendChild(x);
    log = document.createElement('div'); log.className = 'cw-log'; log.setAttribute('aria-live', 'polite');
    form = document.createElement('form'); form.className = 'cw-form';
    input = document.createElement('input'); input.type = 'text'; input.maxLength = 500; input.placeholder = 'Type your message'; input.setAttribute('aria-label', 'Your message'); input.autocomplete = 'off';
    var send = document.createElement('button'); send.type = 'submit'; send.className = 'btn btn-sm'; send.textContent = 'Send';
    form.appendChild(input); form.appendChild(send);
    var note = document.createElement('div'); note.className = 'cw-note'; note.textContent = 'Automated assistant. Not for medical emergencies: call 911.';
    panel.appendChild(head); panel.appendChild(log); panel.appendChild(form); panel.appendChild(note);
    document.body.appendChild(launch); document.body.appendChild(panel);
    launch.addEventListener('click', function () { panel.hidden = false; launch.hidden = true; input.focus(); begin(); });
    x.addEventListener('click', function () { panel.hidden = true; launch.hidden = false; launch.focus(); });
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') x.click(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim(); if (!text || sending || !convId) return;
      input.value = ''; add('user', text); sending = true;
      var typing = add('agent', '…');
      api('message', { widget_key: key, conversation_id: convId, message: text })
        .then(function (r) { typing.textContent = r.reply; if (r.ended) { input.disabled = true; input.placeholder = 'Conversation ended'; } })
        .catch(function (err) { typing.textContent = 'Sorry, ' + err.message.toLowerCase() + '. Please try again.'; })
        .then(function () { sending = false; log.scrollTop = log.scrollHeight; if (!input.disabled) input.focus(); });
    });
  }
  function begin() {
    if (started) return; started = true;
    var sess = null; try { sess = sessionStorage.getItem('df_chat'); } catch (e) { /* ignore */ }
    api('start', { widget_key: key, session_id: sess || undefined }).then(function (r) {
      convId = r.conversation_id; try { sessionStorage.setItem('df_chat', r.session_id); } catch (e) { /* ignore */ }
      add('agent', r.greeting || 'Hi! How can I help?');
    }).catch(function () { add('agent', 'Sorry, chat is unavailable right now. Please call the office.'); });
  }
  var built = false;
  function init() {
    if (built) return; // idempotent: never create two panels
    if (key) { built = true; return build('Virtual assistant'); }
    if (!demo) return;
    built = true;
    fetch(origin + '/api/public/config').then(function (r) { return r.json(); }).then(function (c) {
      if (c.demoWidgetKey) { key = c.demoWidgetKey; build('Bright Smile Dental (demo)'); }
    }).catch(function () { /* widget is optional */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
