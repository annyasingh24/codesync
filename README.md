# CodeSync - Real-Time Collaborative Workspace

Students join **persistent virtual rooms**, edit code or technical notes **at the same time**, see who is online, and watch a **live activity feed** - without text getting scrambled or the page freezing.

Built for the AWS Builder Student Group, VIT Vellore.

> Tech used: **Node.js** (server), **WebSockets** (live connection, via the `ws` package), plain **HTML/CSS/JavaScript** (browser). No frameworks, no database - just one dependency.

---

## 1. Features

| Requirement | How it is done | File |
|---|---|---|
| Split layout: editor + participant list + activity feed | Editor on the left, participants and audit feed on the right | `public/index.html`, `style.css` |
| Custom room IDs + optional passcode | **Create room** / **Join room**; the passcode is checked on the server *before* the person is let in | `server.js` (`handleJoin`) |
| Passcodes stored safely | Salted `scrypt` hash, never plain text | `rooms.js` |
| Persistent rooms | Room text and passcode hash are saved to `data/rooms.json` and reloaded on restart | `rooms.js` |
| Real-time sync of insertions and deletions | Every edit is a tiny instruction (an "atom"); the server orders them and fixes late ones so **nothing collides** | `public/ot.js`, `server.js` |
| Cursor positions + line highlights | Each person's cursor is shown as a coloured caret with a name tag, and their line is highlighted | `public/app.js` (`renderMirror`) |
| Typing / presence badges | `host`, `typing...`, `reconnecting...` badges next to each name | `public/app.js` |
| Spam throttling (>5 updates/sec) | Server counts each connection's updates in the last second and drops extras | `server.js` (`allowUpdate`) |
| Host role + automatic transfer | Creator is host; if the host leaves, the **oldest** remaining member becomes host | `server.js` (`removeMember`) |
| Abrupt disconnects + smooth reconnect | Heartbeat detects dead connections; browser reconnects automatically; a few seconds of grace keep your spot | `server.js`, `app.js` |
| No UI freezing | Typing is sent in batches (about 3 per second) and drawing is batched with `requestAnimationFrame` | `public/app.js` |

Extra host powers: **Remove** a participant and **Lock editor** (read-only for everyone except the host).

---

## 2. Requirements

* **Node.js 18 or newer** - check with `node --version`. Download from <https://nodejs.org> if needed.
* A modern browser (Chrome, Edge, Firefox).

---

## 3. Install and run (step by step)

```bash
# 1. Get the code
git clone https://github.com/<your-username>/codesync.git
cd codesync

# 2. Install the one dependency (ws)
npm install

# 3. (Optional) change settings
cp .env.example .env        # on Windows PowerShell: copy .env.example .env

# 4. Start the server
npm start
```

You should see: `CodeSync running at http://localhost:3000`

Open <http://localhost:3000> in your browser.

### Try it with two people on one computer

1. In one browser window: enter a name, room ID `demo`, passcode `1234` -> click **Create room**. You are the **host**.
2. Open a **second window** (or an incognito window) -> a different name, room ID `demo`, passcode `1234` -> click **Join room**.
3. Type in both windows at the same time. Both screens stay identical.
4. Try joining with a **wrong passcode** -> you are refused.
5. Click **Spam test** -> a warning appears and the activity feed records the throttling.
6. Close the host's window -> after about 5 seconds the other person becomes the host (see the activity feed).
7. Stop the server (Ctrl+C), start it again, join `demo` again -> the text is still there.

### Let friends on the same Wi-Fi join
Find your computer's IP address (for example `192.168.1.5`) and share `http://192.168.1.5:3000`.

---

## 4. Settings (`.env`)

| Name | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port of the website |
| `GRACE_MS` | `5000` | Time the server waits for a dropped person to come back before removing them / moving the host role. `0` = instant |
| `MAX_UPDATES_PER_SEC` | `5` | Throttle limit per connection |
| `DATA_FILE` | `data/rooms.json` | Where rooms are saved |

---

## 5. Run the tests

```bash
npm test
```

* `test/ot.test.js` - 10,000 random "two people type at once" cases; both sides must end with identical text.
* `test/server.test.js` - starts the real server and connects real WebSocket clients: wrong passcode refused, 3 people typing at once end identical, spam throttled, host transfer on abrupt disconnect, reconnect, persistence after restart.

