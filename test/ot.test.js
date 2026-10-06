// Random ("fuzz") test: two people edit the same text at the same time, many
// thousands of times. After merging, both must end up with IDENTICAL text.
const test = require('node:test');
const assert = require('node:assert');
const OT = require('../public/ot.js');

function rnd(n) { return Math.floor(Math.random() * n); }
function randomText(max) {
  let s = '';
  for (let i = rnd(max + 1); i > 0; i--) s += 'abcde'[rnd(5)];
  return s;
}
function randomEdit(doc) {
  const pos = rnd(doc.length + 1);
  const del = rnd(Math.min(4, doc.length - pos) + 1);
  const ins = rnd(2) ? randomText(3) : '';
  return doc.slice(0, pos) + ins + doc.slice(pos + del);
}

test('two simultaneous edits always converge (10000 random cases)', () => {
  for (let i = 0; i < 10000; i++) {
    const doc = randomText(12);
    const A = OT.diff(doc, randomEdit(doc));
    const B = OT.diff(doc, randomEdit(doc));
    for (const aWins of [true, false]) {
      const [A2, B2] = OT.xform(A, B, aWins);
      const left = OT.apply(OT.apply(doc, A), B2);
      const right = OT.apply(OT.apply(doc, B), A2);
      assert.strictEqual(left, right, `doc=${JSON.stringify(doc)} A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
    }
  }
});

test('diff + apply gives back the new text', () => {
  for (let i = 0; i < 2000; i++) {
    const a = randomText(15), b = randomText(15);
    assert.strictEqual(OT.apply(a, OT.diff(a, b)), b);
  }
});

test('cursor moves correctly', () => {
  assert.strictEqual(OT.movePos(5, [{ t: 'ins', pos: 0, text: 'ab' }]), 7);
  assert.strictEqual(OT.movePos(5, [{ t: 'del', pos: 0, len: 2 }]), 3);
  assert.strictEqual(OT.movePos(5, [{ t: 'ins', pos: 9, text: 'zz' }]), 5);
});
