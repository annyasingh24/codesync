// rooms.js  -  keeps all rooms in memory and saves them to a JSON file,
// so rooms are "persistent" (they survive a server restart).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class RoomStore {
  constructor(file) {
    this.file = file;
    this.rooms = new Map(); // roomId -> room object
    this.saveTimer = null;
    this.load();
  }

  // Build the in-memory room object. Only id/passcode/text are saved to disk;
  // everything else (members, history...) only exists while the server runs.
  makeRoom(id, salt, hash, text, createdAt) {
    return {
      id, salt, hash, text, createdAt,
      version: 0,       // goes up by 1 after every accepted edit
      histBase: 0,      // version number of the oldest edit still in `history`
      history: [],      // list of accepted edits (needed to fix late edits)
      members: new Map(), // userId -> member
      hostId: null,
      locked: false,
      activity: [],     // audit feed (last 100 events)
    };
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const r of saved) {
        this.rooms.set(r.id, this.makeRoom(r.id, r.salt, r.hash, r.text || '', r.createdAt || Date.now()));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Could not read rooms file:', err.message);
    }
  }

  get(id) {
    return this.rooms.get(id);
  }

  // Passcodes are NEVER stored directly. We store a salted "scrypt" hash.
  hashPass(passcode, salt) {
    return crypto.scryptSync(passcode, salt, 32).toString('hex');
  }

  create(id, passcode) {
    let salt = null;
    let hash = null;
    if (passcode) {
      salt = crypto.randomBytes(16).toString('hex');
      hash = this.hashPass(passcode, salt);
    }
    const room = this.makeRoom(id, salt, hash, '', Date.now());
    this.rooms.set(id, room);
    this.scheduleSave();
    return room;
  }

  checkPass(room, passcode) {
    if (!room.hash) return true; // room has no passcode
    const attempt = Buffer.from(this.hashPass(passcode || '', room.salt), 'hex');
    const real = Buffer.from(room.hash, 'hex');
    return attempt.length === real.length && crypto.timingSafeEqual(attempt, real);
  }

  // Save at most once per second, no matter how many edits happen.
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1000);
  }

  saveNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const list = [...this.rooms.values()].map((r) => ({
        id: r.id, salt: r.salt, hash: r.hash, text: r.text, createdAt: r.createdAt,
      }));
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(list));
      fs.renameSync(tmp, this.file); // rename = never leaves a half-written file
    } catch (err) {
      console.error('Could not save rooms:', err.message);
    }
  }
}

module.exports = { RoomStore };
