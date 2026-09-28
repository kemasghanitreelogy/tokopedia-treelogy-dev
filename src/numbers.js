/**
 * The number that was actually there, or null.
 *
 * `Number()` lies about empty things: null, undefined and '' all come back as 0, and 0 is
 * never the harmless reading. It has cost twice in one afternoon.
 *
 * In the Jurnal budget, an unentered allowance read as "none left" and refused every
 * invoice - the exact failure the comment above it warned against. In the stock top-up it
 * was worse: a channel answering without a quantity looked like a listing that had sold
 * out, and would have been written back up to a hundred on the strength of nothing.
 *
 * "Unknown" is not "zero", and the difference is worth a named function.
 */
export function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
