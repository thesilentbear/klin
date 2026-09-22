/* Klin renderer */

if (!window.__klin) {
window.__klin = true;
const $ = (id) => document.getElementById(id);
const api = window.api;

let settings = null;
let sessions = [];
let current = null;               // { id, title, messages }
let streamMeta = null;            // active stream { started, lastBubble, asst }
let pendingQueue = [];            // messages sent while a stream is active
let attachments = [];
let ctxTotal = 0;
let compactHandled = false;
let lastScroll = 0;
let zenFreeIds = [];              // free Zen model ids (from probe / zen:models)
let zenAllIds = [];               // full Zen catalogue (free + paid)

/* ---------- init ---------- */

function applyTheme(t) {
  const root = document.documentElement;
  if (!t) return;

  if (t.omarchy) {
    // Full Omarchy palette: map each CSS variable to the current theme's colours.
    root.dataset.theme = t.dark ? 'dark' : 'light';
    const o = t.omarchy;
    const setVar = (name, val) => {
      if (val && /^#[0-9a-fA-F]{6}$/.test(val)) root.style.setProperty(name, val);
      else root.style.removeProperty(name);
    };
    const bg = o.background;
    const fg = o.foreground || o.accent;
    const accent = pickAccent(o);
    setVar('--bg', bg);
    setVar('--text', fg);
    setVar('--bg2', o.darker_background || bg);
    setVar('--bg3', o.selection || bg);
    setVar('--border', t.dark ? mixHex(bg, '#ffffff', 0.09) : mixHex(bg, '#000000', 0.10));
    setVar('--muted', o.muted);
    setVar('--icon', o.muted ? mixHex(o.muted, fg, 0.28) : fg);
    setVar('--danger', o.red || o.bright_red);
    setVar('--warn', o.yellow || o.bright_yellow);
    setVar('--codebg', o.darker_background || bg);
    setVar('--above', o.selection || '#ffffff');
    setVar('--scroll', o.selection || bg);
    setVar('--sel', o.selection || bg);
    setVar('--seltext', fg);
    setVar('--accent', accent);
    setVar('--accent2', o.yellow || o.gold || '#c0a36e');
    setVar('--onaccent', contrastText(accent));
    if (t.font) root.style.setProperty('--font', t.font);
    if (t.mono) root.style.setProperty('--mono', t.mono);
    return;
  }

  root.dataset.theme = t.dark ? 'dark' : 'light';
  if (t.font) root.style.setProperty('--font', t.font);
  if (t.mono) root.style.setProperty('--mono', t.mono);
  if (t.accent && /^#[0-9a-fA-F]{6}$/.test(t.accent)) {
    // tint the two accents toward the system accent colour
    root.style.setProperty('--accent', t.accent);
    const teal = mixAccent(t.accent);
    root.style.setProperty('--accent2', teal);
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent2');
  }
}

// Kanagawa-style themes set accent == foreground (both cream) and reserve
// saturated hues for status. Match what the ecosystem actually does: use the
// theme's `accent` as-is (it's what bars/controls/links use), only veering to
// a warm highlight (yellow/orange/magenta) when accent is invisible on bg.
// Green and blue are deliberately avoided (they read as status colours).
function pickAccent(o) {
  const bg = o.background;
  for (const k of ['accent', 'bright_yellow', 'yellow', 'orange', 'magenta', 'bright_magenta', 'cyan', 'bright_cyan']) {
    if (o[k] && o[k] !== bg) return o[k];
  }
  for (const k of ['red', 'green', 'blue']) {
    if (o[k] && o[k] !== bg) return o[k];
  }
  return o.accent || o.blue || mixAccent(o.background || '#ffffff');
}

// Pick readable text colour (dark or white) to sit on an accent/selected bg.
function contrastText(hex) {
  const ch = hex.slice(1).match(/../g).map(x => parseInt(x, 16));
  const [r, g, b] = ch;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? '#111111' : '#ffffff';
}

function mixHex(hex1, hex2, t) {
  const ch = (h) => h.slice(1).match(/../g).map(x => parseInt(x, 16));
  const c = (a, b) => Math.round(a + (b - a) * t);
  const [r1, g1, b1] = ch(hex1);
  const [r2, g2, b2] = ch(hex2);
  return '#' + [c(r1, r2), c(g1, g2), c(b1, b2)].map(n => n.toString(16).padStart(2, '0')).join('');
}

function mixAccent(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // blend toward teal for a secondary accent that reads well on both themes
  const out = [Math.round(r * 0.35 + 0 * 0.65), Math.round(g * 0.35 + 214 * 0.65), Math.round(b * 0.35 + 190 * 0.65)];
  return '#' + out.map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
}

(async function init() {
  settings = await api.settingsGet();
  bindEvents();               // wire ALL buttons first — never block the UI on probes
  $('model-name').textContent = short((settings.provider === 'zen' ? settings.zenModel : settings.model) || (settings.llamaUrl || ''));
  applyTheme(await api.themeGet());
  api.onThemeChange(applyTheme);
  await refreshSessions();
  await newChat();
  void fillSettingsForm();    // non-blocking; probe/zen fills happen in the background
  if (!(await probe())) ensureProbing();
})();

function bindEvents() {
  $('btn-send').addEventListener('click', send);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('input').addEventListener('paste', onPaste);
  $('input').addEventListener('input', autosize);
  $('btn-attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', () => {
    const files = Array.from($('file-input').files || []);
    $('file-input').value = '';
    for (const f of files) readImageFile(f);
  });
  $('btn-new').addEventListener('click', async () => { await saveSession(); await newChat(); });
  $('btn-menu').addEventListener('click', () => $('sidebar').classList.toggle('hidden'));
  $('btn-settings').addEventListener('click', openSettings);
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from((e.dataTransfer || { files: [] }).files || []);
    for (const f of files) readImageFile(f);
  });
  $('settings-modal').addEventListener('click', (e) => { if (e.target === $('settings-modal')) $('settings-modal').hidden = true; });
  $('btn-settings-save').addEventListener('click', onSaveSettings);
  $('btn-settings-close').addEventListener('click', () => $('settings-modal').hidden = true);
}

