import { mekari } from './client.js';
import { readDoc, writeDoc } from '../store/index.js';
import { RECEIVABLE_NUMBERS, SHIPPING_ACCOUNT_NUMBER } from './sources.js';

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

/** Read the whole chart once. One request per 200 accounts, and there are 210. */
async function fetchAccounts({ deadlineAt = null } = {}) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const result = await mekari({ path: `/public/jurnal/api/v1/accounts?page=${page}&page_size=${PAGE_SIZE}`, deadlineAt });
    const chunk = result?.accounts ?? [];
    rows.push(...chunk);
    const pages = Number(result?.total_pages) || 1;
    if (page >= pages || chunk.length === 0) break;
  }
  const byNumber = {};
  for (const account of rows) {
    const number = String(account.number ?? account.account_number ?? '').trim();
    if (number) byNumber[number] = { id: account.id, number, name: account.name ?? '' };
  }
  return byNumber;
}

/**
 * The account map, from cache when it is fresh.
 *
 * @param {{force?: boolean, deadlineAt?: number|null}} options
 * @returns {Promise<Record<string, {id: number, number: string, name: string}>>}
 */
export async function accountMap({ force = false, deadlineAt = null } = {}) {
  if (!force) {
    const cached = await readDoc(ACCOUNTS_PATHNAME).catch(() => null);
    const at = Date.parse(cached?.at ?? '');
    if (cached?.accounts && Number.isFinite(at) && Date.now() - at < TTL_MS) return cached.accounts;
  }
  const accounts = await fetchAccounts({ deadlineAt });
  await writeDoc(ACCOUNTS_PATHNAME, { version: 1, at: new Date().toISOString(), accounts }).catch(() => {});
  return accounts;
}

/**
 * The ids for every account this system writes into, refusing rather than guessing.
 *
 * A missing account is not something to work around. Booking a wholesale sale into
 * whatever receivable Jurnal defaults to, because 1501 was not found, produces books that
 * balance and are wrong - which is the failure that takes months to notice.
 */
export async function requiredAccounts(options = {}) {
  const wanted = [...RECEIVABLE_NUMBERS, SHIPPING_ACCOUNT_NUMBER];
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
