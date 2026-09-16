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
 * Checked against Jurnal's own total_count, which rides free on the first page, because a
 * customer lost to pagination is the quietest failure in this file. plannedMoves reads a
 * name it cannot find as a buyer with no contact yet - "they get the right account for
 * free at the moment the contact is created" - and that sentence is true of a new buyer
 * and false of one the walk simply missed. Theirs is an existing contact still on 1100
 * General, and every sale of theirs keeps landing there while the run reports itself
 * clean. The invoice list lost 48 rows to exactly this and said nothing.
 *
 * No sort_key is asked for, deliberately. The invoice scan's remedy was to sort on
 * created_at rather than the date with ties, but Jurnal answers 422 for two of the three
 * sort keys tried on that endpoint and this one has never been asked for a sort at all -
 * a 422 here would abort a restatement before it moved a single customer. The count is
 * what catches the failure; the sort is what to try next if the count ever trips.
 *
 * @returns {Promise<{byName: Map<string, Array<{id: number, arNumber: string, arName: string}>>, walked: number, expected: number, complete: boolean}>}
 */
export async function customersByName({ deadlineAt = null, call = mekari } = {}) {
  const byName = new Map();
  let walked = 0;
  let expected = null;
  for (let page = 1; ; page += 1) {
    const result = await call({ path: `${CUSTOMERS_PATH}?page=${page}&page_size=${PAGE_SIZE}`, deadlineAt });
    const rows = result?.customers ?? [];
    if (expected === null) expected = Number(result?.total_count);
    for (const row of rows) {
      walked += 1;
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
    if (page >= pages || rows.length === 0) {
      return { byName, walked, expected, complete: !Number.isFinite(expected) || walked >= expected };
    }
  }
}

/** A walk that came back short, refusing rather than moving the customers it did see. */
export class PartialCustomerListError extends Error {
  constructor(walked, expected) {
    super(`daftar pelanggan Jurnal hanya terbaca ${walked} dari ${expected} - tidak aman memindahkan piutang`);
    this.name = 'PartialCustomerListError';
    this.walked = walked;
    this.expected = expected;
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
export async function alignReceivables(wanted, { dryRun = true, onProgress = () => {}, deadlineAt = null, call } = {}) {
  const options = { deadlineAt, ...(call ? { call } : {}) };
  const [accounts, read] = await Promise.all([accountMap(options), customersByName(options)]);
  const { byName: customers, walked, expected, complete } = read;

  const { toChange, unknown, collisions } = plannedMoves(wanted, accounts, customers);

  const total = customerCount(customers);
  if (dryRun) return { dryRun: true, customers: total, walked, expected, complete, toChange, unknown, collisions, changed: 0, failures: [] };
  if (isReadOnly()) throw new ReadOnlyError('akun piutang pelanggan');
  // Refused rather than partly done, and refused here rather than reported afterwards.
  //
  // The caller that matters is the restatement, which runs this first and then deletes
  // several hundred invoices it can never get back. Moving the customers the walk happened
  // to see and rewriting every invoice against them puts the ones it missed straight back
  // into 1100 General - the whole exercise spent, the old invoice numbers gone, and
  // nothing in the output saying which sales it happened to. Throwing before the first
  // PATCH costs a re-run; the alternative costs the books.
  if (!complete) throw new PartialCustomerListError(walked, expected);

  let changed = 0;
  const failures = [];
  const patch = call ?? mekari;
  for (const item of toChange) {
    try {
      await patch({
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
  return { dryRun: false, customers: total, walked, expected, complete, toChange, unknown, collisions, changed, failures };
}
