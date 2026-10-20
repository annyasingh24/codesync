# Understanding CodeSync (for beginners)

Read this once before your demo or viva. Every concept is explained in plain words.

## 1. The 6 words you must know

| Word | Meaning | Real-life example |
|---|---|---|
| **Server** | A program that keeps running and answers many users | A teacher collecting everyone's answers |
| **Client** | The browser tab of one user | One student |
| **HTTP** | Ask once, get one answer, connection ends | Sending a letter |
| **WebSocket** | A connection that stays open so both sides can talk any time | A phone call |
| **Broadcast** | Server sends one message to everyone in the room | Teacher announcing to the class |
| **Version** | A counter of how many edits the document has had | Page edit number |

Why WebSocket? With normal HTTP the browser would have to keep asking "anything new?" again and again. With a WebSocket the server pushes changes the moment they happen.

## 2. What happens when you type one letter

1. You type `a` in the browser.
2. `app.js` notices the change (`input` event) and waits up to 300 ms to batch typing.
3. `syncclient.js` compares the old text and new text (`diff` in `ot.js`) -> *"insert 'a' at position 7"*.
4. The browser sends: `{type:'update', baseVersion: 12, ops:[insert a at 7]}`.
5. `server.js` receives it. If other people's edits were accepted after version 12, it **adjusts position 7** for them.
6. The server applies it to the real text, makes it version 13, and sends it to **everybody** (including you, which tells you "confirmed").
7. Other browsers apply it (adjusting again for what they typed themselves) and redraw.

## 3. The collision problem, with numbers

Text: `abc`. Alice inserts `X` at position 0. Bob, at the same moment, inserts `Y` at position 3 (the end).

* Server accepts Alice first: text becomes `Xabc`.
* Bob's instruction still says "position 3" -> that would put `Y` between `b` and `c` (`XabYc`). **Wrong!**
* The server sees Alice's edit came first and inserted 1 character before position 3, so it moves Bob's position to 4 -> `XabcY`. **Correct.**

That adjusting step is called **transform** (function `xform` in `ot.js`). The whole idea is called **Operational Transform (OT)**.

Other cases handled: both delete the same characters (delete only once), one inserts inside text the other deleted (keep the inserted text), two inserts at exactly the same position (a fixed rule decides who goes first so everyone agrees).

**How do we know it works?** `test/ot.test.js` tries 10,000 random pairs of simultaneous edits and checks both orders give the same text.

## 4. Why the server is the "referee"

If every browser decided by itself, they could disagree. So there is one official copy of the text (on the server) and one official order of edits (version numbers). Browsers only *adjust their screen* to match.

## 5. Rooms and passcodes

* A room = an ID + optional passcode + its text. Saved in `data/rooms.json` -> **persistent**.
* Passcode is never stored directly. We store a **hash** (a one-way scrambled version, with a random "salt") using `scrypt`. To check a passcode we scramble the attempt the same way and compare.
* The check happens inside `handleJoin` **before** the user is added to the room's member list, so a wrong passcode never receives any text and never appears in the participant list.
* After 5 wrong tries on one connection, the server disconnects it.

## 6. Throttling (anti-spam)

`allowUpdate()` in `server.js` keeps a list of the times of the last updates of a connection. If there are already 5 in the last second, the new one is thrown away. If it contained an edit, the sender's editor is reset to the real text (so the spammer cannot corrupt anyone). The activity feed records "X is sending updates too fast".

Normal typing is safe: the browser sends at most about 3 updates per second.

## 7. Host and automatic transfer

* The person who **creates** the room is the host.
* When a person's connection closes, they are first marked `reconnecting...`. If they do not return within `GRACE_MS` (5 s) they are removed.
* On removal, if they were the host, `removeMember` picks the online member with the smallest `joinedAt` time (the **oldest**) and makes them host, and writes it to the activity feed.
* The grace period means a quick page refresh does not cost you the host role.

## 8. Disconnects and reconnecting

* **Server side:** every 15 s it sends a *ping*. A connection that did not answer the previous ping is terminated (this catches closed laptops and dead Wi-Fi, where the browser never says goodbye).
* **Browser side:** when the socket closes, the editor becomes read-only, the badge shows `reconnecting`, and it retries after 0.5 s, 1 s, 2 s... up to 5 s. When it gets in, the server sends the newest text.
* A page refresh rejoins automatically because room details are kept in `sessionStorage` (per tab).

## 9. Cursor and line highlights - the trick

A `<textarea>` cannot draw other people's cursors. So there are **two layers on top of each other**:

* Back layer: an invisible `div` (the *mirror*) containing the same text in the same font. Here we colour the lines and draw coloured carets.
* Front layer: the real `textarea` with a transparent background.

Because both use identical font and spacing, the coloured carets line up exactly with the characters.

## 10. Why it does not freeze

* Typing is sent in small batches, not per key.
* Only one batch waits for confirmation at a time.
* Drawing the mirror happens at most once per screen refresh (`requestAnimationFrame`).
* The server never does heavy work: a few string operations per edit.


3. Open port 3000 in the instance's security group.
4. Visit `http://<public-ip>:3000`.
