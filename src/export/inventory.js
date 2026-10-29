import { createHash } from 'node:crypto';
import { CHANNELS } from '../omni.js';
import { OPENING_AT } from '../warehouse.js';
import { businessDate, businessDayStart, offsetSeconds } from '../clock.js';
import { excelSerial, toCsv, toXlsx } from './sheet.js';

/**
 * The warehouse movement log as a file, in the shape of the "Inventory Movement App"
 * sheet it replaced.
 *
 * Column for column what that sheet exported (Transaction ID through Last Updated), so a
 * file from here drops into whatever the team built on the old one. One column is added
 * at the end - the shelf figure after the movement - because it is the number somebody
 * checks a count against, and the old sheet never had it to give.
 *
 * Every movement is one row, newest first, as the sheet listed them: an order confirmed
 * on the picklist, goods received, goods out, a count, a return to the shelf. The sheet
 * only knew Inbound and Outbound, so a count is written as whichever way it moved the
 * shelf, with the count itself said in Notes.
 */

/** What each kind of movement is called in the Notes column. */
export const KIND_NOTES = {
  opening: 'Saldo awal dari sheet',
  order: 'Pesanan (picklist)',
  return: 'Kembali ke rak',
  in: 'Barang masuk',
  out: 'Barang keluar',
  count: 'Stock opname',
};

/** The first day the log can hold: the sheet's figures came in on 6 Oct 2026. */
export const FIRST_DAY = businessDate(OPENING_AT);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Inventory 1 - 29 Oct 2026", the name the team already gives these files: the month
 * and year are said once when both ends share them, and a single day is just that day.
 */
export function inventoryFilename(from, to, format = 'xlsx') {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const day = (y, m, d) => `${d} ${MONTHS[m - 1]} ${y}`;
  let span;
  if (from === to) span = day(ty, tm, td);
  else if (fy === ty && fm === tm) span = `${fd} - ${day(ty, tm, td)}`;
  else if (fy === ty) span = `${fd} ${MONTHS[fm - 1]} - ${day(ty, tm, td)}`;
  else span = `${day(fy, fm, fd)} - ${day(ty, tm, td)}`;
  return `Inventory ${span}.${format === 'csv' ? 'csv' : 'xlsx'}`;
}

/**
 * The days asked for, as the house calendar has them. Dates out of order are swapped
 * rather than refused, and nothing after today is asked of it. Days before the log began
 * stay in the range - they hold no rows, but "1 - 29 Oct" is the month the team means and
 * the file should be named for it.
 */
export function inventoryRange({ from, to, today }) {
  const valid = (d) => typeof d === 'string' && businessDayStart(d) !== null;
  let a = valid(from) ? from : today;
  let b = valid(to) ? to : today;
  if (a > b) [a, b] = [b, a];
  if (b > today) b = today;
  if (a > b) a = b;
  return { from: a, to: b };
}

const stamp = (at) => {
  const local = new Date((at + offsetSeconds()) * 1000).toISOString();
  return { n: excelSerial(at + offsetSeconds()), s: `${local.slice(0, 10)} ${local.slice(11, 19)}`, compact: local.slice(0, 19).replace(/[-:]/g, '').replace('T', '-') };
};

/** TX-20261028-160415-C66DC4, as the sheet numbered them; the tail is the movement's own id, so a re-export gives the same number. */
const transactionId = (move, compact) => `TX-${compact}-${createHash('sha1').update(String(move.id ?? '')).digest('hex').slice(0, 6).toUpperCase()}`;

/** "Tokopedia 583921", from the movement's `channel|id` reference. */
function orderLabel(ref) {
  const [channel, ...rest] = String(ref ?? '').split('|');
  const id = rest.join('|');
  if (!id) return String(ref ?? '');
  if (channel === 'manual') return id;
  return `${CHANNELS[channel]?.label ?? channel} ${id}`;
}

