import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInventoryExport, renderInventoryExport, inventoryFilename, inventoryRange, movementsByDay, FIRST_DAY } from '../src/export/inventory.js';
import { openWarehouse, emptyWarehouse, manualMove, receiveGoods, OPENING_AT } from '../src/warehouse.js';
import { toCsv } from '../src/export/sheet.js';

/**
 * The picklist's Export: the warehouse movement log in the shape of the old Inventory
 * Movement sheet, named the way the team names those files.
 */

const at = (iso) => Date.parse(iso);
function shelf() {
  let doc = openWarehouse(emptyWarehouse(), { now: (OPENING_AT + 60) * 1000 });
  doc = receiveGoods(doc, { lines: [{ code: 'M-038', qty: 40 }], note: 'TRM-07/DO/28/X/26', by: 'ika@treelogy.com', token: 'a' }, { now: at('2026-10-28T09:04:15Z') }).doc;
  doc = manualMove(doc, { code: 'M-035', kind: 'out', qty: 3, note: 'Stock Terjual di La-Brisa', by: 'anna@treelogy.com', token: 'b' }, { now: at('2026-10-25T09:56:47Z') }).doc;
  doc = manualMove(doc, { code: 'M-036', kind: 'count', qty: 200, note: 'Opname', by: 'ika@treelogy.com', token: 'c' }, { now: at('2026-10-20T03:00:00Z') }).doc;
  doc.moves.push({ id: 'shopee|2510ABC|1|M-037', at: Math.floor(at('2026-10-22T10:30:26Z') / 1000), code: 'M-037', kind: 'order', delta: -2, after: 124, ref: 'shopee|2510ABC', note: 'Picklist shopee 2510ABC' });
  return doc;
}

test('the file is named the way the team names it', () => {
  assert.equal(inventoryFilename('2026-10-01', '2026-10-29'), 'Inventory 1 - 29 Oct 2026.xlsx');
  assert.equal(inventoryFilename('2026-10-29', '2026-10-29', 'csv'), 'Inventory 29 Oct 2026.csv');
  assert.equal(inventoryFilename('2026-09-28', '2026-10-03'), 'Inventory 28 Sep - 3 Oct 2026.xlsx');
  assert.equal(inventoryFilename('2026-12-28', '2027-01-03'), 'Inventory 28 Dec 2026 - 3 Jan 2027.xlsx');
});

test('a range is put in order and stops at today, keeping the days the team named', () => {
  assert.deepEqual(inventoryRange({ from: '2026-10-29', to: '2026-10-20', today: '2026-10-29' }), { from: '2026-10-20', to: '2026-10-29' });
  assert.deepEqual(inventoryRange({ from: '2026-10-01', to: '2026-12-31', today: '2026-10-29' }), { from: '2026-10-01', to: '2026-10-29' });
  assert.deepEqual(inventoryRange({ from: '2026-11-02', to: '2026-11-05', today: '2026-10-29' }), { from: '2026-10-29', to: '2026-10-29' });
  assert.deepEqual(inventoryRange({ from: 'nonsense', to: '', today: '2026-10-29' }), { from: '2026-10-29', to: '2026-10-29' });
});

test('every movement in the range is one row, newest first, in the sheet\'s columns', () => {
  const sheet = buildInventoryExport(shelf(), { from: '2026-10-20', to: '2026-10-28', now: at('2026-10-29T03:00:00Z') });
  assert.deepEqual(sheet.columns.map((c) => c.label), ['Transaction ID', 'Timestamp', 'Movement Date', 'Item Code', 'Item Name', 'Movement Type', 'Qty', 'Reference', 'Notes', 'Submitted By', 'Status', 'Last Updated', 'Stock After']);
  assert.deepEqual(sheet.rows.map((r) => r.code), ['M-038', 'M-035', 'M-037', 'M-036']);
  const [received, out, order, count] = sheet.rows;
  assert.match(received.tx, /^TX-20261028-160415-[0-9A-F]{6}$/);
  assert.equal(received.at.s, '2026-10-28 16:04:15');
  assert.equal(received.day.s, '2026-10-28');
  assert.deepEqual([received.type, received.qty, received.ref, received.by, received.status], ['Inbound', 40, 'TRM-07/DO/28/X/26', 'ika@treelogy.com', 'Active']);
  assert.deepEqual([out.type, out.qty, out.ref], ['Outbound', 3, 'Stock Terjual di La-Brisa']);
  assert.deepEqual([order.type, order.qty, order.ref, order.notes, order.by], ['Outbound', 2, 'Shopee 2510ABC', 'Pesanan (picklist)', 'sistem']);
  assert.equal(count.type, 'Outbound');
  assert.equal(count.qty, 48);
  assert.equal(count.notes, 'Stock opname - stok jadi 200');
  assert.equal(sheet.inbound, 40);
  assert.equal(sheet.outbound, 53);
  assert.equal(sheet.name, 'Inventory_History_2026-10-29');
});

test('the same movement exported twice keeps its transaction number', () => {
  const one = buildInventoryExport(shelf(), { from: '2026-10-28', to: '2026-10-28' });
  const two = buildInventoryExport(shelf(), { from: '2026-10-28', to: '2026-10-28' });
  assert.equal(one.rows[0].tx, two.rows[0].tx);
});

test('days outside the range stay out, and the opening balance belongs to its own day', () => {
  assert.equal(buildInventoryExport(shelf(), { from: '2026-10-29', to: '2026-10-29' }).rows.length, 0);
  const opening = buildInventoryExport(shelf(), { from: FIRST_DAY, to: FIRST_DAY });
  assert.ok(opening.rows.length > 0);
  assert.ok(opening.rows.every((r) => r.ref === 'Inventory Movement App' && r.type === 'Inbound'));
});

test('csv and xlsx both come out, the csv with dates as text', () => {
  const sheet = buildInventoryExport(shelf(), { from: '2026-10-20', to: '2026-10-28' });
  const csv = toCsv(sheet).split('\r\n');
  assert.match(csv[1], /^TX-20261028-160415-[0-9A-F]{6},2026-10-28 16:04:15,2026-10-28,M-038,/);
  const xlsx = renderInventoryExport(sheet, 'xlsx');
  assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
});

test('the dialog learns per day how many movements and units there were', () => {
  const days = movementsByDay(shelf());
  assert.deepEqual(days['2026-10-28'], [1, 40, 0]);
  assert.deepEqual(days['2026-10-22'], [1, 0, 2]);
});
