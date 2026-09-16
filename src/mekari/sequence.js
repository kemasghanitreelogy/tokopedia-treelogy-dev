import { readDoc, updateDoc } from '../store/index.js';
import { SEQUENCE_MAX } from './manual.js';

/**
 * The one counter behind every manual transaction code.
 *
 * `updateDoc` is a transaction in every backend that matters - WATCH/MULTI/EXEC with
 * retry on Redis, BEGIN IMMEDIATE on SQLite - so two requests reserving at the same
 * instant get two different numbers; the loser of the race simply retries and takes the
 * next one. The counter is never reset and never derived from a date or a clock, and a
 * number once handed out is never handed out again, even if the form it was shown on is
 * abandoned. Gaps are fine; a repeat never is.
 */
export const SEQUENCE_DOC = 'mekari/manual-sequence.json';

/** @returns {Promise<number>} a sequence number nobody else has been given. */
export async function reserveManualSequence() {
  const doc = await updateDoc(
    SEQUENCE_DOC,
    (current) => {
      const next = (current?.next ?? 1);
      if (next > SEQUENCE_MAX) throw new Error('nomor urut transaksi manual habis');
      return { next: next + 1, issuedAt: new Date().toISOString() };
    },
    { next: 1 },
  );
  return doc.next - 1;
}

export async function peekManualSequence() {
  return (await readDoc(SEQUENCE_DOC))?.next ?? 1;
}
