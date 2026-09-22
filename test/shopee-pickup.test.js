import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shippingMethod, shippingMethods, shipBody, needsPickupTime, defaultSlot, PICKUP, DROPOFF,
} from '../src/shopee/pickup.js';

/** Exactly what the live shop answered on 2026-09-22, trimmed to the fields that matter. */
const DROPOFF_ANSWER = { response: { info_needed: { dropoff: [] }, dropoff: { branch_list: null } } };
const PICKUP_ANSWER = {
  response: {
    info_needed: { pickup: ['address_id', 'pickup_time_id'] },
    pickup: {
      address_list: [{
        address_id: 200380478,
        address: 'Treelogy Regenerative Moringa, Jalan Bumbak, Kerobokan, Kuta',
        address_flag: ['default_address', 'pickup_address'],
        time_slot_list: [
          { date: 1790067600, time_text: 'Now', pickup_time_id: '1790067600_1', flags: ['recommended'] },
          { date: 1790067600, time_text: '10:00 - 11:00', pickup_time_id: '1790067600_6', flags: [] },
        ],
      }],
    },
  },
};

const answering = (byOrder) => async (config, path, auth, params) => {
  assert.equal(path, '/api/v2/logistics/get_shipping_parameter');
  const answer = byOrder[params.order_sn];
  if (!answer) throw new Error(`order ${params.order_sn} tidak dikenal`);
  if (answer instanceof Error) throw answer;
  return answer;
};

test('a regular courier is a drop-off and asks nothing of anybody', async () => {
  const plan = await shippingMethod('260922NKRP97CW', { call: answering({ '260922NKRP97CW': DROPOFF_ANSWER }) });
  assert.equal(plan.method, DROPOFF);
  assert.deepEqual(plan.fields, []);
  assert.equal(plan.branchId, null, 'a null branch_list is no branch, not a crash');
  assert.equal(needsPickupTime(plan), false);
});

test('an instant courier is a pickup, and carries the slots Shopee is offering right now', async () => {
  const plan = await shippingMethod('260922NAX1M1M0', { call: answering({ '260922NAX1M1M0': PICKUP_ANSWER }) });
  assert.equal(plan.method, PICKUP);
  assert.deepEqual(plan.fields, ['address_id', 'pickup_time_id']);
  assert.equal(plan.addressId, 200380478);
  assert.match(plan.address, /Jalan Bumbak/);
  assert.deepEqual(plan.slots, [
    { id: '1790067600_1', text: 'Now', at: 1790067600, recommended: true },
    { id: '1790067600_6', text: '10:00 - 11:00', at: 1790067600, recommended: false },
  ]);
  assert.equal(needsPickupTime(plan), true, 'nothing can be arranged until a slot is chosen');
  assert.equal(defaultSlot(plan).id, '1790067600_1', 'the one Shopee itself recommends');
});

test('a pickup with no slots left is not a question worth asking', async () => {
  const empty = {
    response: {
      info_needed: { pickup: ['address_id', 'pickup_time_id'] },
      pickup: { address_list: [{ address_id: 1, address: 'Gudang', time_slot_list: [] }] },
    },
  };
  const plan = await shippingMethod('X', { call: answering({ X: empty }) });
  assert.equal(needsPickupTime(plan), false);
  assert.equal(defaultSlot(plan), null);
});

test('a method Shopee will not name is recorded, not guessed at', async () => {
  const odd = { response: { info_needed: { non_integrated: [] } } };
  const plan = await shippingMethod('Y', { call: answering({ Y: odd }) });
  assert.equal(plan.method, 'unknown');
  assert.deepEqual(plan.needed, { non_integrated: [] });
  assert.equal(needsPickupTime(plan), false);
});

test('a selection is read order by order, and one refusal costs only that order', async () => {
  const call = answering({
    A: DROPOFF_ANSWER,
    B: PICKUP_ANSWER,
    C: new Error('order tidak bisa dibaca'),
  });
  const plans = await shippingMethods(['A', 'B', 'C', 'B'], { call, concurrency: 2 });
  assert.deepEqual(Object.keys(plans).sort(), ['A', 'B', 'C']);
  assert.equal(plans.A.method, DROPOFF);
  assert.equal(plans.B.method, PICKUP);
  assert.equal(plans.C.method, 'unknown');
  assert.match(plans.C.error, /tidak bisa dibaca/);
});

test('the body says how the parcel is handed over, and refuses a slot that has passed', async () => {
  const dropoff = await shippingMethod('A', { call: answering({ A: DROPOFF_ANSWER }) });
  assert.deepEqual(shipBody('A', dropoff), { order_sn: 'A', dropoff: {} });
  assert.deepEqual(
    shipBody('A', { ...dropoff, fields: ['branch_id'], branchId: 77 }),
    { order_sn: 'A', dropoff: { branch_id: 77 } },
  );

  const pickup = await shippingMethod('B', { call: answering({ B: PICKUP_ANSWER }) });
  // Unasked, the recommended slot stands - which is what the batch fallback relies on.
  assert.deepEqual(shipBody('B', pickup), {
    order_sn: 'B', pickup: { address_id: 200380478, pickup_time_id: '1790067600_1' },
  });
  // Asked, the operator's choice is what is booked.
  assert.deepEqual(shipBody('B', pickup, { pickupTimeId: '1790067600_6' }), {
    order_sn: 'B', pickup: { address_id: 200380478, pickup_time_id: '1790067600_6' },
  });
  // A choice Shopee no longer offers is refused rather than silently turned into "Now":
  // a driver at an unpacked bench is worse than an order that waits for a fresh answer.
  assert.throws(() => shipBody('B', pickup, { pickupTimeId: '1790067600_99' }), /pilih ulang/);

  assert.throws(() => shipBody('C', { method: 'unknown', needed: { non_integrated: [] } }), /tidak menyebut metode/);
  assert.throws(() => shipBody('D', { method: PICKUP, addressId: null }), /alamat pickup/);
});
