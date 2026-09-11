import { mekari } from './client.js';
import { CUSTOMER_NAMES, productNameFor } from './invoice.js';
import { PRODUCTS } from '../master.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';

/**
 * The contacts an invoice needs before it can exist.
 *
 * A Jurnal invoice references its customer by name, and the name has to resolve to a
 * real contact flagged as a customer. The account starts empty, so the four channel
 * contacts are created once and then found on every later run. Creating the same name
 * twice would leave two contacts with the same display name and split the reports, so
 * every run looks before it writes.
 */

const CONTACTS_PATH = '/public/jurnal/api/v1/contacts';

/**
 * Jurnal's own answer when a display name is taken.
 *
 * The contacts list endpoint does not cooperate - it returns contact_data: null even when
 * contacts demonstrably exist, and its one documented query parameter 404s on every value
 * - so the duplicate check cannot be a read. It does not need to be: creating a contact
 * whose name is taken is refused with 409 and the id of the contact that already has it.
 * Letting the server answer the question is stronger than asking it ourselves anyway,
 * because there is no window between the check and the write.
 */
const ALREADY_EXISTS = 409;

/**
 * Contact names this process has already settled.
 *
 * Every invoice now names its own buyer, so without this each order would cost an extra
 * write just to be told 409. Fluid Compute reuses instances and a backfill runs in one
 * process, so the cache pays for itself immediately. Losing it costs one wasted call per
 * buyer, never a duplicate: the 409 is what actually prevents that.
 */
const knownContacts = new Set();

/** Seed from a persisted list, so a cold instance does not re-learn every buyer by 409. */
export const rememberContacts = (names) => { for (const n of names ?? []) knownContacts.add(n); };
export const knownContactNames = () => [...knownContacts];

const existingIdFrom = (error) =>
  (error.status === ALREADY_EXISTS ? (error.body?.id ?? null) : undefined);

/** Existing contacts keyed by display name, walking every page - names are what we match on. */
export async function listContacts() {
  const byName = new Map();
  let page = 1;
  for (;;) {
    const result = await mekari({ path: `${CONTACTS_PATH}?page=${page}&page_size=100` });
    // Confirmed against the live account: the list arrives as contact_list.contact_data,
    // and an empty account sends null rather than an empty array. Guessing this wrong is
    // not a cosmetic bug - it makes every existing contact invisible, so a "create if
    // missing" check would create a second contact with the same name on every run.
    const rows = result?.contact_list?.contact_data ?? [];
    for (const row of rows) {
      const name = row.display_name ?? row.name;
      if (name) byName.set(name, row);
    }
    const pages = Number(result?.total_pages) || 1;
    if (page >= pages || rows.length === 0) break;
    page += 1;
  }
  return byName;
}

/**
 * Make sure every channel has a customer contact.
 *
 * @returns {{created: string[], existing: string[]}}
 */
export async function ensureCustomers({ dryRun = true } = {}) {
  const wanted = Object.values(CUSTOMER_NAMES);
  const existingByName = await listContacts();

  const missing = wanted.filter((name) => !existingByName.has(name));
  if (dryRun) return { created: [], existing: wanted.filter((n) => existingByName.has(n)), missing };
  if (missing.length > 0 && isReadOnly()) throw new ReadOnlyError(`${missing.length} kontak pelanggan`);

  const created = [];
  const alreadyThere = [];
  for (const name of missing) {
    try {
      await mekari({
        method: 'POST',
        path: CONTACTS_PATH,
        body: {
          person: {
            display_name: name,
            is_customer: true,
            // A marketplace is a sales channel, never a supplier - flagging it as a vendor
            // too would let it appear in purchase forms by mistake.
            is_vendor: false,
            other_detail: 'Dibuat otomatis oleh sinkronisasi pesanan omnichannel Treelogy',
          },
        },
      });
      created.push(name);
      knownContacts.add(name);
    } catch (error) {
      if (existingIdFrom(error) === undefined) throw error;
      alreadyThere.push(name);
      knownContacts.add(name);
    }
  }

  return { created, existing: [...wanted.filter((n) => existingByName.has(n)), ...alreadyThere], missing: [] };
}

/* ------------------------------------------------------------------ products */

const PRODUCTS_PATH = '/public/jurnal/api/v1/products';

/**
 * The revenue account every sold product books into.
 *
 * 4-40000 Revenues is the account Jurnal's own chart of accounts provides for this; the
 * alternatives in the Income category are Sales Discount, Sales Return and Unbilled
 * Revenues, none of which is where a sale belongs.
 */
