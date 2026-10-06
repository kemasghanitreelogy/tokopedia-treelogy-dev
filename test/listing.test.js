import test from 'node:test';
import assert from 'node:assert/strict';
import { diffPatch, textToHtml, htmlToText, refOf } from '../src/listing.js';

/**
 * Editing a listing from the dashboard sends only what the operator changed.
 *
 * Descriptions are HTML on TikTok and Shopify and plain text on Shopee, and the form is
 * one textarea: rewriting a description nobody touched would flatten its formatting on
 * every channel ticked, for nothing.
 */

const before = { title: 'Kapsul 90', description: 'Baris satu\n\nBaris dua', weightGram: 600, dims: { l: 21, w: 14, h: 8 } };

test('a form submitted unchanged sends nothing', () => {
  assert.deepEqual(diffPatch(before, { title: 'Kapsul 90', description: 'Baris satu\r\n\r\nBaris dua', weightGram: '600', dims: { l: '21', w: '14', h: '8' } }), {});
});

test('only the field that changed is sent', () => {
  assert.deepEqual(diffPatch(before, { title: 'Kapsul 90 caps', description: before.description, weightGram: '600', dims: { l: '21', w: '14', h: '8' } }), { title: 'Kapsul 90 caps' });
  assert.deepEqual(diffPatch(before, { title: before.title, weightGram: '550', dims: { l: '21', w: '14', h: '8' } }), { weightGram: 550 });
  assert.deepEqual(diffPatch(before, { title: before.title, weightGram: '600', dims: { l: '22', w: '14', h: '8' } }), { dims: { l: 22, w: 14, h: 8 } });
});

test('an emptied or impossible field is left alone rather than sent as blank', () => {
  // Clearing a box is not an instruction to blank the listing's title on three channels.
  assert.deepEqual(diffPatch(before, { title: '', description: '  ', weightGram: '', dims: { l: '21', w: '', h: '8' } }), {});
  assert.deepEqual(diffPatch(before, { weightGram: '-5', dims: { l: '0', w: '1', h: '1' } }), {});
});

test('plain text becomes paragraphs, and HTML reads back as the same text', () => {
  const html = textToHtml('Satu\nbaris\n\nDua & <tiga>');
  assert.equal(html, '<p>Satu<br>baris</p><p>Dua &amp; &lt;tiga&gt;</p>');
  assert.equal(htmlToText(html), 'Satu\nbaris\n\nDua & <tiga>');
  assert.equal(htmlToText('<ul><li>a</li><li>b</li></ul>'), '• a\n\n• b');
});

test('each channel is addressed by the ids its own calls need', () => {
  assert.deepEqual(refOf('tiktok', { productId: 'p', skuId: 's' }), { productId: 'p', skuId: 's' });
  assert.deepEqual(refOf('shopee', { itemId: 1, modelId: 2 }), { itemId: 1, modelId: 2 });
  assert.deepEqual(refOf('shopify', { productId: 'gid', variantId: 'v' }), { productId: 'gid', variantId: 'v' });
  assert.equal(refOf('shopee', {}), null);
});
