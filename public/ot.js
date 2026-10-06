// ot.js  -  the "merge engine" (used by BOTH the server and the browser).
//
// PROBLEM: two people type at the same moment. If we just send "put text at
// position 5", the other person's edit may have already moved things around,
// so the text ends up in the wrong place (a "collision").
//
// SOLUTION ("Operational Transform", OT): every edit is described as a tiny
// instruction called an ATOM, and before applying someone else's atom we
// "transform" (adjust) its position to account for edits that happened before it.
//
// There are only two kinds of atoms:
//   { t: 'ins', pos: 5, text: 'hi' }   -> insert "hi" at position 5
//   { t: 'del', pos: 5, len: 2 }       -> delete 2 characters starting at position 5
//
// Example: the text is "abc". Alice inserts "X" at 0 and Bob (at the same
// time) inserts "Y" at 3. Bob's position 3 must become 4 after Alice's "X"
// is applied. That adjustment is what xform() does.

(function (root) {
  'use strict';

  // Apply a list of atoms (one after another) to a string.
  function apply(text, atoms) {
    for (const a of atoms) {
      if (a.t === 'ins') text = text.slice(0, a.pos) + a.text + text.slice(a.pos);
      else text = text.slice(0, a.pos) + text.slice(a.pos + a.len);
    }
    return text;
  }

  // Compare old text and new text and describe the change as atoms.
  // Trick: skip the identical beginning and identical ending; whatever is in
  // the middle was deleted and/or inserted.
  function diff(oldT, newT) {
    let start = 0;
    const max = Math.min(oldT.length, newT.length);
    while (start < max && oldT[start] === newT[start]) start++;
    let endOld = oldT.length;
    let endNew = newT.length;
    while (endOld > start && endNew > start && oldT[endOld - 1] === newT[endNew - 1]) {
      endOld--;
      endNew--;
    }
    const atoms = [];
    if (endOld > start) atoms.push({ t: 'del', pos: start, len: endOld - start });
    if (endNew > start) atoms.push({ t: 'ins', pos: start, text: newT.slice(start, endNew) });
    return atoms;
  }

  // ---- Rules for adjusting two atoms that happened at the same time ----
  // Each helper returns [a-after-b, b-after-a] (both are LISTS, because
  // sometimes an atom has to be split in two).

  // insert vs insert
  function insVsIns(a, b, aWins) {
    // If both insert at the same spot, "aWins" decides who goes first.
    if (a.pos < b.pos || (a.pos === b.pos && aWins)) {
      return [[a], [{ t: 'ins', pos: b.pos + a.text.length, text: b.text }]];
    }
    return [[{ t: 'ins', pos: a.pos + b.text.length, text: a.text }], [b]];
  }

  // insert (a) vs delete (b)
  function insVsDel(a, b) {
    const bEnd = b.pos + b.len;
    if (a.pos <= b.pos) {
      // insert is before the deleted part -> delete just shifts right
      return [[a], [{ t: 'del', pos: b.pos + a.text.length, len: b.len }]];
    }
    if (a.pos >= bEnd) {
      // insert is after the deleted part -> insert shifts left
      return [[{ t: 'ins', pos: a.pos - b.len, text: a.text }], [b]];
    }
    // insert landed INSIDE the deleted part: keep the new text, delete the
    // old characters on both sides of it (so the delete is split in two).
    const left = a.pos - b.pos;
    return [
      [{ t: 'ins', pos: b.pos, text: a.text }],
      [
        { t: 'del', pos: b.pos, len: left },
        { t: 'del', pos: b.pos + a.text.length, len: b.len - left },
      ],
    ];
  }

  // "a" (a delete) after "b" (another delete) already happened.
  function delAfterDel(a, b) {
    const a1 = a.pos, a2 = a.pos + a.len;
    const b1 = b.pos, b2 = b.pos + b.len;
    if (a2 <= b1) return [a];                                       // completely before
    if (a1 >= b2) return [{ t: 'del', pos: a1 - b.len, len: a.len }]; // completely after
    const overlap = Math.min(a2, b2) - Math.max(a1, b1);            // both deleted the same chars
    const len = a.len - overlap;
    if (len === 0) return [];
    return [{ t: 'del', pos: Math.min(a1, b1), len }];
  }

  function xformPair(a, b, aWins) {
    if (a.t === 'ins' && b.t === 'ins') return insVsIns(a, b, aWins);
    if (a.t === 'ins' && b.t === 'del') return insVsDel(a, b);
    if (a.t === 'del' && b.t === 'ins') {
      const r = insVsDel(b, a);
      return [r[1], r[0]];
    }
    return [delAfterDel(a, b), delAfterDel(b, a)];
  }

  // Transform two LISTS of atoms that both started from the same text.
  // Returns [A', B'] where:
  //   A' = A adjusted so it can be applied after B
  //   B' = B adjusted so it can be applied after A
  // Guarantee: apply(apply(t, A), B') === apply(apply(t, B), A')
  function xform(A, B, aWins) {
    if (!A.length || !B.length) return [A, B];
    if (A.length === 1 && B.length === 1) return xformPair(A[0], B[0], aWins);
    if (A.length > 1) {
      const r1 = xform([A[0]], B, aWins);
      const r2 = xform(A.slice(1), r1[1], aWins);
      return [r1[0].concat(r2[0]), r2[1]];
    }
    const r1 = xform(A, [B[0]], aWins);
    const r2 = xform(r1[0], B.slice(1), aWins);
    return [r2[0], r1[1].concat(r2[1])];
  }

  // Where does a cursor at `pos` end up after these atoms are applied?
  function movePos(pos, atoms) {
    for (const a of atoms) {
      if (a.t === 'ins') {
        if (a.pos <= pos) pos += a.text.length;
      } else if (a.pos < pos) {
        pos -= Math.min(a.len, pos - a.pos);
      }
    }
    return pos;
  }

  const OT = { apply, diff, xform, movePos };
  if (typeof module !== 'undefined' && module.exports) module.exports = OT;
  else root.OT = OT;
})(typeof self !== 'undefined' ? self : this);
