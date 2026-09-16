import test from 'node:test';
import assert from 'node:assert/strict';
import { channelOfCustomId, openInvoices } from '../src/mekari/settle.js';
import { customIdFor } from '../src/mekari/invoice.js';
import { sourceOf } from '../src/mekari/sources.js';
import { CATALOGUE_PATHNAME, forgetCatalogue } from '../src/mekari/catalogue.js';
import { writeDoc } from '../src/store/index.js';

/**
 * Which invoices the settler is allowed to pay, and - far more important - which it is not.
 *
 * Marking an invoice paid writes a receive_payment into the books. For a marketplace order
 * that is a correction: the platform took the money before the parcel shipped, and the
 * invoice was only left open because MEKARI_DEPOSIT_ACCOUNT was unset when it was raised.
 * For a consignment shop or a walk-in it is an invention - the money has not arrived,
 * nobody has been chased for it, and the receivable that was supposed to prompt the chase
 * is now closed.
 *
 * The whole decision rests on one regex reading the channel back out of a custom_id this
 * system wrote. These pin what it must recognise, what it must refuse to recognise, and
 * that a refusal always fails closed.
 *
 * No network: the settler reads the shared invoice scan, so seeding that scan's cache
 * exercises openInvoices() itself rather than a copy of its rules. Under the test runner
 * the store is a throwaway sqlite file in TMPDIR, never the real state.
 */

/* ------------------------------------------------ what the custom_id actually looks like */

test('the channel is read back out of the ids this system really writes', () => {
  // The exact shapes in Jurnal today: a Shopee order code, a TikTok Shop order number, and
  // a Shopify order name with its '#' already stripped by customIdFor.
  assert.equal(channelOfCustomId('TRL-shopee-260915X'), 'shopee');
  assert.equal(channelOfCustomId('TRL-tiktok_shop-585123456789012345'), 'tiktok_shop');
  assert.equal(channelOfCustomId('TRL-shopify-10892'), 'shopify');
  assert.equal(channelOfCustomId('TRL-tokopedia-586087586143175832'), 'tokopedia');
});

test('the underscore in tiktok_shop is part of the channel, not the end of it', () => {
  // A character class of [a-z] instead of [a-z_] reads "tiktok" - a channel no source
  // table knows - and every TikTok Shop invoice raised before the deposit account existed
  // stays open forever, overstating receivables by all of them. It is also the channel
  // with the longest ids, so it is the one nobody notices by eye.
  assert.equal(channelOfCustomId('TRL-tiktok_shop-585123'), 'tiktok_shop');
  assert.notEqual(channelOfCustomId('TRL-tiktok_shop-585123'), 'tiktok');
  assert.equal(sourceOf({ channel: channelOfCustomId('TRL-tiktok_shop-585123') }).label, 'TikTok Shop');
});

test('every channel this system writes survives the round trip', () => {
  // customIdFor() builds the key and channelOfCustomId() takes it apart. They are in
  // different modules and nothing but this holds their format agreement together - change
  // the separator in one and the settler silently stops recognising anything.
  for (const channel of ['shopee', 'tokopedia', 'tiktok_shop', 'shopify']) {
    const customId = customIdFor({ channel, id: '260915X' });
    assert.equal(channelOfCustomId(customId), channel, `${customId} tidak terbaca kembali`);
  }
  // Including a Shopify order name, whose '#' is removed before it is ever a key.
  assert.equal(channelOfCustomId(customIdFor({ channel: 'shopify', id: '#10892' })), 'shopify');
});

test('anything malformed reads as no channel at all', () => {
  // Every one of these must be refused, because the refusal is what keeps the invoice out
  // of the payment run. A regex loosened to "helpfully" match one of them would start
  // paying whatever else it matched too.
  for (const customId of [
    'INV/2026/VIII/001',        // raised by hand inside Jurnal
    '',                          // custom_id null, which the scan passes through as ''
    null,
    undefined,
    'TRL-',                      // truncated
    'TRL-shopee',                // no trailing separator, so no id either
    'TRL-Shopee-260915X',        // capitalised: not a channel name this system uses
    'TRL-shopee2-260915X',       // digits are not part of a channel name
    'lihat TRL-shopee-260915X',  // mentioned inside someone else's reference
    'TRLPAY-TRL-shopee-260915X', // a payment's own key, not an invoice's
    12345,
  ]) {
    assert.equal(channelOfCustomId(customId), null, `${JSON.stringify(customId)} seharusnya tidak dikenali`);
  }
});

