// Pure tests for src/core/priceScale.ts. The two things that matter are that the
// log round-trips exactly, and that a log axis is labelled in numbers people read
// prices in rather than in log units.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    fromScaleSpace,
    isRepresentable,
    linearTicks,
    logTicks,
    LOG_PRICE_FLOOR,
    priceTicks,
    representableRange,
    toScaleSpace,
} = require('../.test-build/core/priceScale.js');

const near = (actual, expected, what, tolerance = 1e-9) => assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${what}: expected ${expected}, got ${actual}`,
);

test('a linear scale is the identity in both directions', () => {
    for (const price of [0, 1, -5, 106.25, 1e6]) {
        assert.equal(toScaleSpace(price, 'linear'), price);
        assert.equal(fromScaleSpace(price, 'linear'), price);
    }
});

test('a log scale round-trips', () => {
    // The property the whole approach rests on: the transform is affine over
    // log-space, so a price has to come back out of it unchanged.
    for (const price of [0.01, 0.5, 1, 7, 106.25, 1234.5, 98765]) {
        near(fromScaleSpace(toScaleSpace(price, 'log'), 'log'), price, `round trip ${price}`, 1e-12);
    }
});

test('log is monotonic, so a higher price is always higher on the axis', () => {
    // The property that lets an affine transform stand in for a log one at all.
    let previous = -Infinity;
    for (const price of [0.01, 0.1, 1, 10, 100, 1000]) {
        const value = toScaleSpace(price, 'log');
        assert.ok(value > previous, `log went backwards at ${price}`);
        previous = value;
    }
    assert.equal(toScaleSpace(1, 'log'), 0, 'log(1) should be the origin of the axis');
});

test('a non-positive price is clamped on a log axis rather than rejected', () => {
    // The bar still exists; it just has no position, and pinning it to the floor
    // makes that visible instead of silently dropping the bar.
    assert.equal(toScaleSpace(0, 'log'), Math.log(LOG_PRICE_FLOOR));
    assert.equal(toScaleSpace(-100, 'log'), Math.log(LOG_PRICE_FLOOR));
    assert.ok(Number.isNaN(toScaleSpace(Number.NaN, 'log')));
    assert.equal(isRepresentable(0, 'log'), false);
    assert.equal(isRepresentable(0, 'linear'), true, 'a zero price is fine on a linear axis');
    assert.equal(isRepresentable(-1, 'linear'), true);
    assert.equal(isRepresentable(Number.POSITIVE_INFINITY, 'linear'), false);
});

test('a fitted range excludes what the scale cannot show, and says so', () => {
    // Excluding rather than clamping, because a range floored at 1e-9 would crush
    // every real price into the top pixel.
    assert.deepEqual(representableRange(5, 10, 'linear'), [5, 10]);
    assert.deepEqual(representableRange(-5, 10, 'linear'), [-5, 10]);
    assert.deepEqual(representableRange(5, 10, 'log'), [5, 10]);
    assert.equal(representableRange(0, -1, 'log'), null, 'a wholly non-positive log range has no fit');
    assert.equal(representableRange(Number.NaN, 1, 'linear'), null);
});

test('linear ticks are whole multiples of a round step, inside the range', () => {
    const ticks = linearTicks(103.7, 109.4, 6);
    assert.ok(ticks.length >= 4 && ticks.length <= 8, `got ${ticks.length} ticks`);
    for (const tick of ticks) {
        assert.ok(tick.price >= 103.7 && tick.price <= 109.4, `${tick.price} is outside the range`);
    }
    // Round values: the step is a 1/2/5 multiple.
    const step = ticks[1].price - ticks[0].price;
    const normalized = step / Math.pow(10, Math.floor(Math.log10(step)));
    assert.ok([1, 2, 5, 10].includes(normalized), `step ${step} is not a round number`);
});

test('a tradable increment is a floor on the tick step, not a rounding of it', () => {
    // A tick between prices the instrument cannot trade at is a label for nothing,
    // so minStep can push the step up but never divide it down.
    const coarse = linearTicks(1, 10, 20, 1);
    for (let i = 1; i < coarse.length; i++) {
        assert.ok(coarse[i].price - coarse[i - 1].price >= 1 - 1e-9, 'minStep did not hold');
    }
    assert.ok(coarse.length <= 12, `minStep 1 on 1..10 gave ${coarse.length} ticks`);
});

test('log ticks are 1, 2 and 5 within each decade — numbers people price in', () => {
    // Not 1, 2 and 5 *log units*, which would label the axis 2.7, 7.4 and 148.
    const ticks = logTicks(0.5, 5000, 9);
    assert.ok(ticks.length >= 6, `got ${ticks.length} ticks`);
    for (const tick of ticks) {
        assert.ok(tick.price >= 0.5 && tick.price <= 5000, `${tick.price} is outside the range`);
        const mantissa = tick.price / Math.pow(10, Math.floor(Math.log10(tick.price)));
        const rounded = Math.round(mantissa * 100) / 100;
        assert.ok(
            [1, 2, 5].some((m) => Math.abs(rounded - m) < 0.001),
            `${tick.price} has mantissa ${rounded}, expected 1, 2 or 5`,
        );
    }
    // And they include the round numbers a reader expects to see.
    const prices = ticks.map((t) => Math.round(t.price * 1000) / 1000);
    for (const expected of [1, 10, 100, 1000]) {
        assert.ok(prices.some((p) => Math.abs(p - expected) < 0.001), `${expected} is missing from ${JSON.stringify(prices)}`);
    }
});

test('log ticks thin out rather than crowding when too many are asked for', () => {
    const dense = logTicks(1, 100000, 60);
    const sparse = logTicks(1, 100000, 3);
    assert.ok(dense.length <= sparse.length * 3 + 3, 'log ticks did not thin with stride');
    assert.ok(sparse.length >= 1 && sparse.length <= 8, `sparse log axis has ${sparse.length} ticks`);
});

test('a log tick maps to the same scale-space value as the price does', () => {
    // If these disagree the label is beside the wrong gridline, which is the whole
    // failure mode of reusing a linear tick generator on a log axis.
    for (const tick of logTicks(2, 2000, 9)) {
        near(tick.value, toScaleSpace(tick.price, 'log'), `tick ${tick.price}`, 1e-12);
    }
});

test('a degenerate range produces no ticks rather than spinning', () => {
    // Ascending only: a range that is empty, reversed, or not a number has no ticks.
    // A range containing zero, or spanning negative prices, is fine on a linear axis
    // and only that axis, which is the whole reason the two strategies differ.
    for (const [lo, hi] of [[5, 5], [-1, -1], [10, 1], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY]]) {
        assert.deepEqual(linearTicks(lo, hi, 5), [], `linear ${lo}..${hi}`);
    }
    for (const [lo, hi] of [[5, 5], [0, 100], [-5, 100], [100, 1], [Number.NaN, 100], [1, Number.POSITIVE_INFINITY]]) {
        assert.deepEqual(logTicks(lo, hi, 5), [], `log ${lo}..${hi}`);
    }
    assert.ok(linearTicks(0, 10, 5).length > 0, 'a linear axis spanning zero is perfectly valid');
    assert.ok(linearTicks(-5, 5, 5).length > 0, 'a linear axis spanning negative prices is valid');
    assert.deepEqual(logTicks(-5, 5, 5), [], 'and the same range has no log ticks at all');
});

test('priceTicks dispatches to the strategy for the scale in use', () => {
    assert.deepEqual(
        priceTicks(103.7, 109.4, 'linear', 6),
        linearTicks(103.7, 109.4, 6),
    );
    assert.deepEqual(
        priceTicks(0.5, 5000, 'log', 9),
        logTicks(0.5, 5000, 9),
    );
    // And minMove is ignored on a log axis, where it is meaningless: a price format
    // of 0.01 would label an RSI-like axis every hundredth.
    assert.deepEqual(
        priceTicks(0.5, 5000, 'log', 9, 0.01),
        logTicks(0.5, 5000, 9),
    );
});
