import { mekari } from './client.js';
import { postingAccounts } from './accounts.js';
import { invoiceCatalogue, forgetCatalogue } from './catalogue.js';
import { orderOfCustomId } from './settle.js';
import { poolingFor } from './sources.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';

/**
 * Move each settled marketplace sale out of the bank and into its channel's pooling account.
 *
 * Every payment this system has ever written went into one account named by an environment
 * variable, and that account was BCA. So the books said the cash was in the bank from the
 * moment the buyer paid - while Shopee, Tokopedia and the web shop were still holding it,
 * for days or weeks. Across 2,080 payments that is the whole of the online turnover sitting
 * in a bank balance that never had it.
 *
 * The obvious destination - the channel's own A/R - is not available. Jurnal accepts only a
 * Cash & Bank account as a deposit target and answers "deposit account not exist" for
 * anything else, which 1503 is, being Accounts Receivable. Checked against the live account
 * rather than reasoned about. So each channel has a pooling account in Cash & Bank, and the
 * payout becomes a transfer from there to the bank on the day it actually arrives.
 *
 * Which channel a payment belongs to is read from the invoice it settles, not from the
 * payment's own tag: the tag is a label somebody could edit, the custom_id is the key this
 * system wrote and the one it can prove.
 *
 * Jurnal's PATCH on a payment is a replace, like the one on an invoice: transaction_date,
 * records_attributes, person_name, payment_method_name and deposit_to_name must all be
 * present or the request is refused. Everything but the account is therefore sent back
 * exactly as it was read.
 */

const PAYMENTS_PATH = '/public/jurnal/api/v1/receive_payments';
const PAGE_SIZE = 50;

/**
 * The method written onto payments that have none.
 *
 * Every payment this system created came from an invoice deposit, which records no method
 * at all - and Jurnal's PATCH requires one. A marketplace settlement is a transfer, so that
 * is what it is called; it is new information on the record, and it is said out loud here
 * rather than being a side effect nobody expected.
 */
export const DEFAULT_METHOD = 'Bank Transfer';

