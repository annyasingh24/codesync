// syncclient.js  -  the browser-side "bookkeeper" for edits (no HTML in here).
//
// It remembers three things:
//   version  : which version of the document the server told us about
//   inflight : edits we sent to the server that are not confirmed yet
//   sentText : the text as the server will have it once our inflight edit lands
//   text     : what the user currently sees in the editor
//
// Rule: only ONE batch of edits is "in flight" at a time. Anything typed
// meanwhile just waits (it is the difference between sentText and text) and
// is sent right after the server confirms (acknowledges) the first batch.
// This keeps things simple and safe.

(function (root) {
  'use strict';
  const OT = typeof require !== 'undefined' && typeof module !== 'undefined' ? require('./ot.js') : root.OT;

  class SyncClient {
    constructor(userId) {
      this.userId = userId;
      this.reset('', 0);
    }

    // Start fresh from what the server says is the truth.
    reset(text, version) {
      this.text = text;
      this.sentText = text;
      this.version = version;
      this.inflight = null;
    }

    // The user typed something: remember the new text.
    setText(text) {
      this.text = text;
    }

    // Is there something new to send? If yes, returns {baseVersion, ops}.
    nextUpdate() {
      if (this.inflight) return null; // wait for the server to confirm first
      const ops = OT.diff(this.sentText, this.text);
      if (!ops.length) return null;
      this.inflight = ops;
      this.sentText = this.text;
      return { baseVersion: this.version, ops };
    }

    hasUnsent() {
      return !this.inflight && this.text !== this.sentText;
    }

    // The server broadcast an edit {userId, version, ops}.
    // Returns:
    //   {gap:true}       we missed a message -> ask the server to resync
    //   {ack:true}       this was OUR edit being confirmed
    //   {atoms:[...]}    someone else's edit, already adjusted to fit our
    //                    current text (this.text is updated for you)
    receive(msg) {
      if (msg.version !== this.version + 1) return { gap: true };
      this.version = msg.version;

      if (msg.userId === this.userId) {
        this.inflight = null;
        return { ack: true };
      }

      let remote = msg.ops;
      // 1) adjust the remote edit for our in-flight edit
      if (this.inflight) {
        const r = OT.xform(remote, this.inflight, true);
        remote = r[0];
        this.inflight = r[1];
      }
      // 2) adjust it for what we typed but have not sent yet
      const unsent = OT.diff(this.sentText, this.text);
      const forLocal = OT.xform(remote, unsent, true)[0];

      this.sentText = OT.apply(this.sentText, remote);
      this.text = OT.apply(this.text, forLocal);
      return { atoms: forLocal };
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = SyncClient;
  else root.SyncClient = SyncClient;
})(typeof self !== 'undefined' ? self : this);
