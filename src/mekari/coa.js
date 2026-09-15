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


/** Where sales shipping is booked right now, as Jurnal itself reports it. */
export async function currentShippingAccount(companyId, { deadlineAt = null } = {}) {
  const result = await mekari({ path: `${COMPANY_PATH}/${companyId}`, deadlineAt });
  const account = (result?.company ?? result)?.sale_shipping_account ?? null;
  return account ? { id: account.id, number: account.number ?? '', name: account.name ?? '' } : null;
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
  // What the books do with postage today, read rather than assumed - it is the difference
  // between "already right" and "silently still going to Other Income".
  const current = await currentShippingAccount(company.id, { deadlineAt });

  const have = await existingTags({ deadlineAt });
  const missingTags = TAGS.filter((t) => !have.has(t.toLowerCase()));

  if (dryRun) {
    return {
      dryRun: true, company, accounts, shipping, currentShipping: current,
      tagsToCreate: missingTags, tagsPresent: TAGS.length - missingTags.length,
    };
  }
  if (isReadOnly()) throw new ReadOnlyError('setelan akun Jurnal');

  // Jurnal refuses to change this over the public API.
  //
  // Tried against the live company with the documented body and with the full record:
  // both come back 400 "Invalid HTTP parameters", even though the company's own
  // sales_shipping_account_changeable says true. So this is reported, not forced - it is
  // one click in Pengaturan and spending more of a scarce monthly quota guessing at a
  // request shape the API will not accept helps nobody.
  let companyPatched = false;
  let companyNote = '';
  try {
    await mekari({
      method: 'PATCH',
      path: `${COMPANY_PATH}/${company.id}`,
      deadlineAt,
      body: { company: { sale_shipping_account_id: shipping.id } },
    });
    companyPatched = true;
  } catch (error) {
    companyNote = error.message;
  }

  const created = [];
  for (const name of missingTags) {
    await mekari({ method: 'POST', path: TAGS_PATH, deadlineAt, body: { tag: { name } } });
    created.push(name);
  }

  return { dryRun: false, company, accounts, shipping, companyPatched, companyNote, currentShipping: current, tagsCreated: created, tagsPresent: TAGS.length - missingTags.length };
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

/**
 * Is Jurnal currently set to credit delivery to 5030?
 *
 * Postage travels in Jurnal's own shipping field, and which account that field credits is
 * a company setting this API cannot write - so the setting is the one part of this policy
 * that lives outside the code and can be changed by a person without anybody noticing.
 * That is exactly the kind of fact worth checking rather than assuming: it was
 * 7-70099 Other Income for months, and every invoice quietly credited delivery there.
 *
 * Cached for an hour. A sync that finds it wrong defers the invoices carrying postage
 * rather than booking them into the wrong account, which is recoverable; posting them is
 * not, short of deleting and rewriting the lot.
 */
const SHIPPING_CHECK_TTL_MS = 60 * 60 * 1000;
let shippingChecked = 0;
let shippingOk = null;

export async function shippingAccountReady({ force = false, deadlineAt = null } = {}) {
  if (!force && shippingOk !== null && Date.now() - shippingChecked < SHIPPING_CHECK_TTL_MS) return shippingOk;
  try {
    const company = await activeCompany({ deadlineAt });
    const current = await currentShippingAccount(company.id, { deadlineAt });
    shippingOk = { ok: current?.number === SHIPPING_ACCOUNT_NUMBER, current, wanted: SHIPPING_ACCOUNT_NUMBER };
  } catch (error) {
    // Unable to check is not the same as wrong. Say so, and let the caller decide.
    shippingOk = { ok: null, current: null, wanted: SHIPPING_ACCOUNT_NUMBER, error: error.message };
  }
  shippingChecked = Date.now();
  return shippingOk;
}

/** For tests and for a run that wants a fresh answer. */
export const forgetShippingCheck = () => { shippingOk = null; shippingChecked = 0; };
