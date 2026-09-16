import { mekari } from './client.js';
import { readDoc, writeDoc } from '../store/index.js';
import { RECEIVABLE_NUMBERS, POOLING_NUMBERS, SHIPPING_ACCOUNT_NUMBER } from './sources.js';

/**
 * Account numbers to Jurnal's internal ids, looked up once and then remembered.
 *
 * Every write that names an account - a contact's receivable, the company's shipping
 * account - wants an id, and the only way to learn one is to read the chart of accounts.
 * That read is 210 rows and it changes perhaps twice a year, so doing it per invoice
 * would spend the monthly API package on a fact that does not move.
 *
 * Cached in the state store rather than in memory: the sweep, the webhook handler and the
 * CLI are three processes, and an in-memory cache would mean three reads instead of one.
 */

export const ACCOUNTS_PATHNAME = 'mekari/accounts.json';

/** A chart of accounts is stable enough that a day is conservative. */
const TTL_MS = 24 * 60 * 60 * 1000;

const PAGE_SIZE = 200;

export class AccountMissingError extends Error {
  constructor(numbers) {
    super(`akun ${numbers.join(', ')} tidak ada di Jurnal - buat dulu di daftar akun`);
    this.name = 'AccountMissingError';
    this.numbers = numbers;
  }
}

/**
 * Read the whole chart once. One request per 200 accounts, and there are 210.
 *
 * Checked against Jurnal's own total_count, which rides free on the first page.
 *
 * The invoice list was losing rows to pagination over a sort with ties - transaction_date
 * has no time on it, so equal rows came back in a different order each request and a scan
 * finished 48 invoices short with no error - and the remedy there was to sort on
 * created_at instead. It is not applied here on purpose: the accounts endpoint has never
 * been asked for a sort_key, Jurnal answers 422 for the two other keys that were tried on
 * the invoice list, and a 422 on this read would take down every write in the system,
 * since each of them resolves its account through this map. Counting the rows catches the
 * same failure without betting the chart of accounts on an unverified parameter. If a
 * short read ever does show up here, adding the sort is the next thing to try.
 *
 * @returns {Promise<{byNumber: object, walked: number, expected: number, complete: boolean}>}
 */
async function fetchAccounts({ deadlineAt = null, call = mekari } = {}) {
  const rows = [];
  let expected = null;
  for (let page = 1; ; page += 1) {
    const result = await call({ path: `/public/jurnal/api/v1/accounts?page=${page}&page_size=${PAGE_SIZE}`, deadlineAt });
    const chunk = result?.accounts ?? [];
    if (expected === null) expected = Number(result?.total_count);
    rows.push(...chunk);
    const pages = Number(result?.total_pages) || 1;
    if (page >= pages || chunk.length === 0) break;
  }
  const byNumber = {};
  for (const account of rows) {
    const number = String(account.number ?? account.account_number ?? '').trim();
    if (number) byNumber[number] = { id: account.id, number, name: account.name ?? '' };
  }
  const complete = !Number.isFinite(expected) || rows.length >= expected;
  return { byNumber, walked: rows.length, expected, complete };
}

/**
 * The account map, from cache when it is fresh.
 *
 * @param {{force?: boolean, deadlineAt?: number|null}} options
 * @returns {Promise<Record<string, {id: number, number: string, name: string}>>}
 */
export async function accountMap({ force = false, deadlineAt = null, call } = {}) {
  if (!force) {
    const cached = await readDoc(ACCOUNTS_PATHNAME).catch(() => null);
    const at = Date.parse(cached?.at ?? '');
    if (cached?.accounts && Number.isFinite(at) && Date.now() - at < TTL_MS) return cached.accounts;
  }
  const { byNumber, walked, expected, complete } = await fetchAccounts({ deadlineAt, ...(call ? { call } : {}) });
  // A short read is never cached. The TTL here is a day, so caching one would make a
  // moment's bad pagination into twenty-four hours of "akun 1501 tidak ada di Jurnal" -
  // and requiredAccounts, which forces a fresh read on a miss, would be forcing it against
  // a cache it had just written itself.
  if (complete) {
    await writeDoc(ACCOUNTS_PATHNAME, { version: 1, at: new Date().toISOString(), accounts: byNumber }).catch(() => {});
  } else {
    console.warn(`mekari: daftar akun dapat ${walked} dari ${expected} baris - tidak disimpan ke cache`);
  }
  return byNumber;
}

/**
 * The ids for every account this system writes into, refusing rather than guessing.
 *
 * A missing account is not something to work around. Booking a wholesale sale into
 * whatever receivable Jurnal defaults to, because 1501 was not found, produces books that
 * balance and are wrong - which is the failure that takes months to notice.
 */
export async function requiredAccounts(options = {}) {
  const wanted = [...RECEIVABLE_NUMBERS, ...POOLING_NUMBERS, SHIPPING_ACCOUNT_NUMBER];
  let map = await accountMap(options);
  let missing = wanted.filter((n) => !map[n]);
  // An account created in Jurnal a minute ago is exactly the case a cache gets wrong, so
  // a miss is worth one fresh read before it is called an error.
  if (missing.length > 0) {
    map = await accountMap({ ...options, force: true });
    missing = wanted.filter((n) => !map[n]);
  }
  if (missing.length > 0) throw new AccountMissingError(missing);
  return Object.fromEntries(wanted.map((n) => [n, map[n]]));
}

/**
 * The accounts a posting run needs, and the only map that should ever reach buildInvoice.
 *
 * accountMap alone is not enough, and the difference is not academic. Its cache lasts a
 * day, so for the whole day after the pooling accounts were created in Jurnal it kept
 * answering that 1111, 1112 and 1113 did not exist - and buildInvoice reads a missing
 * pooling account as "raise this invoice open". Every marketplace sale posted in that
 * window would have gone into the books unpaid, silently, with nothing to say why.
 *
 * This forces one fresh read the moment an account is missing, which is exactly the case a
 * cache gets wrong, and refuses if it is still missing afterwards.
 */
export const postingAccounts = (options = {}) => requiredAccounts(options);