async function probe() {
  const p = await api.probe();
  const dot = document.querySelector('.dot');
  dot.classList.remove('ok', 'err');
  if (p.llama) {
    dot.classList.add('ok');
    $('conn-text').textContent = 'connected';
    $('model-name').textContent = short(p.model || settings.model || '');
  } else if (p.zen) {
    dot.classList.add('ok');
    $('conn-text').textContent = 'zen (cloud)';
    $('model-name').textContent = short(currentZenModel());
  } else {
    dot.classList.add('err');
    $('conn-text').textContent = 'llama.cpp offline';
  }
  return p.llama;
}

function currentZenModel() {
  return settings.zenModel || (zenFreeIds.length ? zenFreeIds[0] : '');
}

let probeTimer = null;
function ensureProbing() {
  if (probeTimer) return;
  probeTimer = setInterval(async () => {
    if (await probe()) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
  }, 4000);
}

function short(s) { return (s || '').split('/').pop(); }

/* ---------- sessions ---------- */

async function refreshSessions() {
  sessions = await api.sessionsList();
  const box = $('session-list');
  box.innerHTML = '';
  sessions.forEach(s => {
    const el = document.createElement('div');
    el.className = 'sess' + (current && current.id === s.id ? ' active' : '');
    el.innerHTML = `<span class="sess-title"></span><button class="sess-del" title="Delete">✕</button>`;
    el.querySelector('.sess-title').textContent = s.title;
    el.querySelector('.sess-title').addEventListener('click', async () => { await saveSession(); await loadSession(s.id); });
    el.querySelector('.sess-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.sessionsDelete(s.id);
      if (current && current.id === s.id) await newChat();
      await refreshSessions();
    });
    box.appendChild(el);
  });
}

async function newChat() {
  if (current) await saveSession();
  current = { id: 's' + Date.now(), title: 'New chat', created: Date.now(), updated: Date.now(), messages: [] };
  streamMeta = null;
  pendingQueue = [];
  compactHandled = false;
  hideStatus();
  renderAll();
  refreshSessions();
}

async function loadSession(id) {
  const d = await api.sessionsLoad(id);
  if (!d) return;
  current = d;
  streamMeta = null;
  pendingQueue = [];
  compactHandled = false;
  hideStatus();
  renderAll();
  refreshSessions();
  updateCtxMeter();
}

