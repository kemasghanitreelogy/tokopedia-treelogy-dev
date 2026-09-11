import { mekari } from './client.js';
import { CUSTOMER_NAMES } from './invoice.js';
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

/** Existing contacts keyed by display name, walking every page - names are what we match on. */
export async function listContacts() {
  const byName = new Map();
  let page = 1;
  for (;;) {
    const result = await mekari({ path: `${CONTACTS_PATH}?page=${page}&page_size=100` });
    const rows = result?.contacts ?? result?.persons ?? result?.people ?? [];
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
  for (const name of missing) {
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
  }

  return { created, existing: wanted.filter((n) => existingByName.has(n)), missing: [] };
}

/**
 * Make sure one named customer exists, creating it only if it does not.
 *
 * A typed transaction can name any customer at all - a consignment shop, a wholesale
 * buyer - and Jurnal will not accept an invoice for a contact it does not hold. Looking
 * before writing matters more here than for the four fixed channels: two contacts with
 * the same display name would quietly split that customer's history in two.
 */
export async function ensureContact(name) {
  const wanted = String(name ?? '').trim();
  if (!wanted) throw new Error('nama pelanggan kosong');

  const existing = await listContacts();
  if (existing.has(wanted)) return { name: wanted, created: false };
  if (isReadOnly()) throw new ReadOnlyError(`kontak ${wanted}`);

  await mekari({
    method: 'POST',
    path: CONTACTS_PATH,
    body: {
      person: {
        display_name: wanted,
        is_customer: true,
        is_vendor: false,
        other_detail: 'Dibuat dari transaksi manual di dashboard Treelogy',
      },
    },
  });
  return { name: wanted, created: true };
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
