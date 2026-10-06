// Integration tests: start the REAL server and connect REAL websocket clients.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { start } = require('../server');
const SyncClient = require('../public/syncclient.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codesync-')), 'rooms.json');
let idCounter = 0;
const newId = () => 'test-user-' + String(++idCounter).padStart(4, '0');

// A little fake "browser tab": a websocket plus the same SyncClient the real UI uses.
class Peer {
  constructor(port, name) {
    this.name = name;
    this.userId = newId();
    this.sc = new SyncClient(this.userId);
    this.msgs = [];
    this.hostId = null;
    this.members = [];
    this.ws = new WebSocket('ws://localhost:' + port);
    this.ready = new Promise((r) => this.ws.on('open', r));
    this.ws.on('message', (d) => this.onMessage(JSON.parse(d.toString())));
  }
  onMessage(m) {
    this.msgs.push(m);
    if (m.type === 'joined') this.sc.reset(m.text, m.version);
    if (m.type === 'sync') this.sc.reset(m.text, m.version);
    if (m.type === 'members' || m.type === 'joined') { this.hostId = m.hostId; this.members = m.members; }
    if (m.type === 'op') {
      const r = this.sc.receive(m);
      if (r.gap) this.send({ type: 'resync' });
    }
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async join(mode, roomId, passcode) {
    await this.ready;
    this.send({ type: 'join', mode, roomId, passcode, name: this.name, userId: this.userId });
    return this.waitFor((m) => m.type === 'joined' || m.type === 'join_error');
  }
  async waitFor(pred, ms = 2000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const found = this.msgs.find(pred);
      if (found) return found;
      await sleep(10);
    }
    return null;
  }
  flush() {
    const upd = this.sc.nextUpdate();
    if (upd) this.send({ type: 'update', baseVersion: upd.baseVersion, ops: upd.ops, cursor: { start: 0, end: 0 } });
  }
  type(rnd) { // make a random edit like a user typing
    const t = this.sc.text;
    const pos = Math.floor(rnd() * (t.length + 1));
    const del = rnd() < 0.3 ? Math.floor(rnd() * Math.min(3, t.length - pos + 1)) : 0;
    const ins = rnd() < 0.8 ? 'abcdefgh'[Math.floor(rnd() * 8)] : '';
    this.sc.setText(t.slice(0, pos) + ins + t.slice(pos + del));
  }
  close() { this.ws.terminate(); }
}

test('passcode is checked before admitting; wrong passcode is refused', async () => {
  const s = await start({ port: 0, dataFile: tmpFile(), graceMs: 100 });
  const a = new Peer(s.port, 'Asha');
  const b = new Peer(s.port, 'Bala');
  const c = new Peer(s.port, 'Chitra');
  assert.strictEqual((await a.join('create', 'secret-room', 'pw123')).type, 'joined');
  const bad = await b.join('join', 'secret-room', 'wrong');
  assert.strictEqual(bad.type, 'join_error');
  assert.ok(!a.msgs.some((m) => m.type === 'members' && m.members.length > 1), 'refused user must not appear');
  assert.strictEqual((await c.join('join', 'secret-room', 'pw123')).type, 'joined');
  const dup = await new Peer(s.port, 'Dup').join('create', 'secret-room', '');
  assert.strictEqual(dup.type, 'join_error');
  [a, b, c].forEach((p) => p.close());
  await s.close();
});