async function saveSession() {
  if (!current) return;
  if (current.updated && current.updated === Date.now()) return;
  if (!current.messages.length) return;
  if (!current.title || current.title === 'New chat') {
    const first = current.messages.find(m => m.role === 'user');
    current.title = first && first.text ? first.text.slice(0, 40) : 'New chat';
  }
  current.updated = Date.now();
  await api.sessionsSave(current);
  refreshSessions();
}

/* ---------- rendering ---------- */

function renderAll() {
  const box = $('messages');
  box.innerHTML = '';
  if (!current || !current.messages.length) {
    const st = document.createElement('div');
    st.id = 'empty-state';
    st.className = 'empty-state';
    st.innerHTML = '<div class="empty-logo"><svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor" aria-hidden="true"><path d="M12 2c1.1 6.6 3.2 8.7 10 9.8-6.8 1.1-8.9 3.2-10 9.8-1.1-6.6-3.2-8.7-10-9.8C8.8 10.7 10.9 8.6 12 2z"/></svg></div><h1>Ask anything</h1>' +
      '<p>Web research enabled · YouTube transcripts &amp; comments<br/>Images: drag &amp; drop, paste (Ctrl+V), or the ＋ button. All local, no tracking.</p>';
    box.appendChild(st);
    return;
  }
  current.messages.forEach(m => addMessageEl(m));
  updateCtxMeter();
  scrollBottom();
}

