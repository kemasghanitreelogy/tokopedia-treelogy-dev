import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signPublic, signShop, buildPublicUrl, buildShopUrl } from '../src/shopee/sign.js';

const config = { partnerId: 1243465, partnerKey: 'test-key', host: 'https://partner.test-stable.shopeemobile.com' };
const hex = (base) => crypto.createHmac('sha256', config.partnerKey).update(base).digest('hex');

test('public sign covers partner_id + path + timestamp only', () => {
  const path = '/api/v2/auth/token/get';
  assert.equal(
    signPublic({ ...config, path, timestamp: 1700000000 }),
    hex('1243465/api/v2/auth/token/get1700000000'),
  );
});

test('shop sign appends access_token and shop_id', () => {
  const path = '/api/v2/shop/get_shop_info';
  assert.equal(
    signShop({ ...config, path, timestamp: 1700000000, accessToken: 'tok', shopId: '999' }),
    hex('1243465/api/v2/shop/get_shop_info1700000000tok999'),
  );
});

test('public url carries partner_id, timestamp, sign and extras', () => {
  const url = new URL(buildPublicUrl(config, '/api/v2/shop/auth_partner', { redirect: 'https://x.test/cb' }));
  assert.equal(url.origin + url.pathname, `${config.host}/api/v2/shop/auth_partner`);
  assert.equal(url.searchParams.get('partner_id'), '1243465');
  assert.equal(url.searchParams.get('redirect'), 'https://x.test/cb');
  const ts = url.searchParams.get('timestamp');
  assert.equal(url.searchParams.get('sign'), hex(`1243465/api/v2/shop/auth_partner${ts}`));
});

test('shop url signs with the token it sends', () => {
  const url = new URL(buildShopUrl(config, '/api/v2/order/get_order_list', { accessToken: 'tok', shopId: '999' }, { page_size: 50 }));
  const ts = url.searchParams.get('timestamp');
  assert.equal(url.searchParams.get('access_token'), 'tok');
  assert.equal(url.searchParams.get('shop_id'), '999');
  assert.equal(url.searchParams.get('page_size'), '50');
  assert.equal(url.searchParams.get('sign'), hex(`1243465/api/v2/order/get_order_list${ts}tok999`));
});