function reference(move) {
  if (move.kind === 'order' || move.kind === 'return') return orderLabel(move.ref);
  if (move.kind === 'opening') return 'Inventory Movement App';
  return String(move.note ?? '');
}

function notes(move) {
  const said = KIND_NOTES[move.kind] ?? move.kind;
  if (move.kind === 'count') return `${said} - stok jadi ${move.after}`;
  // An order's own note only says something the Reference does not when the order came
  // back to the picklist or was edited after it left the shelf.
  if (move.kind === 'order' && move.note && !/^Picklist (?!ulang)/.test(move.note)) return `${said} - ${move.note}`;
  if (move.kind === 'return' && move.note) return move.note;
  return said;
}

export const INVENTORY_COLUMNS = [
  { label: 'Transaction ID', key: 'tx', width: 27 },
  { label: 'Timestamp', key: 'at', type: 'date', width: 17 },
  { label: 'Movement Date', key: 'day', type: 'day', width: 14 },
  { label: 'Item Code', key: 'code', width: 10 },
  { label: 'Item Name', key: 'name', width: 34 },
  { label: 'Movement Type', key: 'type', width: 15 },
  { label: 'Qty', key: 'qty', type: 'int', width: 8 },
  { label: 'Reference', key: 'ref', width: 34 },
  { label: 'Notes', key: 'notes', width: 30 },
  { label: 'Submitted By', key: 'by', width: 22 },
  { label: 'Status', key: 'status', width: 9 },
  { label: 'Last Updated', key: 'updated', type: 'date', width: 17 },
  { label: 'Stock After', key: 'after', type: 'int', width: 12 },
];

/**
 * The rows for the days from..to (house calendar, both included), newest first. A
 * movement that moved nothing is not a movement and is left out.
 */
export function buildInventoryExport(warehouse, { from, to, now = Date.now() }) {
  const start = businessDayStart(from);
  const end = businessDayStart(to) + 86400;
  const items = warehouse?.items ?? {};
  const moves = (warehouse?.moves ?? [])
    .filter((m) => m && m.delta && m.at >= start && m.at < end)
    .sort((a, b) => b.at - a.at);
  const rows = moves.map((m) => {
    const at = stamp(m.at);
    const day = businessDayStart(businessDate(m.at));
    return {
      tx: transactionId(m, at.compact),
      at,
      day: { n: excelSerial(day + offsetSeconds()), s: businessDate(m.at) },
      code: m.code,
      name: items[m.code]?.name ?? m.code,
      type: m.delta > 0 ? 'Inbound' : 'Outbound',
      qty: Math.abs(m.delta),
      ref: reference(m),
      notes: notes(m),
      by: m.by || 'sistem',
      status: 'Active',
      updated: at,
      after: Number.isFinite(m.after) ? m.after : null,
    };
  });
  const units = (sign) => moves.filter((m) => Math.sign(m.delta) === sign).reduce((n, m) => n + Math.abs(m.delta), 0);
  return {
    name: `Inventory_History_${businessDate(Math.floor(now / 1000))}`,
    columns: INVENTORY_COLUMNS,
    rows,
    from, to,
    inbound: units(1),
    outbound: units(-1),
  };
}

export function renderInventoryExport(sheet, format) {
  if (format === 'csv') return { body: Buffer.from(toCsv(sheet), 'utf8'), type: 'text/csv; charset=utf-8' };
  return { body: toXlsx(sheet), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

/**
 * Per house day: how many movements, and the units in and out. Small enough to ride
 * along in the page, so the export dialog can say what a range holds before anybody
 * downloads it.
 */
export function movementsByDay(warehouse) {
  const days = {};
  for (const m of warehouse?.moves ?? []) {
    if (!m?.delta) continue;
    const d = businessDate(m.at);
    const day = (days[d] ??= [0, 0, 0]);
    day[0] += 1;
    day[m.delta > 0 ? 1 : 2] += Math.abs(m.delta);
  }
  return days;
}
