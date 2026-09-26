import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBudget, setBudget, spend, dailyRation, BUDGET_DOC, RESERVE } from '../src/mekari/budget.js';
import { deleteDoc, closeStore } from '../src/store/index.js';

/**
 * The month's allowance, counted here because Jurnal will not say.
 *
 * The per-minute limiter stops a burst from earning a 429 and has never known how much
 * of the month is gone. Nothing did, which is how the account reached 10,886 of 12,000
 * with fifteen days still to go.
 */

test.after(async () => { await closeStore(); });
const clean = () => deleteDoc(BUDGET_DOC);

test('an unset budget gates nothing at all', async () => {
  await clean();
  /*
   * The one that shipped broken. `Number(null)` is 0, not NaN, so an unentered figure
   * read as "none left" and refused every invoice - the exact failure the comment above
   * it warned against. An unknown budget has to mean unknown.
   */
  const budget = await loadBudget();
  assert.equal(budget.remaining, null);

  const first = await spend(1);
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, null);
  assert.equal((await spend(1, { essential: true })).allowed, true);
});

test('a figure from the console is counted down', async () => {
  await clean();
  // Comfortably above the reserve: at ten remaining every one of these would be refused,
  // and rightly so.
  await setBudget({ remaining: RESERVE + 10 });
  assert.equal((await spend(1)).remaining, RESERVE + 9);
  assert.equal((await spend(3)).remaining, RESERVE + 6);
  assert.equal((await loadBudget()).remaining, RESERVE + 6);
});

test('the reserve stops the tools and lets the books through', async () => {
  await clean();
  await setBudget({ remaining: RESERVE + 1 });

  // A scan, a dedupe, an audit: none of them may eat what posting will need.
  const tool = await spend(5);
  assert.equal(tool.allowed, false);
  assert.match(tool.reason, /cadangan/);

  // Writing an invoice for a sale that has already happened is not optional.
  const invoice = await spend(1, { essential: true });
  assert.equal(invoice.allowed, true);
  assert.equal(invoice.remaining, RESERVE);
});

test('nothing is spent by a request that was refused', async () => {
  await clean();
  await setBudget({ remaining: RESERVE });
  await spend(1);
  assert.equal((await loadBudget()).remaining, RESERVE, 'penolakan tidak memotong sisa');
});

test('even the books stop when there is genuinely nothing left', async () => {
  await clean();
  await setBudget({ remaining: 0 });
  const out = await spend(1, { essential: true });
  assert.equal(out.allowed, false);
  assert.match(out.reason, /habis/);
});

test('the daily ration is the remainder spread over the days that are left', async () => {
  const now = Date.parse('2026-09-26T00:00:00Z');
  assert.equal(dailyRation({ remaining: 1114, renewsOn: '2026-10-11' }, { now }), 74);
  // Unknown in, unknown out - never a zero that would look like a hard stop.
  assert.equal(dailyRation({ remaining: 1114 }, { now }), null);
  assert.equal(dailyRation({ remaining: null, renewsOn: '2026-10-11' }, { now }), null);
  // The last day of the package does not divide by zero.
  assert.equal(dailyRation({ remaining: 50, renewsOn: '2026-09-26' }, { now }), 50);
});

test('what a day costs is recorded, which is the number nobody had', async () => {
  await clean();
  const now = Date.parse('2026-09-26T04:00:00Z');
  await spend(2, { now });
  await spend(3, { now });
  const budget = await loadBudget();
  assert.equal(budget.spent['2026-09-26'], 5);
});

test('the gauge keeps a fortnight, not a history', async () => {
  await clean();
  for (let i = 0; i < 20; i += 1) {
    await spend(1, { now: Date.parse('2026-09-01T00:00:00Z') + i * 86_400_000 });
  }
  assert.equal(Object.keys((await loadBudget()).spent).length, 14);
});