test('three people typing at once never lose or scramble text (all copies identical)', async () => {
  const s = await start({ port: 0, dataFile: tmpFile(), graceMs: 100, maxUpdates: 1000 });
  const peers = [new Peer(s.port, 'A'), new Peer(s.port, 'B'), new Peer(s.port, 'C')];
  await peers[0].join('create', 'busy-room', '');
  await peers[1].join('join', 'busy-room', '');
  await peers[2].join('join', 'busy-room', '');

  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let round = 0; round < 300; round++) {
    for (const p of peers) { if (rnd() < 0.6) p.type(rnd); if (rnd() < 0.5) p.flush(); }
    await sleep(rnd() < 0.3 ? 5 : 0);
  }
  // let everything settle: keep flushing until nothing is waiting
  for (let i = 0; i < 100; i++) { peers.forEach((p) => p.flush()); await sleep(20); }
  await sleep(200);

  const texts = peers.map((p) => p.sc.text);
  assert.ok(texts[0].length > 0, 'something was typed');
  assert.strictEqual(texts[1], texts[0]);
  assert.strictEqual(texts[2], texts[0]);
  peers.forEach((p) => p.close());
  await s.close();
});

test('spam is throttled (more than 5 updates/second are dropped)', async () => {
  const s = await start({ port: 0, dataFile: tmpFile(), graceMs: 100, maxUpdates: 5 });
  const a = new Peer(s.port, 'Spammer');
  const b = new Peer(s.port, 'Watcher');
  await a.join('create', 'spam-room', '');
  await b.join('join', 'spam-room', '');
  for (let i = 0; i < 30; i++) a.send({ type: 'update', baseVersion: 0, ops: [], cursor: { start: i, end: i } });
  await sleep(300);
  assert.ok(a.msgs.some((m) => m.type === 'throttled'), 'spammer is warned');
  const cursorsSeen = b.msgs.filter((m) => m.type === 'cursor').length;
  assert.ok(cursorsSeen <= 5, `only 5 should be broadcast, got ${cursorsSeen}`);
  assert.ok(b.msgs.some((m) => m.type === 'activity' && /too fast/.test(m.entry.text)), 'audit feed records it');
  a.close(); b.close();
  await s.close();
});

test('host leaves -> oldest remaining member becomes host; reconnect keeps host', async () => {
  const s = await start({ port: 0, dataFile: tmpFile(), graceMs: 150 });
  const a = new Peer(s.port, 'Host');
  const b = new Peer(s.port, 'Second');
  const c = new Peer(s.port, 'Third');
  await a.join('create', 'host-room', '');
  await sleep(5);
  await b.join('join', 'host-room', '');
  await sleep(5);
  await c.join('join', 'host-room', '');
  assert.strictEqual(c.hostId, a.userId);

  // Abrupt disconnect (no goodbye message) -> host transfers after the grace period
  a.close();
  await sleep(500);
  assert.strictEqual(b.hostId, b.userId, 'oldest active member (Second) becomes host');
  assert.strictEqual(c.hostId, b.userId);
  assert.ok(c.msgs.some((m) => m.type === 'activity' && /now the host/.test(m.entry.text)));

  // Brief drop of a non-host: reconnect within grace, nothing is lost
  c.close();
  const c2 = new Peer(s.port, 'Third');
  c2.userId = c.userId;
  c2.sc = new SyncClient(c.userId);
  await sleep(30);
  const rejoined = await c2.join('join', 'host-room', '');
  assert.strictEqual(rejoined.type, 'joined');
  await sleep(300);
  assert.ok(b.members.some((m) => m.userId === c.userId && m.online), 'reconnected user is online again');
  b.close(); c2.close();
  await s.close();
});

test('rooms persist: text survives a server restart', async () => {
  const file = tmpFile();
  let s = await start({ port: 0, dataFile: file, graceMs: 100 });
  const a = new Peer(s.port, 'A');
  await a.join('create', 'keep-me', 'pw');
  a.sc.setText('hello persistent world');
  a.flush();
  await sleep(100);
  a.close();
  await s.close(); // saves to disk

  s = await start({ port: 0, dataFile: file, graceMs: 100 });
  const b = new Peer(s.port, 'B');
  assert.strictEqual((await b.join('join', 'keep-me', 'nope')).type, 'join_error');
  const ok = await new Peer(s.port, 'B2').join('join', 'keep-me', 'pw');
  assert.strictEqual(ok.text, 'hello persistent world');
  b.close();
  await s.close();
});
