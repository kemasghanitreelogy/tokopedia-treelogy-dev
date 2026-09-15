import { mekari } from './client.js';
import { accountMap } from './accounts.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';

/**
 * Point each customer at the receivable their sales belong in.
 *
 * Jurnal's sales invoice carries no account anywhere - checked against the whole API spec,
 * for both create and update - so which receivable a sale lands in is decided entirely by
 * the customer record. Splitting A/R by channel therefore means going through the
 * customers, not the invoices.
 *
 * All 499 of them currently sit on 1100 Account Receivable - General, which is what the
 * books looked like before anybody asked the question.
 *
 * Idempotent and cheap to repeat: a customer already on the right account is skipped
 * without a request, so a run that stops halfway costs nothing to finish.
 */

const CUSTOMERS_PATH = '/public/jurnal/api/v1/customers';
const CONTACTS_PATH = '/public/jurnal/api/v1/contacts';
const PAGE_SIZE = 100;

/**
 * Every customer, by display name.
 *
 * One request per hundred. Names are what this system knows a buyer by - it never sees a
 * Jurnal id until now - so the map is keyed on the name and the id is what comes out.
 *
 * @returns {Promise<Map<string, {id: number, arNumber: string, arName: string}>>}
 */
export async function customersByName({ deadlineAt = null } = {}) {
  const byName = new Map();
  for (let page = 1; ; page += 1) {
    const result = await mekari({ path: `${CUSTOMERS_PATH}?page=${page}&page_size=${PAGE_SIZE}`, deadlineAt });
    const rows = result?.customers ?? [];
    for (const row of rows) {
      const person = row?.person ?? row;
      const name = String(person?.display_name ?? person?.name ?? '').trim();
      if (!name || !person?.id) continue;
      const ar = person.default_ar_account ?? null;
      byName.set(name, { id: person.id, arNumber: String(ar?.number ?? ''), arName: ar?.name ?? '' });
    }
    const pages = Number(result?.total_pages) || 1;
    if (page >= pages || rows.length === 0) return byName;
  }
}

/**
 * @param {Map<string, string>} wanted  customer display name -> A/R account number
 * @param {{dryRun?: boolean, onProgress?: Function, deadlineAt?: number|null}} options
 */
export async function alignReceivables(wanted, { dryRun = true, onProgress = () => {}, deadlineAt = null } = {}) {
  const [accounts, customers] = await Promise.all([accountMap({ deadlineAt }), customersByName({ deadlineAt })]);

  const toChange = [];
  const unknown = [];
  for (const [name, number] of wanted) {
    const customer = customers.get(name);
    // A buyer with no contact yet is not a problem to solve here: they get the right
    // account for free at the moment the contact is created.
    if (!customer) { unknown.push(name); continue; }
    if (customer.arNumber === number) continue;
    const account = accounts[number];
    if (!account) { unknown.push(name); continue; }
    toChange.push({ name, id: customer.id, from: customer.arNumber || '(kosong)', to: number, accountId: account.id });
  }

  if (dryRun) return { dryRun: true, customers: customers.size, toChange, unknown, changed: 0, failures: [] };
  if (isReadOnly()) throw new ReadOnlyError('akun piutang pelanggan');

  let changed = 0;
  const failures = [];
  for (const item of toChange) {
    try {
      await mekari({
        method: 'PATCH',
        path: `${CONTACTS_PATH}/${item.id}`,
        deadlineAt,
        body: { person: { default_ar_account_id: item.accountId } },
      });
      changed += 1;
      onProgress({ changed, of: toChange.length, name: item.name });
    } catch (error) {
      failures.push({ name: item.name, error: error.message });
    }
  }
  return { dryRun: false, customers: customers.size, toChange, unknown, changed, failures };
}
