/**
 * Forgiving, ranked search for the order list.
 *
 * Each order is indexed once per search into its faces - buyer words (as written and as
 * an Indonesian phonetic key), order id and tracking number without separators, phone
 * digits in national form - and every query term is scored against them:
 *
 *   100  the number is the buyer's phone, or the id / tracking contains what was typed
 *    90  a whole word of the buyer's name
 *    80  the start of a word ("widy" -> Widyawati)
 *    70  the same word in another spelling (Widia / Widya, Noor / Nur, Djoko / Joko)
 *  60-d  a typo: d letters wrong, missing, extra or swapped (optimal string alignment,
 *        the tolerance growing with the word: none under 4 letters, 1 to 7, 2 from 8)
 *    55  the phone or a long code one digit off
 *
 * A query of several words is an AND, in any order ("putri widya" finds Widya Putri);
 * an order scores its weakest term. Anything at 80 or above is an exact hit, and when
 * there are exact hits only those are shown, in the list's own order - typing a name
 * right never brings in lookalikes. Only when nothing hits exactly are the near matches
 * returned, best first, and flagged so the page says they are lookalikes.
 */

/** Lowercase, accents gone, anything but letters and digits a single space. */
export const fold = (value) => String(value ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** National digits of a phone number: +62 813..., 62813..., 0813... and 813... alike. */
export const phoneDigits = (value) => String(value ?? '').replace(/\D/g, '').replace(/^(?:62|0)/, '');

/**
 * One word as it sounds in Indonesian, so the spellings a name is commonly written in
 * share a key: the old spelling (dj, tj, sj, oe, ch), y for i, ph and v for f, q for k,
 * a doubled letter as one, and a closing h that is not heard (Fatimah, Sarah).
 */
export function phonetic(word) {
  let w = fold(word).replace(/ /g, '');
  if (!w || /\d/.test(w)) return w;
  w = w.replace(/dj/g, 'j').replace(/tj/g, 'c').replace(/sj/g, 'sy').replace(/ch/g, 'kh')
    .replace(/oe/g, 'u').replace(/oo/g, 'u').replace(/ph/g, 'f').replace(/v/g, 'f').replace(/q/g, 'k')
    .replace(/x/g, 'ks').replace(/y/g, 'i').replace(/ie$/, 'i').replace(/ee/g, 'i')
    .replace(/(.)\1+/g, '$1');
  if (w.length > 3) w = w.replace(/h$/, '');
  return w;
}

/**
 * Optimal-string-alignment distance (Damerau-Levenshtein with adjacent transpositions),
 * abandoned as soon as it must exceed `max`; returns max + 1 for "too far".
 */
export function distance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[n];
}

/** How many typos a word of this length may carry. */
export const allowance = (length) => (length >= 8 ? 2 : length >= 4 ? 1 : 0);

/** The best score one query word earns against the buyer's words. */
function wordScore(term, buyer) {
  let best = 0;
  const max = allowance(term.word.length);
  for (const w of buyer) {
    if (w.word === term.word) return 90;
    if (w.word.startsWith(term.word)) { best = Math.max(best, 80); continue; }
    if (term.key.length >= 3 && (w.key === term.key || w.key.startsWith(term.key))) { best = Math.max(best, 70); continue; }
    if (!max) continue;
    const whole = distance(term.word, w.word, max);
    const start = w.word.length > term.word.length ? distance(term.word, w.word.slice(0, term.word.length), max) : max + 1;
    const d = Math.min(whole, start, distance(term.key, w.key, max));
    if (d <= max) best = Math.max(best, 60 - d);
  }
  return best;
}

/** One slip in a long number: a digit wrong, missing, extra or swapped. */
function digitsNear(query, digits) {
  if (!digits || query.length < 9) return false;
  if (distance(query, digits, 1) <= 1) return true;
  for (let len = query.length - 1; len <= query.length + 1; len++) {
    for (let i = 0; i + len <= digits.length; i++) if (distance(query, digits.slice(i, i + len), 1) <= 1) return true;
  }
  return false;
}

function index(order) {
  const words = fold(order.buyer).split(' ').filter(Boolean);
  return {
    buyer: words.map((word) => ({ word, key: phonetic(word) })),
    codes: [fold(order.id).replace(/ /g, ''), fold(order.tracking).replace(/ /g, '')].filter(Boolean),
    phone: phoneDigits(order.buyerPhone),
    text: fold(`${order.id} ${order.buyer ?? ''} ${order.tracking ?? ''} ${order.buyerPhone ?? ''}`),
  };
}

/** Score of one order for the whole query: its weakest term, 0 when any term fails. */
function score(q, f) {
  if (q.dialled) {
    if (f.phone && f.phone.includes(q.dialled)) return 100;
    if (f.codes.some((c) => c.includes(q.compact))) return 100;
    return digitsNear(q.dialled, f.phone) ? 55 : 0;
  }
  if (q.compact.length >= 3 && f.codes.some((c) => c.includes(q.compact))) return 100;
  let weakest = q.terms.length ? 100 : 0;
  for (const term of q.terms) {
    let s = wordScore(term, f.buyer);
    // A term found elsewhere in the order as typed (part of an id, a tracking number).
    if (s < 80 && term.word.length >= 3 && f.text.includes(term.word)) s = 80;
    weakest = Math.min(weakest, s);
    if (!weakest) break;
  }
  if (weakest) return weakest;
  // One slip in a long order id or tracking number typed whole.
  return q.compact.length >= 8 && f.codes.some((c) => distance(q.compact, c, 1) <= 1) ? 55 : 0;
}

/**
 * The orders that answer a search: the exact hits in the list's order, or - only when
 * there are none - the near ones, best first. `fuzzy` says which it was.
 */
export function searchOrders(orders, raw) {
  const text = String(raw ?? '').trim().slice(0, 120);
  if (!text) return { orders, fuzzy: false };
  const folded = fold(text);
  const q = {
    compact: folded.replace(/ /g, ''),
    terms: folded.split(' ').filter(Boolean).map((word) => ({ word, key: phonetic(word) })),
    // Digits and the punctuation phone numbers are written with, at least six digits.
    dialled: /^[\d\s+().-]+$/.test(text) && text.replace(/\D/g, '').length >= 6 ? phoneDigits(text) : '',
  };
  const scored = orders.map((o, i) => ({ o, i, s: score(q, index(o)) })).filter((x) => x.s > 0);
  const exact = scored.filter((x) => x.s >= 80);
  if (exact.length) return { orders: exact.map((x) => x.o), fuzzy: false };
  return { orders: scored.sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.o), fuzzy: scored.length > 0 };
}
