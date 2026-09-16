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
 * Every customer, by display name - all of them, not the last one seen.
 *
 * One request per hundred. Names are what this system knows a buyer by - it never sees a
 * Jurnal id until now - so the map is keyed on the name and the ids are what come out.
 *
 * Plural because the names genuinely collide. The marketplaces mask them: Tokopedia and
 * TikTok send "N*** W***astuti", Shopee a username, and buildInvoice says so in as many
 * words - two buyers behind one masked name share a contact. Jurnal will also happily
 * hold two customers with the same display name created at different times. A map that
 * kept one record per name patched one of them and reported every one of them as moved,
 * so a sale could still land in the general receivable with the run calling itself clean.
 *
 * @returns {Promise<Map<string, Array<{id: number, arNumber: string, arName: string}>>>}
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
      const record = { id: person.id, arNumber: String(ar?.number ?? ''), arName: ar?.name ?? '' };
      // The same customer can arrive twice across pages if a write lands mid-walk; keyed
      // on the id, that is the same record rather than a second one to patch.
      const held = byName.get(name) ?? [];
      if (!held.some((c) => c.id === record.id)) held.push(record);
      byName.set(name, held);
    }
    const pages = Number(result?.total_pages) || 1;
    if (page >= pages || rows.length === 0) return byName;
  }
}

/** How many customer records the map holds, which is not how many names it holds. */
export const customerCount = (byName) => [...byName.values()].reduce((n, list) => n + list.length, 0);

/**
 * Which customer records have to move, decided before anything is written.
 *
 * Every customer wearing the name, not one of them. Patching the first and counting the
 * name as done is how a masked buyer kept selling into 1100 General while the run reported
 * the move as complete - `changed` said four, the books had four more customers nobody had
 * touched, and nothing in the output hinted at either.
 *
 * @param {Map<string, string>} wanted  customer display name -> A/R account number
 * @param {Record<string, {id: number}>} accounts  account number -> account
 * @param {Map<string, Array<{id: number, arNumber: string}>>} customers
 */
export function plannedMoves(wanted, accounts, customers) {
  const toChange = [];
  const unknown = [];
  // Names Jurnal holds more than one customer for, so the report can say that a single
  // name cost several moves rather than leaving the arithmetic unexplained.
  const collisions = [];
  for (const [name, number] of wanted) {
    const held = customers.get(name) ?? [];
    // A buyer with no contact yet is not a problem to solve here: they get the right
    // account for free at the moment the contact is created.
    if (held.length === 0) { unknown.push(name); continue; }
    if (held.length > 1) collisions.push({ name, customers: held.length });
    const account = accounts[number];
    for (const customer of held) {
      if (customer.arNumber === number) continue;
      if (!account) { unknown.push(name); break; }
      toChange.push({ name, id: customer.id, from: customer.arNumber || '(kosong)', to: number, accountId: account.id });
    }
  }
  return { toChange, unknown, collisions };
}

/**
 * @param {Map<string, string>} wanted  customer display name -> A/R account number
 * @param {{dryRun?: boolean, onProgress?: Function, deadlineAt?: number|null}} options
 */
export async function alignReceivables(wanted, { dryRun = true, onProgress = () => {}, deadlineAt = null } = {}) {
  const [accounts, customers] = await Promise.all([accountMap({ deadlineAt }), customersByName({ deadlineAt })]);

  const { toChange, unknown, collisions } = plannedMoves(wanted, accounts, customers);

  const total = customerCount(customers);
  if (dryRun) return { dryRun: true, customers: total, toChange, unknown, collisions, changed: 0, failures: [] };
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
  return { dryRun: false, customers: total, toChange, unknown, collisions, changed, failures };
}