function addMessageEl(m) {
  const box = $('messages');
  const isUser = m.role === 'user';
  const el = document.createElement('div');
  el.className = 'msg ' + (m.error ? 'error' : isUser ? 'user' : 'assistant');
  box.appendChild(el);

  if (m.isSummary) {
    const note = document.createElement('div');
    note.className = 'compact-note';
    note.textContent = '⟳ Earlier context compressed to summary';
    el.appendChild(note);
    el.classList.add('assistant');
  }

  if (isUser) {
    (m.images || []).forEach(d => {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = d;
      el.appendChild(img);
    });
    if (m.text) {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = m.text;
      el.appendChild(b);
    }
    return el;
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const replyQuote = renderReplyQuote(m);
  if (replyQuote) bubble.appendChild(replyQuote);

  if (m.reasoning) {
    const det = document.createElement('details');
    det.className = 'thought';
    const sum = document.createElement('summary');
    sum.textContent = 'Thought';
    const body = document.createElement('div');
    body.className = 'thought-md';
    body.innerHTML = renderMarkdown(m.reasoning);
    det.appendChild(sum);
    det.appendChild(body);
    bubble.appendChild(det);
  }

  if (m.text) {
    const b = document.createElement('div');
    b.className = 'md';
    b.innerHTML = renderMarkdown(m.text);
    bubble.appendChild(b);
  }

  const st = renderSteps(m.steps, m.tools, m.sources);
  if (st) bubble.appendChild(st);

  el.appendChild(bubble);
  scrollBottom();
  return el;
}

/* ---------- send ---------- */

async function send() {
  const inp = $('input');
  const text = inp.value.trim();
  if (!text && !attachments.length) return;
  if ((await probe())) { if (probeTimer) { clearInterval(probeTimer); probeTimer = null; } }
  const images = attachments.map(a => a.dataUrl);
  inp.value = '';
  autosize();
  attachments = [];
  $('attachments').innerHTML = '';

  if (streamMeta) {
    // busy: queue the message, show it in chat immediately, send later
    const userMsg = { role: 'user', text, images };
    const userEl = addMessageEl(userMsg);
    pendingQueue.push({ msg: userMsg, el: userEl });
    const note = document.createElement('div');
    note.className = 'queue-note';
    note.textContent = pendingQueue.length > 1 ? `queued (${pendingQueue.length} ahead)…` : 'queued… will send when current reply finishes';
    userEl.appendChild(note);
    return;
  }

  await doSend(text, images);
}

async function doSend(text, images, insertAfterEl) {
  $('empty-state')?.remove();
  hideStatus();

  const userMsg = { role: 'user', text, images };
  current.messages.push(userMsg);
  if (insertAfterEl) {
    // rendered at queue time; already in the DOM in the right position
  } else {
    addMessageEl(userMsg);
  }

  await maybeCompact();

  const payload = [
    { role: 'system', content: systemPrompt() },
    ...buildRequestMessages(),
  ];

  streamMeta = { started: false, tools: [] };
  const asst = { role: 'assistant', text: '', reasoning: '', tools: [], steps: [], replyTo: { text, hasImg: !!(images && images.length) } };
  current.messages.push(asst);
  const el = document.createElement('div');
  el.className = 'msg assistant';
  if (insertAfterEl) {
    insertAfterEl.insertAdjacentElement('afterend', el);
  } else {
    $('messages').appendChild(el);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  el.appendChild(bubble);
  const replyQuote = renderReplyQuote(asst);
  if (replyQuote) bubble.appendChild(replyQuote);
  const bodyEl = document.createElement('div');
  bodyEl.className = 'md';
  const thoughtEl = null;

  window._s = api.chat(payload, {
    onReasoning: (t) => {
      asst.reasoning += t;
      setStatus(asst.tools.length ? 'analyzing results' : 'thinking', asst.steps, bubble);
    },
    onChunk: (t) => {
      streamMeta.started = true;
      asst.text += t;
      if (!bodyEl.isConnected) bubble.appendChild(bodyEl);
      bodyEl.textContent = asst.text;
      hideStatus();
      if (Date.now() - lastScroll > 150) { lastScroll = Date.now(); scrollBottom(); }
    },
    onTool: (t) => {
      if (!t || !t.name) return;
      if (!t.done) asst.tools.push(t.name);
      if (t.done) {
        setStatus('analyzing results', asst.steps, bubble);
      } else {
        setStatus(t.name === 'search_web' ? 'searching web' : 'fetching video', asst.steps, bubble);
      }
    },
    onDone: (d) => {
      hideStatus();
      if (d.sources) asst.sources = d.sources;
      try {
        changeLastLiveBubble(d, asst, el);
      } finally {
        updateCtxMeter();
        saveSession();
        streamMeta = null;
        drainQueue();
      }
    },
  });
}

function drainQueue() {
  if (pendingQueue.length && !streamMeta) {
    const { msg, el } = pendingQueue.shift();
    doSend(msg.text, msg.images, el);
  }
}

function changeLastLiveBubble(d, asst, el) {
  if (!asst || !el) return;
  if (asst.bubbleReplaced) return;
  asst.bubbleReplaced = true;
  clearChildren(el);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  el.appendChild(bubble);
  // reply quote (which user message this answers)
  const q0 = renderReplyQuote(asst);
  if (q0) bubble.appendChild(q0);
  if (d.reasoning) {
    asst.reasoning = d.reasoning;
    const det = document.createElement('details');
    det.className = 'thought';
    const sum = document.createElement('summary');
    sum.textContent = 'Thought';
    const body = document.createElement('div');
    body.className = 'thought-md';
    body.innerHTML = renderMarkdown(d.reasoning);
    det.appendChild(sum);
    det.appendChild(body);
    bubble.appendChild(det);
  }
  const b = document.createElement('div');
  b.className = 'md';
  b.innerHTML = renderMarkdown(d.content || asst.text || '');
  bubble.appendChild(b);
  const st = renderSteps(asst.steps, asst.tools, asst.sources);
  if (st) bubble.appendChild(st);
  if (d.error) {
    asst.error = true;
    el.classList.add('error');
    const b2 = document.createElement('div');
    b2.className = 'md error-line';
    b2.textContent = '!' + ' ' + d.error;
    bubble.appendChild(b2);
  }
  scrollBottom();
}

function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }

/* --- sources card --- */

// Visible source links from a web search, shown under the answer.
// Agents steps are NOT persisted after completion — the progress indicator
// (3 dots + current action) is live-only and removed as soon as work moves on.
function renderSteps(steps, tools, sources) {
  if (!sources || !sources.length) return null;
  const box = document.createElement('div');
  box.className = 'sources-box';
  const head = document.createElement('div');
  head.className = 'sources-head';
  head.textContent = 'Sources';
  box.appendChild(head);
  sources.forEach(s => {
    const a = document.createElement('a');
    a.className = 'source-item';
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const title = document.createElement('span');
    title.className = 'source-title';
    title.textContent = s.title || s.url;
    const meta = document.createElement('span');
    meta.className = 'source-meta';
    meta.textContent = (s.url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    a.appendChild(title);
    a.appendChild(meta);
    box.appendChild(a);
  });
  return box;
}

function renderReplyQuote(m) {
  if (!m || !m.replyTo || m.role !== 'assistant') return null;
  const q = document.createElement('div');
  q.className = 'reply-quote';
  const ico = document.createElement('span');
  ico.className = 'reply-ico';
  ico.textContent = '↪';
  const txt = document.createElement('span');
  txt.className = 'reply-txt';
  let label = '';
  if (m.replyTo.hasImg) label += '[image] ';
  label += String(m.replyTo.text || '');
  txt.textContent = label;
  q.appendChild(ico);
  q.appendChild(txt);
  return q;
}

/* --- single inline status bubble (where the next agent message will appear) --- */
let _statusEl = null;
let _stepsEl = null;
let _curRow = null;

// Ephemeral progress indicator: 3 dots + the action currently being performed.
// It shows the *current* step only (no finished-step history) and disappears
// when the agent moves on, so it never lingers as clutter once done.
// The dots + label are created once and reused; only the label text changes,
// so the indicator never remounts/flickers on streamed reasoning tokens.
function setStatus(label, steps, liveEl) {
  const live = liveEl || liveBubble();
  if (live) {
    if (!_stepsEl || !_stepsEl.isConnected) {
      _stepsEl = document.createElement('div');
      _stepsEl.className = 'agent-steps';
      const quote = live.querySelector(':scope > .reply-quote');
      if (quote) quote.insertAdjacentElement('afterend', _stepsEl);
      else live.insertBefore(_stepsEl, live.firstChild);
      _curRow = null;
    }
    if (_curRow && _curRow.dataset.label === label) {
      if (steps && steps[steps.length - 1] !== label) steps.push(label);
      return;
    }
    if (!_curRow || !_curRow.isConnected) {
      _curRow = document.createElement('div');
      _curRow.className = 'agent-step active';
      _curRow.innerHTML = '<span class="step-dots"><i></i><i></i><i></i></span><span class="step-label"></span>';
      _stepsEl.appendChild(_curRow);
    }
    _curRow.dataset.label = label;
    _curRow.querySelector('.step-label').textContent = label;
    if (steps && steps[steps.length - 1] !== label) steps.push(label);
    scrollBottom();
    return;
  }
  if (!_statusEl) {
    _statusEl = document.createElement('div');
    _statusEl.className = 'msg status-msg';
    const bubble = document.createElement('div');
    bubble.className = 'status-bubble';
    bubble.innerHTML = '<span class="thinking-dots"><i></i><i></i><i></i></span><span class="status-label"></span>';
    _statusEl.appendChild(bubble);
  }
  _statusEl.querySelector('.status-label').textContent = label || 'working…';
  if (!_statusEl.isConnected) $('messages').appendChild(_statusEl);
  scrollBottom();
}

function liveBubble() {
  const msgs = $('messages').querySelectorAll('.msg.assistant');
  for (let i = msgs.length - 1; i >= 0; i--) {
    const b = msgs[i].querySelector(':scope > .bubble');
    if (b && b.isConnected) return b;
  }
  return null;
}

function hideStatus() {
  if (_stepsEl && _stepsEl.isConnected) _stepsEl.remove();
  _stepsEl = null;
  _curRow = null;
  if (_statusEl && _statusEl.isConnected) _statusEl.remove();
  _statusEl = null;
}

/* ---------- message shaping ---------- */

function buildRequestMessages() {
  const out = [];
  for (const m of current.messages) {
    if (m.error) continue;
    if (m.isSummary) continue;
    if (m.role === 'tool_result') { out.push({ role: 'user', content: m.text }); continue; }
    if (m.role === 'user') {
      if (m.images && m.images.length) {
        const parts = [];
        if (m.text) parts.push({ type: 'text', text: m.text });
        m.images.forEach(d => parts.push({ type: 'image_url', image_url: { url: d } }));
        out.push({ role: 'user', content: parts });
      } else if (m.text) {
        out.push({ role: 'user', content: m.text });
      }
      continue;
    }
    if (m.role === 'assistant') {
      if (!m.text && !(m.tools && m.tools.length)) continue; // skip in-flight/empty turns
      out.push({ role: 'assistant', content: m.text || '' });
    }
  }
  return out;
}

function systemPrompt() {
  return [
    'You are Qwen, created by Alibaba Cloud. You are a helpful assistant.',
    'You run inside "Klin", a private local chat app. Be concise, grounded, and direct.',
    'You can see images the user attaches or pastes into the chat. Use them to answer questions about photos, screenshots, charts, and documents.',
    'You have two tools: search_web (current, verifiable information) and get_youtube_transcript (YouTube videos). Use search_web whenever the user asks for recent events, facts you are unsure about, prices, dates, news, or verifiable claims. Use get_youtube_transcript when the user shares a YouTube link or asks about a video\'s content.',
    'Before asserting a fact you are not certain of, call search_web to verify it. If search results conflict with what you know, prefer the evidence and note the uncertainty.',
    'Earlier parts of the conversation may appear as a COMPACTED SUMMARY — treat it as full context.',
    'Web research and YouTube transcripts/comments are provided inside user messages as context. Use them and cite URLs when relevant.',
    'You have no filesystem or system access. If asked to act on the machine, decline politely.',
  ].join('\n');
}

/* ---------- compaction ---------- */

const CTX_LIMIT = 100000; // conservative working budget for the server's 163840 ctx

async function maybeCompact(force = false) {
  if (!current || current.messages.length < 10) return;
  const ctx = await updateCtxMeter();
  const pct = ctx.total / CTX_LIMIT;
  const auto = settings.compactAuto || 0.9;
  const nudge = settings.compactNudge || 0.75;
  if (force || pct >= auto || (!compactHandled && pct >= nudge)) {
    compactHandled = true;
    if (pct < auto && !force) {
      // just the nudge note, no auto-compact
      showCompactNote();
      return;
    }
    await compactConversation();
  }
}

function showCompactNote() {
  const note = document.createElement('div');
  note.className = 'compact-note';
  const btn = document.createElement('button');
  btn.textContent = '⟳ Compact now';
  btn.onclick = () => { note.remove(); current.messages = current.messages.slice(0, current.messages.length - (streamMeta ? 1 : 0)); compactConversation(true); };
  note.appendChild(document.createTextNode('Context is filling up. '));
  note.appendChild(btn);
  $('messages').appendChild(note);
  scrollBottom();
}

async function compactConversation(removePendingAssist = false) {
  if (!current || current.messages.length < 10) return;
  const tail = current.messages.slice(-6);
  const old = current.messages.slice(0, -6);
  if (old.length < 2) return;

  const note = document.createElement('div');
  note.className = 'compact-note';
  note.textContent = '⟳ Compacting earlier context…';
  $('messages').appendChild(note);
  scrollBottom();

  const oldText = old.map(m =>
    (m.role === 'user' ? 'User:' : m.role === 'tool_result' ? 'Context:' : 'Assistant:') +
    (m.text || '')
    + (m.images ? '\n[image attached]' : '')
  ).join('\n');

  const summaryPayload = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: 'Summarize the following conversation compactly. Keep facts, decisions, dates, names, links, preferences, and open questions. Bullet points only, no preamble. Do not include image descriptions.\n\n' + oldText.slice(0, 120000) },
  ];

  const result = await new Promise(resolve => {
    api.chat(summaryPayload, {
      onChunk: () => {},
      onTool: () => {},
      onDone: resolve,
    });
  });

  note.remove();

  if (result.error || !result.content) {
    showCompactNote();
    return;
  }

  const kept = tail.map(m => ({ ...m }));
  current.messages = [
    { role: 'assistant', text: '⟳ A COMPACTED SUMMARY of our conversation up to a few turns ago: "', isSummary: true },
    { role: 'user', content: 'COMPACTED CONTEXT:\n' + result.content, text: 'COMPACTED CONTEXT:\n' + result.content, isSummary: true },
    ...kept,
  ];
  compactHandled = true;
  renderAll();
}

