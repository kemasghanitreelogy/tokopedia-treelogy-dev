import test from 'node:test';
import assert from 'node:assert/strict';
import { stageOf, summarize, STAGES, CHANNELS } from '../src/omni.js';

test('both platforms collapse onto the same lifecycle stages', () => {
  // TikTok Shop / Tokopedia vocabulary
  assert.equal(stageOf('AWAITING_COLLECTION'), 'to_ship');
  assert.equal(stageOf('IN_TRANSIT'), 'shipping');
  assert.equal(stageOf('DELIVERED'), 'delivered');
  // Shopee vocabulary for the same points in the journey
  assert.equal(stageOf('READY_TO_SHIP'), 'to_ship');
  assert.equal(stageOf('SHIPPED'), 'shipping');
  assert.equal(stageOf('TO_CONFIRM_RECEIVE'), 'shipping');
  assert.equal(stageOf('TO_RETURN'), 'returned');
});

test('every mapped stage is one of the declared stages', () => {
  for (const status of ['UNPAID', 'ON_HOLD', 'PROCESSED', 'IN_CANCEL', 'COMPLETED']) {
    assert.ok(STAGES.includes(stageOf(status)), `${status} -> ${stageOf(status)}`);
  }
});

test('an unknown status degrades to unpaid rather than throwing', () => {
  assert.equal(stageOf('SOMETHING_NEW'), 'unpaid');
});

const order = (channel, status, total) => ({ channel, status, stage: stageOf(status), total });

test('revenue excludes cancelled and returned orders', () => {
  const { all } = summarize([
    order('shopee', 'COMPLETED', 100),
    order('shopee', 'CANCELLED', 999),
    order('shopee', 'TO_RETURN', 500),
  ]);
  assert.equal(all.count, 3);
  assert.equal(all.revenue, 100);
});

test('actionable counts only what a human still has to do', () => {
  const { all } = summarize([
    order('tokopedia', 'UNPAID', 10),
    order('tokopedia', 'READY_TO_SHIP', 10),
    order('tokopedia', 'IN_TRANSIT', 10),
    order('tokopedia', 'COMPLETED', 10),
  ]);
  assert.equal(all.actionable, 2);
});

test('channel buckets stay separate and sum back to the total', () => {
  const orders = [
    order('tokopedia', 'COMPLETED', 100),
    order('tiktok_shop', 'COMPLETED', 200),
    order('shopee', 'COMPLETED', 300),
  ];
  const { all, byChannel } = summarize(orders);
  assert.equal(all.revenue, 600);
  assert.equal(byChannel.tokopedia.revenue, 100);
  assert.equal(byChannel.tiktok_shop.revenue, 200);
  assert.equal(byChannel.shopee.revenue, 300);
  assert.equal(
    Object.values(byChannel).reduce((n, b) => n + b.count, 0),
    all.count,
  );
});

test('every channel has an accent colour for the dashboard', () => {
  for (const [id, meta] of Object.entries(CHANNELS)) {
    assert.equal(meta.id, id);
    assert.match(meta.accent, /^#[0-9A-F]{6}$/i);
  }
});