/** Jurnal writes dd/mm/yyyy and takes yyyy-mm-dd. */
const toIso = (ddmmyyyy) => {
  const m = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(String(ddmmyyyy ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

/**
 * Every payment Jurnal holds, checked against its own count.
 *
 * A short walk here would read as "nothing left to move" and quietly leave money in the
 * bank account, which is the failure this whole module exists to undo - so an incomplete
 * scan is reported, never rounded off.
 */
export async function allPayments({ deadlineAt = null, onProgress = () => {} } = {}) {
  const payments = [];
  let expected = null;
  for (let page = 1; ; page += 1) {
    const result = await mekari({
      path: `${PAYMENTS_PATH}?page=${page}&page_size=${PAGE_SIZE}&sort_key=created_at&sort_order=desc`,
      deadlineAt,
    });
    const rows = result?.receive_payments ?? [];
    if (expected === null) expected = Number(result?.total_count);
    payments.push(...rows);
    onProgress({ page, payments: payments.length, expected });
    if (rows.length === 0 || page >= (Number(result?.total_pages) || 1)) break;
  }
  const complete = !Number.isFinite(expected) || payments.length >= expected;
  return { payments, expected, complete };
}

/**
 * What each payment should be deposited into, and which ones disagree with that today.
 *
 * @returns {Promise<{checked: number, wrong: Array, unknown: Array, complete: boolean}>}
 */
export async function planRepool({ since = null, deadlineAt = null, onProgress = () => {} } = {}) {
  const [{ payments, expected, complete }, catalogue, accounts] = await Promise.all([
    allPayments({ deadlineAt, onProgress }),
    invoiceCatalogue({ since, deadlineAt }),
    postingAccounts(),
  ]);

  // Invoice number to the custom_id we wrote, which is the only thing that says which
  // channel a payment belongs to.
  const customIdByNo = new Map(catalogue.invoices.map((i) => [String(i.no), i.customId]));

  const wrong = [];
  const unknown = [];
  for (const payment of payments) {
    // Outside the window asked for, so not this run's business. Checked before anything
    // else, because the whole point of a window is to not pay for what it excludes.
    const iso = toIso(payment.transaction_date);
    if (since && iso && iso < since) continue;
    const records = payment.records ?? [];
    const customIds = [...new Set(records.map((r) => customIdByNo.get(String(r.transaction_no))).filter(Boolean))];
    const pooling = [...new Set(customIds.map((id) => {
      const order = orderOfCustomId(id);
      return order ? poolingFor(order) : null;
    }))];

    // A payment covering two channels at once has no single right account, and one that
    // names no invoice we recognise is not ours to move. Both are reported rather than
    // guessed at: an account chosen by guess is money in the wrong place.
    if (pooling.length !== 1 || !pooling[0]) {
      unknown.push({ id: payment.id, no: payment.transaction_no, reason: pooling.length > 1 ? 'lebih dari satu kanal' : 'kanal tidak dikenali' });
      continue;
    }
    const want = accounts?.[pooling[0]];
    if (!want?.name) {
      unknown.push({ id: payment.id, no: payment.transaction_no, reason: `akun ${pooling[0]} tidak ada di Jurnal` });
      continue;
    }
    if (String(payment.deposit_to?.number ?? '') === want.number) continue;

    wrong.push({
      id: payment.id,
      no: payment.transaction_no,
      date: payment.transaction_date,
      was: `${payment.deposit_to?.number ?? '?'} ${payment.deposit_to?.name ?? '?'}`,
      to: want.name,
      toNumber: want.number,
      amount: Math.round(Number(payment.original_amount) || 0),
      person: payment.person?.display_name ?? payment.person?.name ?? null,
      method: payment.payment_method?.name ?? null,
      memo: payment.memo ?? null,
      records: records.map((r) => ({ id: r.id, transaction_no: r.transaction_no, amount: Number(r.amount) })),
    });
  }

  return { checked: payments.length, expected, complete, wrong, unknown };
}

/** The exact body sent for one payment, or the reason it must not be sent. */
export function repoolBody(item) {
  const date = toIso(item.date);
  if (!date) return { refuse: `tanggal tidak terbaca: ${item.date}` };
  if (!item.person) return { refuse: 'pembayaran tanpa nama orang - PATCH akan ditolak' };
  if (item.records.length === 0) return { refuse: 'pembayaran tidak menunjuk faktur mana pun' };
  return {
    body: {
      receive_payment: {
        transaction_date: date,
        records_attributes: item.records,
        person_name: item.person,
        payment_method_name: item.method ?? DEFAULT_METHOD,
        deposit_to_name: item.to,
        ...(item.memo ? { memo: item.memo } : {}),
      },
    },
  };
}

/**
/**
 * @param {{since?: string|null, limit?: number|null, dryRun?: boolean, onProgress?: Function}} options
 *        `limit` caps how many payments are moved in one run. Jurnal's monthly package is
 *        finite and 2,080 payments is 2,080 writes, so the correction is meant to be taken
 *        in affordable pieces: each run moves the ones still in the wrong account, so
 *        running it again simply continues where the last one stopped.
 */
export async function repoolPayments({ since = null, limit = null, dryRun = true, onProgress = () => {} } = {}) {
  const plan = await planRepool({ since });
  if (plan.complete === false) {
    throw new Error(`pindai pembayaran tidak lengkap (${plan.checked} dari ${plan.expected}) - jangan pindahkan uang dari daftar yang kurang`);
  }
  if (dryRun) return { ...plan, dryRun: true, moved: 0, failures: [] };
  if (isReadOnly()) throw new ReadOnlyError('pindahkan setoran ke akun penampung');

  let moved = 0;
  const failures = [];
  const todo = Number.isFinite(limit) && limit > 0 ? plan.wrong.slice(0, limit) : plan.wrong;
  for (const item of todo) {
    const attempt = repoolBody(item);
    if (attempt.refuse) {
      failures.push({ no: item.no, error: attempt.refuse });
      continue;
    }
    try {
      await mekari({ method: 'PATCH', path: `${PAYMENTS_PATH}/${item.id}`, body: attempt.body });
      moved += 1;
      onProgress({ moved, of: todo.length, no: item.no, to: item.to });
    } catch (error) {
      failures.push({ no: item.no, error: error.message });
    }
  }
  // A payment's account is part of what the invoice scan describes, so the cached reading
  // is stale the moment one moves.
  if (moved > 0) await forgetCatalogue();
  return { ...plan, dryRun: false, moved, failures, remaining: plan.wrong.length - moved - failures.length };
}