export const SELL_ACCOUNT_NUMBER = '4-40000';

/** Existing products keyed by product_code, which is our SKU. */
export async function listProducts() {
  const byCode = new Map();
  let page = 1;
  for (;;) {
    const result = await mekari({ path: `${PRODUCTS_PATH}?page=${page}&page_size=100` });
    const rows = result?.products ?? [];
    for (const row of rows) {
      const code = row.product_code ?? row.code;
      if (code) byCode.set(code, row);
    }
    const pages = Number(result?.total_pages) || 1;
    if (page >= pages || rows.length === 0) break;
    page += 1;
  }
  return byCode;
}

/**
 * Make sure every SKU we can sell exists as a product in Jurnal.
 *
 * An invoice line naming a product Jurnal does not hold is rejected outright - "Product
 * in transaction lines attributes on row 1 not available" - so this has to run before the
 * first invoice, not after the first failure.
 *
 * Inventory tracking is deliberately off. Stock already has a master (the local ledger
 * that both marketplaces are made to follow); switching it on here would create a second
 * one that disagrees, and would demand an inventory asset account and COGS postings that
 * nobody asked for.
 */
export async function ensureProducts({ dryRun = true } = {}) {
  const existing = await listProducts();
  const wanted = PRODUCTS.map((p) => ({ sku: p.sku, name: productNameFor({ sku: p.sku }) }));
  const missing = wanted.filter((p) => !existing.has(p.sku));

  if (dryRun) return { created: [], existing: wanted.length - missing.length, missing: missing.map((p) => p.sku) };
  if (missing.length > 0 && isReadOnly()) throw new ReadOnlyError(`${missing.length} produk`);

  const created = [];
  const alreadyThere = [];
  for (const product of missing) {
    try {
      await mekari({
        method: 'POST',
        path: PRODUCTS_PATH,
        body: {
          product: {
            name: product.name,
            product_code: product.sku,
            is_sold: true,
            is_bought: false,
            sell_account_number: SELL_ACCOUNT_NUMBER,
            track_inventory: false,
            description: 'Dibuat otomatis dari data master Treelogy',
          },
        },
      });
      created.push(product.sku);
    } catch (error) {
      if (existingIdFrom(error) === undefined) throw error;
      alreadyThere.push(product.sku);
    }
  }
  return { created, alreadyThere, existing: wanted.length - missing.length, missing: [] };
}

/** Everything Jurnal needs to hold before the first invoice can be written. */
export async function ensureReady({ dryRun = true } = {}) {
  const customers = await ensureCustomers({ dryRun });
  const products = await ensureProducts({ dryRun });
  return { customers, products };
}

/**
 * Make sure one named customer exists, creating it only if it does not.
 *
 * A typed transaction can name any customer at all - a consignment shop, a wholesale
 * buyer - and Jurnal will not accept an invoice for a contact it does not hold. Looking
 * before writing matters more here than for the four fixed channels: two contacts with
 * the same display name would quietly split that customer's history in two.
 */
export async function ensureContact(name, { deadlineAt = null } = {}) {
  const wanted = String(name ?? '').trim();
  if (!wanted) throw new Error('nama pelanggan kosong');
  if (knownContacts.has(wanted)) return { name: wanted, created: false };
  if (isReadOnly()) throw new ReadOnlyError(`kontak ${wanted}`);

  try {
    await mekari({
      method: 'POST',
      path: CONTACTS_PATH,
      deadlineAt,
      body: {
        person: {
          display_name: wanted,
          is_customer: true,
          is_vendor: false,
          other_detail: 'Dibuat otomatis dari pesanan Treelogy',
        },
      },
    });
    knownContacts.add(wanted);
    return { name: wanted, created: true };
  } catch (error) {
    // 409 means the name is taken, which is the answer we wanted.
    if (existingIdFrom(error) === undefined) throw error;
    knownContacts.add(wanted);
    return { name: wanted, created: false };
  }
}

/** A deposit account has to exist before an invoice can be marked paid into it. */
export async function findDepositAccount(name) {
  let page = 1;
  for (;;) {
    const result = await mekari({ path: `/public/jurnal/api/v1/accounts?page=${page}&page_size=100` });
    const rows = result?.accounts ?? [];
    const hit = rows.find((a) => (a.name ?? '').toLowerCase() === name.toLowerCase());
    if (hit) return hit;
    const pages = Number(result?.total_pages) || 1;
    if (page >= pages || rows.length === 0) return null;
    page += 1;
  }
}
