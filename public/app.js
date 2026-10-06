// app.js  -  everything the browser does: login, talking to the server,
// drawing the editor, participant list and activity feed.

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = {
    login: $('login'), workspace: $('workspace'),
    name: $('name'), roomId: $('roomId'), passcode: $('passcode'),
    createBtn: $('createBtn'), joinBtn: $('joinBtn'), loginError: $('loginError'),
    roomTitle: $('roomTitle'), status: $('status'), roleBadge: $('roleBadge'),
    editor: $('editor'), mirror: $('mirror'),
    members: $('members'), memberCount: $('memberCount'), activity: $('activity'),
    lockBtn: $('lockBtn'), leaveBtn: $('leaveBtn'), spamBtn: $('spamBtn'),
    cursorInfo: $('cursorInfo'), toast: $('toast'),
  };

  const SEND_EVERY_MS = 300;   // we send at most ~3 updates per second (server limit is 5)
  const TYPING_SHOW_MS = 1500; // how long the "typing..." badge stays after the last edit

  // Each browser TAB gets its own id (kept on refresh, different in another tab).
  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'u-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }
  const me = sessionStorage.getItem('userId') || makeId();
  sessionStorage.setItem('userId', me);

  // ---------- state ----------
  const sc = new SyncClient(me); // handles the edit bookkeeping (see syncclient.js)
  let ws = null;
  let creds = null;            // {mode, roomId, passcode, name}
  let joined = false;          // are we inside the room right now?
  let wantConnection = false;  // should we keep reconnecting if the socket drops?
  let retry = 0;
  let members = [];
  let hostId = null;
  let locked = false;
  const remote = {};           // userId -> {start, end}  (other people's cursors)
  const typingUntil = {};      // userId -> timestamp
  let sendTimer = null;
  let lastSend = 0;
  let lastCursor = '';
  let renderQueued = false;

  // ---------- small helpers ----------
  function colorOf(userId) {
    let h = 0;
    for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h; // a hue number; used as hsl(h, 70%, 55%)
  }
  const solid = (id) => `hsl(${colorOf(id)}, 70%, 50%)`;
  const tint = (id) => `hsla(${colorOf(id)}, 70%, 55%, 0.20)`;

  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.toast.classList.add('hidden'), 3000);
  }

  function setStatus(kind) {
    el.status.className = 'pill ' + kind;
    el.status.textContent = kind;
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function showLogin(error) {
    el.workspace.classList.add('hidden');
    el.login.classList.remove('hidden');
    el.loginError.textContent = error || '';
  }

  function showWorkspace() {
    el.login.classList.add('hidden');
    el.workspace.classList.remove('hidden');
    el.roomTitle.textContent = '# ' + creds.roomId;
  }

  // Put new text in the editor but keep the scroll position and the caret.
  function setEditorText(text, selStart, selEnd) {
    const top = el.editor.scrollTop;
    const left = el.editor.scrollLeft;
    const s = selStart ?? el.editor.selectionStart;
    const e = selEnd ?? el.editor.selectionEnd;
    el.editor.value = text;
    el.editor.setSelectionRange(Math.min(s, text.length), Math.min(e, text.length));
    el.editor.scrollTop = top;
    el.editor.scrollLeft = left;
    requestRender();
  }

  // ---------- connection ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}`);
    ws = socket;
    setStatus(retry === 0 && !joined ? 'connecting' : 'reconnecting');

    socket.onopen = () => {
      send({ type: 'join', mode: creds.mode, roomId: creds.roomId, passcode: creds.passcode, name: creds.name, userId: me });
    };
    socket.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handle(msg);
    };
    socket.onclose = () => {
      if (socket !== ws) return; // an old socket; ignore
      joined = false;
      el.editor.readOnly = true;
      if (!wantConnection) return;
      // Abrupt disconnect: try again with a growing delay (0.5s, 1s, 2s ... max 5s).
      setStatus('reconnecting');
      const delay = Math.min(5000, 500 * 2 ** retry);
      retry += 1;
      setTimeout(() => { if (wantConnection) connect(); }, delay);
    };
  }

  function startSession(mode) {
    const name = el.name.value.trim();
    const roomId = el.roomId.value.trim();
    if (!name || !roomId) {
      el.loginError.textContent = 'Please enter your name and a room ID.';
      return;
    }
    creds = { mode, roomId, passcode: el.passcode.value, name };
    el.loginError.textContent = '';
    wantConnection = true;
    retry = 0;
    connect();
  }

  // ---------- messages from the server ----------
  function handle(msg) {
    switch (msg.type) {
      case 'joined': {
        joined = true;
        retry = 0;
        creds.mode = 'join'; // if we reconnect later, we JOIN (never "create" again)
        sessionStorage.setItem('session', JSON.stringify(creds));
        showWorkspace();
        sc.reset(msg.text, msg.version);
        setEditorText(msg.text, 0, 0);
        applyMembers(msg);
        el.activity.replaceChildren();
        msg.activity.forEach(addActivity);
        lastCursor = '';
        setStatus('online');
        schedule();
        break;
      }
      case 'join_error': {
        wantConnection = false;
        sessionStorage.removeItem('session');
        if (ws) ws.close();
        showLogin(msg.reason);
        break;
      }
      case 'members':
        applyMembers(msg);
        break;
      case 'op': {
        sc.setText(el.editor.value); // make sure the bookkeeper sees what is on screen
        const res = sc.receive(msg);
        if (res.gap) { send({ type: 'resync' }); break; }
        if (res.ack) { schedule(); break; } // our own edit was confirmed; send anything typed since
        const s = OT.movePos(el.editor.selectionStart, res.atoms);
        const e = OT.movePos(el.editor.selectionEnd, res.atoms);
        setEditorText(sc.text, s, e);
        for (const id in remote) {
          if (id === msg.userId) continue;
          remote[id].start = OT.movePos(remote[id].start, res.atoms);
          remote[id].end = OT.movePos(remote[id].end, res.atoms);
        }
        typingUntil[msg.userId] = Date.now() + TYPING_SHOW_MS;
        renderMembers();
        break;
      }
      case 'cursor':
        remote[msg.userId] = { start: msg.start, end: msg.end };
        requestRender();
        renderMembers();
        break;
      case 'activity':
        addActivity(msg.entry);
        break;
      case 'sync': // server says: "here is the real text, reset yourself to it"
        sc.reset(msg.text, msg.version);
        setEditorText(msg.text);
        break;
      case 'throttled':
        toast('You are sending updates too fast - slow down!');
        break;
      case 'kicked':
        wantConnection = false;
        sessionStorage.removeItem('session');
        showLogin('The host removed you from the room.');
        break;
      case 'replaced':
        wantConnection = false;
        showLogin('This room was opened in another tab with the same session.');
        break;
      default:
    }
  }

  // ---------- sending our own changes ----------
  function schedule() {
    if (sendTimer || !joined) return;
    const wait = Math.max(0, SEND_EVERY_MS - (Date.now() - lastSend));
    sendTimer = setTimeout(flush, wait);
  }

  function flush() {
    sendTimer = null;
    if (!joined || !ws || ws.readyState !== 1) return;
    sc.setText(el.editor.value);
    const upd = sc.nextUpdate(); // null if nothing new, or if we still wait for a confirmation
    const start = el.editor.selectionStart;
    const end = el.editor.selectionEnd;
    const key = start + ',' + end;
    if (!upd && key === lastCursor) return;

    lastCursor = key;
    lastSend = Date.now();
    if (upd) {
      // our own edit moves other people's cursors too
      for (const id in remote) {
        remote[id].start = OT.movePos(remote[id].start, upd.ops);
        remote[id].end = OT.movePos(remote[id].end, upd.ops);
      }
    }
    send({
      type: 'update',
      baseVersion: upd ? upd.baseVersion : sc.version,
      ops: upd ? upd.ops : [],
      cursor: { start, end },
    });
  }

  el.editor.addEventListener('input', schedule);
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === el.editor) {
      schedule();
      updateCursorInfo();
    }
  });
  el.editor.addEventListener('scroll', () => {
    el.mirror.scrollTop = el.editor.scrollTop;
    el.mirror.scrollLeft = el.editor.scrollLeft;
  });

  function updateCursorInfo() {
    const before = el.editor.value.slice(0, el.editor.selectionStart).split('\n');
    el.cursorInfo.textContent = `Ln ${before.length}, Col ${before[before.length - 1].length + 1}`;
  }

  // ---------- participants ----------
  function applyMembers(msg) {
    members = msg.members;
    hostId = msg.hostId;
    locked = msg.locked;
    const ids = new Set(members.map((m) => m.userId));
    for (const m of members) if (m.userId !== me && m.cursor) remote[m.userId] = { ...m.cursor };
    for (const id of Object.keys(remote)) if (!ids.has(id)) delete remote[id];

    const iAmHost = hostId === me;
    el.roleBadge.textContent = iAmHost ? 'HOST' : 'member';
    el.roleBadge.className = 'pill role' + (iAmHost ? ' host' : '');
    el.lockBtn.classList.toggle('hidden', !iAmHost);
    el.lockBtn.textContent = locked ? 'Unlock editor' : 'Lock editor';
    el.editor.readOnly = !joined || (locked && !iAmHost);
    if (locked && !iAmHost) toast('The host locked the editor (read-only).');
    renderMembers();
    requestRender();
  }

  function lineCol(text, pos) {
    const before = text.slice(0, pos).split('\n');
    return `Ln ${before.length}, Col ${before[before.length - 1].length + 1}`;
  }

  function renderMembers() {
    const now = Date.now();
    el.memberCount.textContent = `(${members.filter((m) => m.online).length} online)`;
    el.members.replaceChildren();
    for (const m of members) {
      const li = document.createElement('li');
      if (!m.online) li.className = 'offline-user';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = solid(m.userId);
      li.append(dot);

      const name = document.createElement('span');
      name.textContent = m.name + (m.userId === me ? ' (you)' : '');
      li.append(name);

      const addBadge = (text, cls) => {
        const b = document.createElement('span');
        b.className = 'badge ' + cls;
        b.textContent = text;
        li.append(b);
      };
      if (m.userId === hostId) addBadge('host', 'host');
      if (!m.online) addBadge('reconnecting...', 'off');
      else if (m.userId !== me && (typingUntil[m.userId] || 0) > now) addBadge('typing...', 'typing');

      if (m.userId !== me && remote[m.userId]) {
        const pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = lineCol(el.editor.value, remote[m.userId].end);
        li.append(pos);
      }
      if (hostId === me && m.userId !== me) {
        const kick = document.createElement('button');
        kick.textContent = 'Remove';
        kick.className = 'danger';
        kick.onclick = () => send({ type: 'kick', userId: m.userId });
        li.append(kick);
      }
      el.members.append(li);
    }
  }
  // refresh the "typing..." badges as they expire
  setInterval(() => { if (joined) renderMembers(); }, 700);

  // ---------- activity feed ----------
  function addActivity(entry) {
    const li = document.createElement('li');
    const t = document.createElement('time');
    t.textContent = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const span = document.createElement('span');
    span.className = entry.kind;
    span.textContent = entry.text;
    li.append(t, span);
    el.activity.append(li);
    while (el.activity.children.length > 100) el.activity.firstChild.remove();
    el.activity.scrollTop = el.activity.scrollHeight;
  }

  // ---------- drawing other people's cursors and line highlights ----------
  // The transparent "mirror" div sits behind the textarea with the SAME text, font and
  // size. We highlight lines and draw coloured carets in the mirror, so they line up
  // exactly with what the textarea shows.
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderMirror();
    });
  }

  function renderMirror() {
    const text = el.editor.value;
    const lines = text.split('\n');
    const starts = [];
    let offset = 0;
    for (const l of lines) { starts.push(offset); offset += l.length + 1; }

    const lineOf = (pos) => {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
      }
      return lo;
    };

    // which lines have somebody's cursor on them?
    const marks = new Map(); // line index -> [{col, member}]
    for (const m of members) {
      const c = remote[m.userId];
      if (m.userId === me || !m.online || !c) continue;
      const pos = Math.min(c.end, text.length);
      const li = lineOf(pos);
      if (!marks.has(li)) marks.set(li, []);
      marks.get(li).push({ col: pos - starts[li], m });
    }

    const frag = document.createDocumentFragment();
    let plain = [];
    const flushPlain = () => {
      if (!plain.length) return;
      const d = document.createElement('div');
      d.textContent = plain.join('\n') + '​'; // zero-width char keeps empty lines tall
      frag.append(d);
      plain = [];
    };

    lines.forEach((line, i) => {
      const here = marks.get(i);
      if (!here) { plain.push(line); return; }
      flushPlain();
      const d = document.createElement('div');
      d.className = 'hl';
      d.style.background = tint(here[0].m.userId); // line highlight
      here.sort((a, b) => a.col - b.col);
      let last = 0;
      for (const { col, m } of here) {
        d.append(document.createTextNode(line.slice(last, col)));
        const caret = document.createElement('span');
        caret.className = 'caret';
        caret.style.borderColor = solid(m.userId);
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.style.background = solid(m.userId);
        tag.textContent = m.name;
        caret.append(tag);
        d.append(caret);
        last = col;
      }
      d.append(document.createTextNode(line.slice(last) + '​'));
      frag.append(d);
    });
    flushPlain();

    el.mirror.replaceChildren(frag);
    el.mirror.scrollTop = el.editor.scrollTop;
    el.mirror.scrollLeft = el.editor.scrollLeft;
  }

  el.editor.addEventListener('input', requestRender);

  // ---------- buttons ----------
  el.createBtn.onclick = () => startSession('create');
  el.joinBtn.onclick = () => startSession('join');
  for (const input of [el.name, el.roomId, el.passcode]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') startSession('join'); });
  }

  el.leaveBtn.onclick = () => {
    wantConnection = false;
    send({ type: 'leave' });
    sessionStorage.removeItem('session');
    if (ws) ws.close();
    joined = false;
    showLogin('');
  };

  el.lockBtn.onclick = () => send({ type: 'lock', locked: !locked });

  // Demo button: fire 30 messages at once to show the server-side throttle.
  el.spamBtn.onclick = () => {
    for (let i = 0; i < 30; i++) {
      send({ type: 'update', baseVersion: sc.version, ops: [], cursor: { start: i, end: i } });
    }
  };

  // After a page refresh: rejoin automatically.
  const saved = sessionStorage.getItem('session');
  if (saved) {
    try {
      creds = JSON.parse(saved);
      el.name.value = creds.name;
      el.roomId.value = creds.roomId;
      wantConnection = true;
      connect();
    } catch { sessionStorage.removeItem('session'); }
  }
})();