/* ---------- ctx meter ---------- */

async function updateCtxMeter() {
  if (!current) return { total: 0 };
  const text = buildRequestMessages()
    .map(m => Array.isArray(m.content) ? ' '.concat(m.content.filter(p => p.text).map(p => p.text).join(' ')) : m.content)
    .join('\n');
  const total = await api.countTokens(text || ' ');
  ctxTotal = total;
  const el = $('ctx-meter');
  el.hidden = false;
  const pct = Math.round(100 * total / CTX_LIMIT);
  el.classList.toggle('warn', pct > 55);
  el.classList.toggle('full', pct > 80);
  el.textContent = `${pct}% · ${total.toLocaleString()} tok`;
  return { total };
}

/* ---------- images ---------- */

function readImageFile(f) {
  if (!f || !f.type || !f.type.startsWith('image/')) return;
  const rd = new FileReader();
  rd.onload = () => {
    attachments.push({ dataUrl: rd.result, name: f.name });
    renderAttachments();
  };
  rd.readAsDataURL(f);
}

function onPaste(e) {
  const items = (e.clipboardData || { items: [] }).items;
  let foundPng = false;
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      foundPng = true;
      const f = it.getAsFile();
      const rd = new FileReader();
      rd.onload = () => {
        attachments.push({ dataUrl: rd.result });
        renderAttachments();
      };
      rd.readAsDataURL(f);
    }
  }
  if (foundPng) e.preventDefault();
}

