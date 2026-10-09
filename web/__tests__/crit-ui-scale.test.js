'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create, KEYS, SCALES } = require('../crit-ui-settings.js');

function root() {
  const props = {};
  return { props, style: { setProperty: (k, v) => { props[k] = v; } } };
}

test('CRIT-03.1 the offered scales are 75, 80, 90, 100, 110 and 125 percent', () => {
  assert.deepEqual(SCALES, [75, 80, 90, 100, 110, 125]);
  assert.ok(KEYS.includes('scale'));
});

test('CRIT-03.1 no stored scale means 100%', () => {
  const store = create({ settings: {} }, {});
  assert.equal(store.scale(), 100);
  const html = root();
  store.applyScale(html);
  assert.equal(html.props['--crit-ui-scale'], '1');
});

test('CRIT-03.2 a stored scale is applied as a CSS zoom factor', () => {
  const html = root();
  create({ settings: { scale: 80 } }, {}).applyScale(html);
  assert.equal(html.props['--crit-ui-scale'], '0.8');
});

for (const bad of [300, 0, -5, 'big', '90', null]) {
  test(`CRIT-03.7 a stored scale of ${JSON.stringify(bad)} shows the page at 100%`, () => {
    const store = create({ settings: { scale: bad } }, {});
    assert.equal(store.scale(), 100);
    const html = root();
    store.applyScale(html);
    assert.equal(html.props['--crit-ui-scale'], '1');
  });
}
