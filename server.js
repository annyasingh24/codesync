// server.js  -  the "referee". Every edit goes through here, gets ordered,
// fixed (transformed) if it arrived late, and then broadcast to everybody.

'use strict';
const path = require('path');

// Tiny built-in .env reader (so we need no extra package).
// Lines look like:  PORT=3000   (lines starting with # are comments)
try {
  const lines = require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch (e) { /* no .env file is fine */ }
const http = require('http');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const OT = require('./public/ot.js');
const { RoomStore } = require('./rooms');

const ROOM_RE = /^[A-Za-z0-9_-]{3,32}$/;
const USER_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_DOC_CHARS = 200000;
const MAX_ATOMS = 4;

function start(opts = {}) {
  const port = opts.port ?? (process.env.PORT === undefined ? 3000 : Number(process.env.PORT));
  const graceMs = opts.graceMs ?? (process.env.GRACE_MS === undefined ? 5000 : Number(process.env.GRACE_MS));
  const maxUpdates = opts.maxUpdates ?? (Number(process.env.MAX_UPDATES_PER_SEC) || 5);
  const dataFile = opts.dataFile || process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');

  const store = new RoomStore(dataFile);

  // A tiny web server that hands out the files in the /public folder.
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const publicDir = path.join(__dirname, 'public');
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.normalize(path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath));
    if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end('Forbidden'); } // block ../ tricks
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
      res.end(data);
    });
  });
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

  // ---------- small helpers ----------
  const send = (ws, obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  function broadcast(room, obj, exceptUserId) {
    for (const m of room.members.values()) {
      if (m.online && m.ws && m.userId !== exceptUserId) send(m.ws, obj);
    }
  }

  function membersPayload(room) {
    return {
      type: 'members',
      hostId: room.hostId,
      locked: room.locked,
      members: [...room.members.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((m) => ({ userId: m.userId, name: m.name, joinedAt: m.joinedAt, online: m.online, cursor: m.cursor })),
    };
  }

  // Add a line to the audit feed and tell everyone (except one person if wanted).
  function logActivity(room, kind, text, exceptUserId) {
    const entry = { time: Date.now(), kind, text };
    room.activity.push(entry);
    if (room.activity.length > 100) room.activity.shift();
    broadcast(room, { type: 'activity', entry }, exceptUserId);
  }

  function sendSync(ws, room) {
    send(ws, { type: 'sync', text: room.text, version: room.version });
  }

  function cleanName(name) {
    return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  }

  // The "oldest active member" rule for choosing a new host.
  function oldestOnline(room) {
    return [...room.members.values()]
      .filter((m) => m.online)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
  }

  // ---------- spam / flood protection ----------
  // Keep the times of this connection's last updates. If it already sent
  // `maxUpdates` in the last second, the new one is refused.
  function allowUpdate(ws) {
    const now = Date.now();
    ws.updateTimes = ws.updateTimes.filter((t) => now - t < 1000);
    if (ws.updateTimes.length >= maxUpdates) return false;
    ws.updateTimes.push(now);
    return true;
  }

  // ---------- joining ----------
  function joinError(ws, reason) {
    send(ws, { type: 'join_error', reason });
  }

  function handleJoin(ws, msg) {
    if (ws.session) return;
    const roomId = String(msg.roomId || '').trim();
    const name = cleanName(msg.name);
    const userId = String(msg.userId || '');
    const passcode = String(msg.passcode || '').slice(0, 100);

    if (!ROOM_RE.test(roomId)) return joinError(ws, 'Room ID must be 3-32 characters: letters, numbers, - or _');
    if (!name) return joinError(ws, 'Please enter a name (max 20 characters)');
    if (!USER_RE.test(userId)) return joinError(ws, 'Invalid user id');

    let room = store.get(roomId);
    if (msg.mode === 'create') {
      if (room) return joinError(ws, 'That room ID is already taken. Pick another, or use Join.');
      room = store.create(roomId, passcode);
      logActivity(room, 'info', `Room "${roomId}" created`);
    } else {
      if (!room) return joinError(ws, 'Room not found. Check the ID, or create it.');
      // CREDENTIALS ARE CHECKED HERE, BEFORE the client is admitted.
      if (!store.checkPass(room, passcode)) {
        ws.failedJoins += 1;
        joinError(ws, 'Wrong passcode');
        if (ws.failedJoins >= 5) ws.close(); // stop guessing
        return;
      }
    }

    // Admit the client.
    let member = room.members.get(userId);
    const reconnected = Boolean(member);
    if (member) {
      // Same person coming back (e.g. page refresh or network drop).
      clearTimeout(member.graceTimer);
      member.graceTimer = null;
      if (member.ws && member.ws !== ws) {
        member.ws.session = null;
        send(member.ws, { type: 'replaced' });
        member.ws.close();
      }
      member.ws = ws;
      member.online = true;
      member.name = name;
    } else {
      member = { userId, name, ws, online: true, joinedAt: Date.now(), cursor: null, graceTimer: null };
      room.members.set(userId, member);
    }
    ws.session = { roomId: room.id, userId };

    // First person in (or creator) becomes host.
    if (!room.hostId || !room.members.has(room.hostId)) room.hostId = userId;

    logActivity(room, 'join', reconnected ? `${name} reconnected` : `${name} joined`, userId);
    send(ws, {
      ...membersPayload(room),
      type: 'joined', // (must come after the spread, which also has a "type")
      userId,
      roomId: room.id,
      text: room.text,
      version: room.version,
      activity: room.activity,
    });
    broadcast(room, membersPayload(room), userId);
  }

  // ---------- leaving ----------
  function removeMember(room, userId, why) {
    const m = room.members.get(userId);
    if (!m) return;
    clearTimeout(m.graceTimer);
    room.members.delete(userId);
    logActivity(room, 'leave', `${m.name} left (${why})`);

    // HOST TRANSFER: if the host is gone, the oldest active member takes over.
    if (room.hostId === userId) {
      room.hostId = null;
      const next = oldestOnline(room);
      if (next) {
        room.hostId = next.userId;
        logActivity(room, 'host', `Host ${m.name} left, so ${next.name} is now the host`);
      }
    }
    broadcast(room, membersPayload(room));
  }

  function onClose(ws) {
    const s = ws.session;
    if (!s) return;
    ws.session = null;
    const room = store.get(s.roomId);
    const m = room && room.members.get(s.userId);
    if (!m || m.ws !== ws) return;

    // Abrupt disconnect: do not remove them right away. Wait a few seconds so
    // that a refresh / Wi-Fi blip can reconnect without losing the host role.
    m.online = false;
    m.ws = null;
    logActivity(room, 'warn', `${m.name} lost connection`);
    broadcast(room, membersPayload(room));
    m.graceTimer = setTimeout(() => removeMember(room, s.userId, 'disconnected'), graceMs);
  }

  // ---------- edits ----------
  function validAtoms(ops) {
    if (!Array.isArray(ops) || ops.length > MAX_ATOMS) return null;
    const out = [];
    for (const a of ops) {
      if (!a || !Number.isInteger(a.pos) || a.pos < 0) return null;
      if (a.t === 'ins' && typeof a.text === 'string' && a.text.length > 0 && a.text.length <= MAX_DOC_CHARS) {
        out.push({ t: 'ins', pos: a.pos, text: a.text });
      } else if (a.t === 'del' && Number.isInteger(a.len) && a.len > 0 && a.len <= MAX_DOC_CHARS) {
        out.push({ t: 'del', pos: a.pos, len: a.len });
      } else return null;
    }
    return out;
  }

  // Apply atoms but refuse anything that points outside the text.
  function safeApply(text, ops) {
    for (const a of ops) {
      if (a.t === 'ins') {
        if (a.pos > text.length) return null;
        text = text.slice(0, a.pos) + a.text + text.slice(a.pos);
      } else {
        if (a.pos + a.len > text.length) return null;
        text = text.slice(0, a.pos) + text.slice(a.pos + a.len);
      }
    }
    return text.length <= MAX_DOC_CHARS ? text : null;
  }

  function handleUpdate(ws, msg) {
    const room = store.get(ws.session.roomId);
    const member = room && room.members.get(ws.session.userId);
    if (!member) return;
    const hasOps = Array.isArray(msg.ops) && msg.ops.length > 0;

    // Throttle: too many updates in one second -> drop it.
    if (!allowUpdate(ws)) {
      if (hasOps) sendSync(ws, room); // discard their edit, put their editor back to the real text
      const now = Date.now();
      if (now - ws.lastThrottleNotice > 2000) {
        ws.lastThrottleNotice = now;
        send(ws, { type: 'throttled' });
        logActivity(room, 'warn', `${member.name} is sending updates too fast - extra updates dropped`);
      }
      return;
    }

    // Cursor position (only a "what the user sees" thing, not saved)
    if (msg.cursor && Number.isInteger(msg.cursor.start) && Number.isInteger(msg.cursor.end)) {
      const clamp = (n) => Math.max(0, Math.min(n, MAX_DOC_CHARS));
      member.cursor = { start: clamp(msg.cursor.start), end: clamp(msg.cursor.end) };
    }

    if (hasOps) {
      if (room.locked && ws.session.userId !== room.hostId) return sendSync(ws, room);
      let ops = validAtoms(msg.ops);
      const base = msg.baseVersion;
      if (!ops || !Number.isInteger(base) || base < room.histBase || base > room.version) {
        return sendSync(ws, room);
      }

      // THE KEY STEP: the sender wrote this edit when the document was at
      // version `base`. Other edits may have been accepted since. Adjust the
      // edit for each of them, oldest first.
      for (const earlier of room.history.slice(base - room.histBase)) {
        ops = OT.xform(ops, earlier, false)[0];
      }

      const newText = safeApply(room.text, ops);
      if (newText === null) return sendSync(ws, room);

      room.text = newText;
      room.history.push(ops);
      room.version += 1;
      if (room.history.length > 500) {
        room.history.splice(0, 250);
        room.histBase += 250;
      }
      store.scheduleSave();
      // Everyone (including the sender, which counts as "confirmed") gets it.
      broadcast(room, { type: 'op', userId: member.userId, version: room.version, ops });
    }

    if (member.cursor) {
      broadcast(room, { type: 'cursor', userId: member.userId, ...member.cursor }, member.userId);
    }
  }

  function handleMessage(ws, msg) {
    if (msg.type === 'join') return handleJoin(ws, msg);
    if (!ws.session) return;
    const room = store.get(ws.session.roomId);
    const me = room && room.members.get(ws.session.userId);
    if (!me) return;

    switch (msg.type) {
      case 'update':
        return handleUpdate(ws, msg);
      case 'resync':
        return sendSync(ws, room);
      case 'leave':
        ws.session = null;
        removeMember(room, me.userId, 'left');
        return ws.close();
      case 'lock':
        if (room.hostId !== me.userId) return;
        room.locked = Boolean(msg.locked);
        logActivity(room, 'host', `${me.name} ${room.locked ? 'locked' : 'unlocked'} the editor`);
        return broadcast(room, membersPayload(room));
      case 'kick': {
        if (room.hostId !== me.userId || msg.userId === me.userId) return;
        const target = room.members.get(msg.userId);
        if (!target) return;
        if (target.ws) {
          target.ws.session = null;
          send(target.ws, { type: 'kicked' });
          target.ws.close();
        }
        return removeMember(room, target.userId, 'removed by host');
      }
      default:
    }
  }

  // ---------- socket wiring ----------
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.session = null;
    ws.failedJoins = 0;
    ws.updateTimes = [];
    ws.lastThrottleNotice = 0;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      try { handleMessage(ws, msg); } catch (err) { console.error('Handler error:', err); }
    });
    ws.on('close', () => onClose(ws));
    ws.on('error', () => {}); // errors are followed by 'close', which cleans up
  });

  // Heartbeat: detects dead connections (e.g. laptop lid closed, Wi-Fi gone).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({
        port: server.address().port,
        close() {
          clearInterval(heartbeat);
          store.saveNow();
          for (const room of store.rooms.values()) {
            for (const m of room.members.values()) clearTimeout(m.graceTimer);
          }
          for (const ws of wss.clients) ws.terminate();
          return new Promise((r) => wss.close(() => server.close(() => r())));
        },
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then((s) => {
    console.log(`CodeSync running at http://localhost:${s.port}`);
    const stop = () => s.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
