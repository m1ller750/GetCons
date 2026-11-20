/**
 * The website channel's own small front end, served by this server: the chat page (the
 * shareable chat link, also shown inside the widget) and widget.js, the one line a business adds
 * to its site. Plain JS without dependencies, so it loads fast on any site.
 */

const escapeAttr = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function chatPageHtml(key: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Chat</title>
<style>
:root{--bg:#f4f4f2;--card:#fff;--ink:#17181c;--mut:#6b6e76;--line:#e3e3df;--me:#17181c;--meText:#fff;--accent:#5b3fd6}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.app{display:flex;flex-direction:column;height:100%;max-width:720px;margin:0 auto;background:var(--card)}
@media (min-width:760px){body:not(.embed) .app{height:calc(100% - 48px);margin:24px auto;border:1px solid var(--line);border-radius:14px;overflow:hidden}}
header{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}
.mark{flex:none;width:36px;height:36px;border-radius:9px;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:650;font-size:15px;letter-spacing:-.01em}
.who{min-width:0;flex:1}
.who b{display:block;font-size:15px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.who span{display:flex;align-items:center;gap:6px;color:var(--mut);font-size:12.5px}
.who span i{width:7px;height:7px;border-radius:50%;background:#1f9d55}
.close{flex:none;width:34px;height:34px;border:0;border-radius:8px;background:transparent;color:var(--mut);cursor:pointer;font-size:22px;line-height:1}
.close:hover{background:#efefec;color:var(--ink)}
.list{flex:1;overflow-y:auto;padding:18px 14px 8px;display:flex;flex-direction:column;gap:6px;overscroll-behavior:contain}
.msg{max-width:82%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}
.msg.them{align-self:flex-start;background:#f1f1ee;border-bottom-left-radius:4px}
.msg.me{align-self:flex-end;background:var(--me);color:var(--meText);border-bottom-right-radius:4px}
.msg.me a{color:#fff}
.msg a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
.msg.pending{opacity:.6}
.msg.team{border:1px solid var(--line);background:#fff}
.gap{height:8px}
.typing{align-self:flex-start;display:none;gap:4px;padding:12px 14px;border-radius:14px;background:#f1f1ee}
.typing.on{display:flex}
.typing i{width:6px;height:6px;border-radius:50%;background:#9a9ca3;animation:b 1.2s infinite}
.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}
@keyframes b{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-3px);opacity:1}}
@media (prefers-reduced-motion:reduce){.typing i{animation:none}}
form{display:flex;align-items:flex-end;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--card)}
textarea{flex:1;resize:none;max-height:140px;min-height:42px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;color:inherit;background:#fff;outline:none}
textarea:focus{border-color:#a9abb2}
button.send{flex:none;height:42px;padding:0 16px;border:0;border-radius:10px;background:var(--ink);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.send:disabled{opacity:.4;cursor:default}
.foot{padding:0 12px 10px;text-align:center;font-size:11.5px;color:var(--mut)}
.foot a{color:var(--mut)}
.error{margin:6px auto;font-size:13px;color:#b42318;text-align:center}
.off{margin:auto;padding:24px;text-align:center;color:var(--mut)}
</style>
</head>
<body data-key="${escapeAttr(key)}">
<div class="app">
  <header>
    <div class="mark" id="mark">·</div>
    <div class="who"><b id="title">&nbsp;</b><span id="sub"><i></i><em id="subText" style="font-style:normal">&nbsp;</em></span></div>
    <button class="close" id="close" type="button" aria-label="Close" hidden>&times;</button>
  </header>
  <div class="list" id="list" role="log" aria-live="polite"><div class="typing" id="typing" aria-hidden="true"><i></i><i></i><i></i></div></div>
  <form id="form" autocomplete="off">
    <textarea id="input" rows="1" maxlength="2000" aria-label="Message"></textarea>
    <button class="send" id="send" type="submit" disabled>Send</button>
  </form>
  <div class="foot" id="foot" hidden><a href="/" target="_blank" rel="noopener">GetCons</a></div>
</div>
<script src="/c-assets/chat.js" defer></script>
</body>
</html>`;
}

export const CHAT_JS = String.raw`(function () {
  'use strict';
  var body = document.body;
  var key = body.getAttribute('data-key') || '';
  var embed = /[?&]embed=1(&|$)/.test(location.search);
  if (embed) body.classList.add('embed');
  var ru = /^(ru|uk|be|kk)/i.test(navigator.language || '');
  var T = ru
    ? { send: 'Отправить', placeholder: 'Напишите сообщение…', online: 'Отвечаем сразу', error: 'Не удалось отправить. Попробуйте ещё раз.', off: 'Чат сейчас недоступен.', slow: 'Слишком много сообщений. Подождите минуту.' }
    : { send: 'Send', placeholder: 'Write a message…', online: 'Replies right away', error: 'Could not send. Please try again.', off: 'This chat is not available right now.', slow: 'Too many messages. Please wait a minute.' };
  var api = '/api/public/chat/' + encodeURIComponent(key);
  var $ = function (id) { return document.getElementById(id); };
  var list = $('list'), typing = $('typing'), input = $('input'), sendBtn = $('send'), form = $('form');

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function newId() {
    var a = new Uint8Array(18); (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  var visitor = store('gc_v_' + key) || newId();
  store('gc_v_' + key, visitor);

  input.placeholder = T.placeholder; sendBtn.textContent = T.send; $('subText').textContent = T.online;
  if (embed) {
    var close = $('close'); close.hidden = false;
    close.addEventListener('click', function () { parent.postMessage({ type: 'getcons:close' }, '*'); });
  }

  var seen = {}, lastAt = null, waitingSince = 0, timer = null;

  // Text with clickable links and **bold**; never inserted as HTML.
  function fill(el, text) {
    var re = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]])|\*\*([^*]+)\*\*/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) { var a = document.createElement('a'); a.href = m[1]; a.target = '_blank'; a.rel = 'noopener nofollow'; a.textContent = m[1]; el.appendChild(a); }
      else { var b = document.createElement('strong'); b.textContent = m[2]; el.appendChild(b); }
      last = re.lastIndex;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  }
  function bubble(role, text, extra) {
    var el = document.createElement('div');
    el.className = 'msg ' + (role === 'customer' ? 'me' : 'them') + (role === 'operator' ? ' team' : '') + (extra ? ' ' + extra : '');
    fill(el, text);
    list.insertBefore(el, typing);
    list.scrollTop = list.scrollHeight;
    return el;
  }
  function showTyping(on) { typing.className = 'typing' + (on ? ' on' : ''); if (on) list.scrollTop = list.scrollHeight; }
  function note(text) {
    var el = document.createElement('div'); el.className = 'error'; el.textContent = text;
    list.insertBefore(el, typing); list.scrollTop = list.scrollHeight;
    setTimeout(function () { el.remove(); }, 6000);
  }

  function apply(messages) {
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (seen[m.id]) continue;
      seen[m.id] = true;
      if (!lastAt || m.at > lastAt) lastAt = m.at;
      if (m.role === 'customer') {
        var pending = list.querySelector('.msg.me.pending');
        if (pending && pending.getAttribute('data-text') === m.text) { pending.classList.remove('pending'); pending.removeAttribute('data-text'); continue; }
      } else if (waitingSince) {
        waitingSince = 0;
      }
      bubble(m.role, m.text);
    }
  }

  function schedule() {
    clearTimeout(timer);
    var delay = waitingSince && Date.now() - waitingSince < 90000 ? 1200 : document.hidden ? 30000 : 8000;
    timer = setTimeout(poll, delay);
  }
  function poll() {
    var url = api + '/messages?visitor=' + visitor + (lastAt ? '&after=' + encodeURIComponent(lastAt) : '');
    fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d) { apply(d.messages || []); showTyping(Boolean(d.typing) || (waitingSince && Date.now() - waitingSince < 90000)); }
      })
      .catch(function () {})
      .then(schedule);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  function resize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; sendBtn.disabled = !input.value.trim(); }
  input.addEventListener('input', resize);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); }
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = ''; resize();
    var el = bubble('customer', text, 'pending');
    el.setAttribute('data-text', text);
    waitingSince = Date.now(); showTyping(true);
    fetch(api + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitor: visitor, text: text, clientId: newId().slice(0, 24) })
    })
      .then(function (r) {
        if (r.status === 429) throw new Error(T.slow);
        if (!r.ok) throw new Error(T.error);
        schedule();
      })
      .catch(function (err) { el.remove(); waitingSince = 0; showTyping(false); input.value = text; resize(); note(err.message || T.error); });
  });

  fetch(api, { headers: { accept: 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error('off'); return r.json(); })
    .then(function (c) {
      var name = c.businessName || c.name || 'Chat';
      document.title = name;
      $('title').textContent = name;
      $('mark').textContent = name.trim().charAt(0).toUpperCase() || '·';
      if (c.poweredBy) $('foot').hidden = false;
      if (c.greeting) bubble('assistant', c.greeting);
      var gap = document.createElement('div'); gap.className = 'gap'; list.insertBefore(gap, typing);
      poll();
      if (!embed) input.focus();
    })
    .catch(function () {
      form.hidden = true; list.innerHTML = '';
      var off = document.createElement('div'); off.className = 'off'; off.textContent = T.off; list.appendChild(off);
    });
})();
`;

export const WIDGET_JS = String.raw`(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__getconsWidget) return;
  var key = script.getAttribute('data-key');
  if (!key) return;
  window.__getconsWidget = true;
  var origin = new URL(script.src).origin;
  var color = script.getAttribute('data-color') || '#17181c';
  var side = script.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var ru = /^(ru|uk|be|kk)/i.test(navigator.language || '');

  var css = document.createElement('style');
  css.textContent =
    '.gcw-btn{position:fixed;bottom:20px;' + side + ':20px;z-index:2147483646;width:56px;height:56px;border:0;border-radius:50%;cursor:pointer;' +
    'background:' + color + ';color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;transition:transform .15s}' +
    '.gcw-btn:hover{transform:scale(1.05)}.gcw-btn:focus-visible{outline:3px solid ' + color + ';outline-offset:3px}' +
    '.gcw-box{position:fixed;bottom:88px;' + side + ':20px;z-index:2147483647;width:380px;height:600px;max-height:calc(100vh - 112px);border-radius:14px;overflow:hidden;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.2);background:#fff;display:none}.gcw-box.on{display:block}.gcw-box iframe{border:0;width:100%;height:100%}' +
    '@media (max-width:480px){.gcw-box{inset:0;width:100%;height:100%;max-height:none;border-radius:0;bottom:0}}';
  document.head.appendChild(css);

  var box = document.createElement('div');
  box.className = 'gcw-box';
  var btn = document.createElement('button');
  btn.className = 'gcw-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', ru ? 'Открыть чат' : 'Open chat');
  btn.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';
  var frame = null;

  function open(on) {
    if (on && !frame) {
      frame = document.createElement('iframe');
      frame.src = origin + '/c/' + encodeURIComponent(key) + '?embed=1';
      frame.title = ru ? 'Чат' : 'Chat';
      frame.allow = 'clipboard-write';
      box.appendChild(frame);
    }
    box.className = 'gcw-box' + (on ? ' on' : '');
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  btn.addEventListener('click', function () { open(box.className.indexOf(' on') === -1); });
  window.addEventListener('message', function (e) {
    if (e.origin === origin && e.data && e.data.type === 'getcons:close') open(false);
  });
  document.body.appendChild(box);
  document.body.appendChild(btn);
})();
`;
