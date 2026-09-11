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
