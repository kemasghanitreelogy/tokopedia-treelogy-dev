import test from 'node:test';
import assert from 'node:assert/strict';
import { manualOutcome } from '../src/mekari/manual.js';

/**
 * What the operator is told after typing in a sale. postManual answers with five
 * different things and the screen used to celebrate four of them.
 */

const base = { id: 'DW-260924-00001JN', total: 250000 };
const celebrated = (out) => Boolean(out.celebrate);

test('a clean save is the only thing that celebrates', () => {
  const out = manualOutcome({ ...base, status: 'created' });
  assert.equal(out.kind, 'ok');
  assert.equal(out.celebrate, 'Tersimpan di Jurnal');
  assert.equal(out.message, 'DW-260924-00001JN tersimpan di Jurnal senilai Rp250.000');
});

test('a number Jurnal changed behind our back is never called a success', () => {
  // Jurnal accepts the invoice and stores a different amount - shipping silently dropped
  // to zero, for one. The invoice exists and it is wrong, and the popup used to say
  // "Tersimpan di Jurnal" beside the amount we had meant to send.
  const out = manualOutcome({
    ...base, status: 'mismatch',
    error: 'Jurnal menyimpan Rp200.000, seharusnya Rp250.000 (faktur INV-12)',
  });
  assert.equal(out.kind, 'error');
  assert.equal(celebrated(out), false);
  assert.match(out.message, /Jurnal menyimpan Rp200\.000/);
  assert.match(out.message, /seharusnya Rp250\.000/);
  assert.match(out.message, /INV-12/, 'faktur yang harus dilihat ikut disebut');
});

test('in the books but not in the list says both halves', () => {
  // "tersimpan" on its own is what sends somebody looking for a sale that is not there.
  const out = manualOutcome({ ...base, status: 'created', listed: false, listError: 'kolom total menolak angka' });
  assert.equal(out.kind, 'error');
  assert.equal(celebrated(out), false);
  assert.match(out.message, /masuk Jurnal senilai Rp250\.000/);
  assert.match(out.message, /belum masuk daftar pesanan: kolom total menolak angka/);
});

test('an invoice that was already there is fine, and says so quietly', () => {
  const out = manualOutcome({ ...base, status: 'exists' });
  assert.equal(out.kind, 'ok');
  assert.equal(celebrated(out), false, 'idempotensi bekerja, bukan sesuatu untuk dirayakan');
  assert.match(out.message, /sudah ada di Jurnal/);
});

test('a status this code has never been taught is not guessed at', () => {
  // dry-run reaches here if the live flag is ever mis-wired, and a future Jurnal status
  // reaches here by existing. Either way, claiming it was saved would be inventing.
  for (const status of ['dry-run', 'needs_review', '', undefined]) {
    const out = manualOutcome({ ...base, status });
    assert.equal(out.kind, 'error', String(status));
    assert.equal(celebrated(out), false, String(status));
    assert.match(out.message, /belum tentu tersimpan/);
  }
});

test('nothing celebrates unless the money really is in the books and on the list', () => {
  const every = ['created', 'exists', 'mismatch', 'dry-run', 'aneh'];
  const celebrations = every
    .flatMap((status) => [true, false].map((listed) => manualOutcome({ ...base, status, listed, listError: 'x' })))
    .filter(celebrated);
  assert.equal(celebrations.length, 1, 'tepat satu kombinasi yang boleh merayakan');
  assert.equal(celebrations[0].message, 'DW-260924-00001JN tersimpan di Jurnal senilai Rp250.000');
});
