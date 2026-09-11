import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTS, CATEGORIES, findProduct, isBundle, buildableFrom, groupProducts, unmapped } from '../src/master.js';

test('every product declares a category that exists', () => {
  for (const product of PRODUCTS) {
    assert.ok(Object.hasOwn(CATEGORIES, product.category), `${product.sku} has category ${product.category}`);
  }
});

test('SKUs are unique across the master catalogue, aliases included', () => {
  const seen = new Set();
  for (const product of PRODUCTS) {
    for (const sku of [product.sku, ...(product.aliases ?? [])]) {
      assert.ok(!seen.has(sku), `${sku} is declared twice`);
      seen.add(sku);
    }
  }
});

test('an alias resolves to the same product as its canonical SKU', () => {
  assert.equal(findProduct('GFT-POUCH-001'), findProduct('Travel-Pouch'));
  assert.equal(findProduct('GFT-MYST-001'), findProduct('Mystery-Gift'));
  assert.equal(findProduct('tidak-ada'), null);
});

test('every bundle component refers to a real master product', () => {
  for (const product of PRODUCTS.filter(isBundle)) {
    for (const component of product.components) {
      assert.ok(findProduct(component.sku), `${product.sku} needs unknown component ${component.sku}`);
      assert.ok(component.qty > 0, `${product.sku} component ${component.sku} has no quantity`);
    }
  }
});

test('no bundle contains itself, directly or through a component', () => {
  for (const product of PRODUCTS.filter(isBundle)) {
    const seen = new Set([product.sku]);
    const walk = (sku) => {
      const node = findProduct(sku);
      for (const component of node?.components ?? []) {
        assert.ok(!seen.has(component.sku), `${product.sku} is cyclic through ${component.sku}`);
        seen.add(component.sku);
        walk(component.sku);
      }
    };
    walk(product.sku);
  }
});

test('buildable is the tightest component constraint', () => {
  const product = findProduct('MRS-002'); // Ritual Set + Powder 45g
  const build = buildableFrom(product, (sku) => ({ 'MRS-001': 74, 'OMP-45-001': 117 })[sku] ?? null);
  assert.equal(build.buildable, 74);
});

test('a component needed more than once divides the availability', () => {
  const build = buildableFrom(
    { components: [{ sku: 'X', qty: 3 }] },
    () => 10,
  );
  assert.equal(build.buildable, 3);
});

test('an unknown component makes the answer unknown, not optimistic', () => {
  // Reporting a number derived from only the visible parts would overstate what can ship.
  const build = buildableFrom(
    { components: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 1 }] },
    (sku) => (sku === 'A' ? 50 : null),
  );
  assert.equal(build.buildable, null);
  assert.equal(build.unknown, true);
});

test('a non-bundle has nothing to build', () => {
  assert.equal(buildableFrom(findProduct('OMP-45-001'), () => 10), null);
});

test('grouping keeps declaration order and drops empty categories', () => {
  const groups = groupProducts();
  assert.deepEqual(groups.map((g) => g.key), Object.keys(CATEGORIES).filter((k) => PRODUCTS.some((p) => p.category === k)));
  for (const group of groups) assert.ok(group.items.length > 0);
});

test('channel SKUs with no master entry are reported as drift', () => {
  const drift = unmapped([{ sku: 'OMP-45-001' }, { sku: 'TIDAK-DIKENAL' }]);
  assert.deepEqual(drift.map((d) => d.sku), ['TIDAK-DIKENAL']);
});