function renderAttachments() {
  const box = $('attachments');
  box.innerHTML = '';
  attachments.forEach((a, i) => {
    const w = document.createElement('div');
    w.className = 'attach';
    const img = document.createElement('img');
    img.src = a.dataUrl;
    const x = document.createElement('button');
    x.className = 'x'; x.textContent = '✕';
    x.onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    w.appendChild(img); w.appendChild(x);
    box.appendChild(w);
  });
}

/* ---------- settings ---------- */

async function refreshZenModels() {
  try {
    const z = await api.zenModels();
    if (z && z.ok) { zenFreeIds = z.free || []; zenAllIds = z.models || []; }
  } catch (e) { /* gateway unreachable; keep last-known list */ }
  return zenFreeIds;
}

function setModelSelect() {
  const sel = $('set-model');
  sel.innerHTML = '';
  const provider = $('set-provider').value || 'auto';
  if (provider === 'zen') {
    // Zen catalogue: free models first, then paid (require an API key)
    const ids = (zenAllIds.length ? zenAllIds : [...zenFreeIds]);
    const freeSet = new Set(zenFreeIds);
    const og = document.createElement('optgroup');
    og.label = 'OpenCode Zen (free)';
    for (const id of ids.filter(x => freeSet.has(x))) {
      const o = document.createElement('option');
      o.value = id; o.textContent = id; og.appendChild(o);
    }
    sel.appendChild(og);
    const og2 = document.createElement('optgroup');
    og2.label = 'OpenCode Zen (API key)';
    for (const id of ids.filter(x => !freeSet.has(x))) {
      const o = document.createElement('option');
      o.value = id; o.textContent = id; og2.appendChild(o);
    }
    if (og2.options.length) sel.appendChild(og2);
    const want = settings.zenModel || (zenFreeIds.length ? zenFreeIds[0] : '');
    if (want && [...sel.options].some(o => o.value === want)) sel.value = want;
    return;
  }
  // local or auto: llama models first, then free zen models
  const local = settings.localModels || [];
  const groups = [
    local.length ? { label: 'Local llama.cpp', ids: local, zen: false } : null,
    zenFreeIds.length ? { label: 'OpenCode Zen (free)', ids: zenFreeIds, zen: true } : null,
  ].filter(Boolean);
  if (!groups.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '(no models)';
    sel.appendChild(o);
    return;
  }
  for (const g of groups) {
    const og = document.createElement('optgroup');
    og.label = g.label;
    for (const id of g.ids) {
      const o = document.createElement('option');
      o.value = id;
      o.dataset.zen = g.zen;
      o.textContent = id;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  const want = settings.zenModel || settings.model || (zenFreeIds.length ? zenFreeIds[0] : '');
  if (want && [...sel.options].some(o => o.value === want)) sel.value = want;
}

async function fillSettingsForm() {
  $('set-llama').value = settings.llamaUrl || 'http://127.0.0.1:8080';
  $('set-searxng').value = settings.searxngUrl || 'http://127.0.0.1:8888';
  $('set-provider').value = settings.provider || 'auto';
  $('set-model').value = settings.zenModel || settings.model || '';
  $('set-zenkey').value = settings.zenApiKey || '';
  $('set-temp').value = settings.temp ?? 0.7;
  $('set-nudge').value = Math.round((settings.compactNudge ?? 0.75) * 100);
  $('set-auto').value = Math.round((settings.compactAuto ?? 0.9) * 100);
  $('set-results').value = settings.researchResults ?? 5;
  $('set-backend').value = settings.searchBackend || 'ddg';
  try {
    const p = await api.probe();
    settings.localModels = p.llamaModels || [];
    if (p.zenFree && p.zenFree.length) zenFreeIds = p.zenFree;
  } catch (e) { /* offline */ }
  if (!zenFreeIds.length) await refreshZenModels();
  else if (!zenAllIds.length) { try { const z = await api.zenModels(); if (z && z.ok) zenAllIds = z.models || []; } catch (e) {} }
  setModelSelect();
}
async function openSettings() { $('settings-modal').hidden = false; void fillSettingsForm(); } // show IMMEDIATELY; probes/zen fills run in the background
async function onSaveSettings() {
  const provider = $('set-provider').value;
  const chosen = $('set-model').value;
  const settingZen = provider === 'zen' || zenFreeIds.includes(chosen);
  settings = await api.settingsSet({
    llamaUrl: $('set-llama').value.trim(),
    searxngUrl: $('set-searxng').value.trim(),
    provider,
    model: settingZen ? settings.model : chosen,
    zenModel: settingZen ? chosen : settings.zenModel,
    zenApiKey: $('set-zenkey').value.trim(),
    temp: parseFloat($('set-temp').value),
    compactNudge: parseInt($('set-nudge').value) / 100,
    compactAuto: parseInt($('set-auto').value) / 100,
    researchResults: parseInt($('set-results').value),
    searchBackend: $('set-backend').value,
  });
  $('settings-modal').hidden = true;
  if (!(await probe())) ensureProbing();
  updateCtxMeter();
}

/* ---------- markdown (safe, dependency-free) ---------- */

function renderMarkdown(src) {
  if (!src) return '';
  const esc = String(src).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = esc.split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const t = l.trim();
    if (t.startsWith('```')) {
      const code = [];
      i++; let lang = 'plaintext';
      const first = t.slice(3).trim();
      if (first) lang = first.match(/^[a-zA-Z0-9+#_-]+/)?.[0] || 'plaintext';
      while (i < lines.length && !lines[i].trim().startsWith('```')) { code.push(lines[i]); i++; }
      i++;
      html.push(`<pre><code class="lang-${lang}">${code.join('\n')}</code></pre>`);
      continue;
    }
    if (/^#{1,3}\s/.test(t)) {
      const level = t.match(/^#+/)[0].length;
      const body = inline(t.replace(/^#{1,3}\s+/, ''), lineCtx());
      html.push(`<h${level}>${body}</h${level}>`);
      i++;
      continue;
    }
    // ul
    if (/^[-*]\s/.test(t)) {
      const items = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i].trim())) {
        items.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ''), lineCtx())}</li>`);
        i++;
      }
      html.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    // ol
    if (/^\d+\.\s/.test(t)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ''), lineCtx())}</li>`);
        i++;
      }
      html.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    if (t.startsWith('> ')) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith('> ')) { block.push(lines[i].replace(/^>\s?/, '')); i++; }
      html.push(`<blockquote>${inline(block.join(' '), lineCtx())}</blockquote>`);
      continue;
    }
    if (/^-{3,}$/.test(t)) { html.push('<hr>'); i++; continue; }
    if (t === '') { i++; continue; }
    html.push(`<p>${inline(t, lineCtx())}</p>`);
    i++;
  }
  return html.join('\n');

  function lineCtx() {}
}

function inline(s) {
  let out = s;
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (/^(https?:|mailto:)/i.test(url)) return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    return m;
  });
  return out;
}

/* ---------- misc ---------- */

function scrollBottom() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}
function autosize() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}

} /* window.__klin */