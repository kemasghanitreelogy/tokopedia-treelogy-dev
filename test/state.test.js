import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, verifyState } from '../src/state.js';

const SECRET = 'app_secret_for_tests';

test('a freshly created state verifies and returns its nonce', () => {
  const { state, nonce } = createState(SECRET);
  const result = verifyState(SECRET, state);
  assert.equal(result.valid, true);
  assert.equal(result.nonce, nonce);
});

test('every state carries a distinct nonce', () => {
  const a = createState(SECRET);
  const b = createState(SECRET);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.state, b.state);
});

test('a state signed with another secret is rejected', () => {
  const { state } = createState('a-different-secret');
  const result = verifyState(SECRET, state);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature mismatch');
});

test('tampering with the payload invalidates the signature', () => {
  const { state } = createState(SECRET);
  const [payload, mac] = [state.slice(0, state.lastIndexOf('.')), state.slice(state.lastIndexOf('.') + 1)];
  const forged = `${Buffer.from('deadbeef.9999999999').toString('base64url')}.${mac}`;
  assert.notEqual(forged, `${payload}.${mac}`);
  assert.equal(verifyState(SECRET, forged).valid, false);
});

test('an expired state is rejected even though the signature is good', () => {
  const { state } = createState(SECRET, -1);
  const result = verifyState(SECRET, state);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'state expired');
});

test('malformed input is rejected without throwing', () => {
  for (const input of ['', 'no-dots', undefined, null, 42]) {
    assert.equal(verifyState(SECRET, input).valid, false);
  }
});