---

## 6. Project structure

```
codesync/
├── server.js            # the "referee": WebSocket server, rooms, throttling, host logic
├── rooms.js             # stores rooms in memory + saves them to data/rooms.json, passcode hashing
├── package.json
├── .env.example
├── public/              # everything the browser downloads
│   ├── index.html       # the page layout
│   ├── style.css        # looks
│   ├── app.js           # browser logic: connection, editor, participant list, activity feed
│   ├── syncclient.js    # browser-side bookkeeping of edits (no HTML inside)
│   └── ot.js            # the merge engine (shared by server AND browser)
├── test/
└── docs/EXPLAIN.md      # plain-English walkthrough + viva questions
```

---

## 7. How it works (plain English)

**The big problem - collisions.** If Alice types at the start of the line while Bob types at the end, a message like "insert X at position 10" can land in the wrong place, because Alice's typing already pushed everything right.

**The solution.**

1. Every edit is converted to tiny instructions: *insert this text at position N* or *delete N characters at position N* (`ot.js`).
2. The browser sends its instructions to the server together with the **version** of the document it was looking at.
3. The server is the single referee. If other edits were accepted since that version, it **adjusts the positions** of the new edit to account for them, applies it, bumps the version, and broadcasts it to everyone.
4. Each browser does the same adjustment for edits arriving from others (`syncclient.js`), so everybody ends up with the same text. This technique is called **Operational Transform** (the idea behind early Google Docs).

**No UI freezing.** Typing is not sent letter by letter. The browser sends one small batch about every 300 ms, and only one batch is "in flight" at a time; anything typed meanwhile waits for the next batch.

**Throttling.** The server remembers the timestamps of each connection's last updates. A 6th update inside one second is dropped, the person's editor snaps back to the room's real text, and the activity feed logs it.

**Host.** The creator is host. When a host's connection stays lost longer than `GRACE_MS` (or they click Leave), the oldest remaining online member gets the host badge.

**Disconnects.** The server pings every connection every 15 seconds; no reply -> connection closed. The browser notices a closed socket, becomes read-only, retries (0.5 s, 1 s, 2 s... up to 5 s) and re-joins with the stored room ID and passcode, then receives the latest text.

More detail and likely viva questions: [`docs/EXPLAIN.md`](docs/EXPLAIN.md).

---

## 8. Message protocol (for reference)

Browser -> server

| `type` | Meaning |
|---|---|
| `join` | `{mode: "create" or "join", roomId, passcode, name, userId}` |
| `update` | `{baseVersion, ops: [...], cursor: {start, end}}` (ops may be empty for cursor-only updates) |
| `lock`, `kick`, `leave`, `resync` | Host controls, leaving, asking for the latest text |

Server -> browser

| `type` | Meaning |
|---|---|
| `joined` / `join_error` | Result of joining (with the full text on success) |
| `op` | An accepted edit `{userId, version, ops}` (also the confirmation for the sender) |
| `cursor` | Someone moved their cursor |
| `members` | Participant list, who is host, whether locked |
| `activity` | New audit-feed line |
| `sync` | "Here is the real text, reset yourself" |
| `throttled`, `kicked`, `replaced` | Notices |

---

## 9. Known limitations (honest list)

* Passcodes travel in plain text over `ws://`. For a real deployment put the server behind HTTPS (`wss://`).
* Remote edits replace the textarea contents, so the browser's own Undo (Ctrl+Z) history is reset when someone else edits.
* Cursor positions of others can be off by a character for a split second while edits are in flight; they correct themselves on the next update.
* Rooms are never deleted automatically, and there is a 200,000-character limit per document.
* Remote *selections* (highlighted ranges) are not drawn, only carets and highlighted lines.

---

## 10. Publishing to GitHub

```bash
git init
git add .
git commit -m "CodeSync: real-time collaborative workspace"
git branch -M main
git remote add origin https://github.com/<your-username>/codesync.git
git push -u origin main
```

Create the empty **public** repository on github.com first (do not tick "add README"), then run the commands above.

## License
MIT
