import { mekari } from './client.js';
import { requiredAccounts, accountMap } from './accounts.js';
import { SOURCES, TAGS, RECEIVABLE_NUMBERS, SHIPPING_ACCOUNT_NUMBER } from './sources.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';

/**
 * The settings that live in Jurnal rather than in this code, put where they belong.
 *
 * Two of them, and both were the cause of a wrong number rather than a missing one.
 *
 * Delivery charged to the buyer was landing in 7-70099 Other Income, because that is what
 * Jurnal defaults to and nobody had said otherwise - so every invoice overstated other
 * income and understated delivery by exactly the postage. It is a company setting, not an
 * invoice field: the sales invoice payload has no account on it anywhere, so this is the
 * only place it can be fixed, and fixing it once fixes every invoice raised afterwards.
 *
 * Tags have to exist before an invoice may name one; Jurnal rejects the whole invoice
 * otherwise, which would turn a tagging decision into a failed sync.
 *
 * Run once, and again whenever the source table changes. It is cheap and idempotent, but
 * it is not automatic: a job that silently rewrites company-wide accounting settings on
 * every deploy is not something anyone should have to discover.
 */

const COMPANY_PATH = '/public/jurnal/api/v1/companies';
const TAGS_PATH = '/public/jurnal/api/v1/tags';

/** @returns {Promise<{id: number, name: string}>} the company these books belong to. */
export async function activeCompany({ deadlineAt = null } = {}) {
  const result = await mekari({ path: `${COMPANY_PATH}/active`, deadlineAt });
  const company = result?.company ?? result;
  if (!company?.id) throw new Error('perusahaan aktif tidak terbaca dari Jurnal');
  return { id: company.id, name: company.name ?? '' };
}

/** Tags already in Jurnal, by lower-cased name. */
async function existingTags({ deadlineAt = null } = {}) {
  const names = new Set();
  for (let page = 1; ; page += 1) {
    const result = await mekari({ path: `${TAGS_PATH}?page=${page}&page_size=100`, deadlineAt });
    const rows = result?.tags ?? [];
    for (const tag of rows) if (tag?.name) names.add(String(tag.name).toLowerCase());
    const pages = Number(result?.total_pages) || 1;
    if (page >= pages || rows.length === 0) return names;
  }
}

/**
 * @param {{dryRun?: boolean, deadlineAt?: number|null}} options
 * @returns {Promise<object>} what was found and what was changed
 */
export async function setUpChartOfAccounts({ dryRun = true, deadlineAt = null } = {}) {
  // Refuses rather than guesses if an account is missing: booking into whatever Jurnal
  // defaults to produces books that balance and are wrong.
  const accounts = await requiredAccounts({ deadlineAt });
  const company = await activeCompany({ deadlineAt });
  const shipping = accounts[SHIPPING_ACCOUNT_NUMBER];

  const have = await existingTags({ deadlineAt });
  const missingTags = TAGS.filter((t) => !have.has(t.toLowerCase()));

  if (dryRun) {
    return {
      dryRun: true, company, accounts, shipping,
      tagsToCreate: missingTags, tagsPresent: TAGS.length - missingTags.length,
    };
  }
  if (isReadOnly()) throw new ReadOnlyError('setelan akun Jurnal');

  await mekari({
    method: 'PATCH',
    path: `${COMPANY_PATH}/${company.id}`,
    deadlineAt,
    body: {
      company: {
        // shipping_sale has to be on as well: with it off Jurnal ignores the account and
        // silently stores the postage as zero, which is the same failure in a new place.
        shipping_sale: true,
        sale_shipping_account_id: shipping.id,
      },
    },
  });

  const created = [];
  for (const name of missingTags) {
    await mekari({ method: 'POST', path: TAGS_PATH, deadlineAt, body: { tag: { name } } });
    created.push(name);
  }

  return { dryRun: false, company, accounts, shipping, tagsCreated: created, tagsPresent: TAGS.length - missingTags.length };
}

/**
 * What the current settings would do to a sale from each source, without writing anything.
 *
 * The point is to make the policy readable in one place by somebody who does not read
 * JavaScript - the accountant who has to agree with it.
 */
export async function describePolicy() {
  const map = await accountMap();
  return Object.entries(SOURCES).map(([prefix, source]) => ({
    prefix,
    label: source.label,
    tag: source.tag,
    receivable: source.receivable,
    receivableName: map[source.receivable]?.name ?? '(tidak ditemukan)',
    termDays: source.termDays,
    autoPaid: source.autoPaid,
  }));
}

export { RECEIVABLE_NUMBERS, SHIPPING_ACCOUNT_NUMBER };