/* ------------------------------------- and a refusal must always mean "do not pay this" */

test('an invoice whose channel cannot be read is never marked auto-paid', () => {
  // This is the money-safety property. openInvoices() decides autoPaid from the parsed
  // channel, and an unparsed one has to fail closed: paying an invoice the system cannot
  // even name would be inventing a payment against a receivable nobody is watching.
  for (const customId of ['INV/2026/VIII/001', '', null, 'TRL-', 'TRL-Shopee-X']) {
    const channel = channelOfCustomId(customId);
    assert.equal(channel, null);
    assert.equal(Boolean(channel) && sourceOf({ channel }).autoPaid, false,
      `${JSON.stringify(customId)} tidak boleh dianggap sudah dibayar`);
  }
});

test('the settler pays the platforms that already took the money, and leaves the rest open', async () => {
  // Drives the real openInvoices() off a seeded scan, so this pins the shipped rule and
  // not a restatement of it. Eleven invoices were sitting open like the first three here
  // when MEKARI_DEPOSIT_ACCOUNT was finally set.
  const invoice = (id, customId, remaining) => ({
    id, customId, no: `INV-${id}`, date: '2026-09-10', total: 100_000, remaining,
  });
  await writeDoc(CATALOGUE_PATHNAME, {
    version: 1,
    at: new Date().toISOString(),
    since: null,
    invoices: [
      invoice(1, 'TRL-shopee-260915X', 100_000),
      invoice(2, 'TRL-tiktok_shop-585123', 100_000),
      invoice(3, 'TRL-shopify-10892', 100_000),
      invoice(4, 'INV/2026/VIII/001', 100_000),   // somebody else's invoice
      invoice(5, 'TRL-shopee-260915Y', 0),        // already settled on creation
    ],
  });
  try {
    const open = await openInvoices();
    // A settled invoice is not open, whatever else is true about it.
    assert.deepEqual(open.map((i) => i.id), [1, 2, 3, 4], 'faktur lunas tidak boleh ikut terbaca');

    const paying = open.filter((i) => i.autoPaid).map((i) => i.customId);
    assert.deepEqual(paying, ['TRL-shopee-260915X', 'TRL-tiktok_shop-585123', 'TRL-shopify-10892']);

    const leaving = open.filter((i) => !i.autoPaid).map((i) => i.customId);
    assert.deepEqual(leaving, ['INV/2026/VIII/001'], 'faktur di luar sistem ini tidak boleh dilunasi otomatis');
    assert.equal(open.find((i) => i.id === 4).channel, null);
  } finally {
    await forgetCatalogue();
  }
});

test('a typed-in sale is never auto-paid, whatever its custom_id says', { todo: 'src/mekari/settle.js: channel "manual" resolves to SHF and is auto-paid' }, () => {
  // KNOWN DEFECT, left as a todo rather than a green test because pinning the current
  // answer would punish the fix.
  //
  // settle.js says "a typed-in transaction has no channel in its custom_id and is not ours
  // to settle" - but a manual sale does have one. buildManualOrder sets channel 'manual',
  // so its key is TRL-manual-CS-260916-01 and the regex reads "manual" happily. sourceOf
  // is then called with a channel but no id, orderPrefix's manual branch splits an empty
  // id and falls back to 'SHF', and SHF is auto-paid. So every open consignment, La Brisa,
  // WhatsApp, wholesale and walk-in invoice is a payment waiting to be invented - and
  // those are exactly the sources that are open *because nobody has paid yet*.
  //
  // The fix belongs in settle.js: treat 'manual' as unsettleable alongside an unparsed
  // channel, or pass the code through so sourceOf can read the real prefix.
  for (const customId of [
    'TRL-manual-CS-260916-01',
    'TRL-manual-LB-260916-01',
    'TRL-manual-DP-260916-01',
    'TRL-manual-DW-260916-01',
    'TRL-manual-WS-260916-01',
  ]) {
    const channel = channelOfCustomId(customId);
    assert.equal(Boolean(channel) && sourceOf({ channel }).autoPaid, false,
      `${customId} adalah penjualan yang belum dibayar - melunasinya berarti mengarang pembayaran`);
  }
});
