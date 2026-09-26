// Pure tests for src/core/decorations.ts. The interesting rules are which label
// survives a collision and where a marker's timestamp actually lands, and both are
// worth pinning down without a browser.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    LABEL_PRIORITY,
    layoutLabels,
    resolveMarkers,
    resolvePriceLines,
    shouldDrawMarkers,
} = require('../.test-build/core/decorations.js');

const color = () => [0, 0, 0, 1];
const times = Array.from({ length: 16 }, (_, i) => Date.UTC(2025, 0, 1) + i * 60_000);

test('price lines take their defaults and are validated', () => {
    const resolved = resolvePriceLines([{ id: 'a', price: 100 }], color);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].lineWidth, 1);
    assert.equal(resolved[0].lineStyle, 'dashed', 'an annotation should not look like the grid');
    assert.equal(resolved[0].axisLabelVisible, true);
    assert.equal(resolved[0].title, '');
    assert.equal(resolved[0].axisLabelColor, null);
});

test('an empty price line set resolves to nothing', () => {
    assert.deepEqual(resolvePriceLines([], color), []);
});

test('price line ids must be present and unique', () => {
    assert.throws(() => resolvePriceLines([{ id: '', price: 1 }], color), /non-empty string id/);
    assert.throws(
        () => resolvePriceLines([{ id: 'a', price: 1 }, { id: 'a', price: 2 }], color),
        /used more than once/,
    );
});

test('a price line with a non-finite price is rejected', () => {
    for (const price of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        assert.throws(() => resolvePriceLines([{ id: 'a', price }], color), /finite price/);
    }
});

test('price line width and style are bounded rather than clamped', () => {
    for (const lineWidth of [0, 0.5, 4.5, Number.NaN, -1]) {
        assert.throws(
            () => resolvePriceLines([{ id: 'a', price: 1, lineWidth }], color),
            /lineWidth/,
            `lineWidth ${lineWidth} was not rejected`,
        );
    }
    assert.equal(resolvePriceLines([{ id: 'a', price: 1, lineWidth: 4 }], color)[0].lineWidth, 4);
    assert.throws(
        () => resolvePriceLines([{ id: 'a', price: 1, lineStyle: 'dotted' }], color),
        /lineStyle/,
    );
});

test('an explicit axis label colour is resolved, and absent stays absent', () => {
    const seen = [];
    const resolved = resolvePriceLines(
        [{ id: 'a', price: 1, color: '#111111', axisLabelColor: '#222222' }],
        (spec, cssColor) => { seen.push(cssColor); return [0, 0, 0, 1]; },
    );
    assert.deepEqual(seen, ['#111111', '#222222']);
    assert.notEqual(resolved[0].axisLabelColor, null);
    assert.equal(resolvePriceLines([{ id: 'a', price: 1, color: '#111111' }], color)[0].axisLabelColor, null);
});

// --- label collision ---------------------------------------------------------

test('labels that do not collide are all kept', () => {
    const keep = layoutLabels([
        { y: 10, priority: LABEL_PRIORITY.tick, height: 14 },
        { y: 100, priority: LABEL_PRIORITY.tick, height: 14 },
        { y: 200, priority: LABEL_PRIORITY.tick, height: 14 },
    ]);
    assert.deepEqual(keep, [true, true, true]);
});

test('a collision is resolved in favour of the caller, not the axis tick', () => {
    // The axis is decoration; a price line is data the caller asked for.
    const keep = layoutLabels([
        { y: 100, priority: LABEL_PRIORITY.tick, height: 14 },
        { y: 103, priority: LABEL_PRIORITY.priceLine, height: 14 },
    ]);
    assert.deepEqual(keep, [false, true]);
});

test('the last price outranks a price line at the same spot', () => {
    const keep = layoutLabels([
        { y: 100, priority: LABEL_PRIORITY.priceLine, height: 14 },
        { y: 100, priority: LABEL_PRIORITY.lastPrice, height: 14 },
    ]);
    assert.deepEqual(keep, [false, true]);
});

test('a kept label displaces anything within its own height, either side', () => {
    // 14px tall labels collide when closer than 14px, so 100 and 113 overlap and
    // 100 and 120 do not.
    assert.deepEqual(layoutLabels([
        { y: 100, priority: 1, height: 14 },
        { y: 113, priority: 1, height: 14 },
    ]), [true, false]);
    assert.deepEqual(layoutLabels([
        { y: 100, priority: 1, height: 14 },
        { y: 120, priority: 1, height: 14 },
    ]), [true, true]);
});

test('a run of crowded labels keeps the first and drops the rest', () => {
    // The result must not depend on which end the crowding is measured from.
    const keep = layoutLabels([100, 102, 104, 106].map((y) => ({ y, priority: 1, height: 14 })));
    assert.equal(keep.filter(Boolean).length, 1);
    assert.equal(keep[0], true);
});

test('a taller label displaces a shorter one it would otherwise clear', () => {
    // A short tick and a tall last-price tag: 8px apart clears an 8px tick but not
    // a 20px tag, because the halves add.
    assert.deepEqual(layoutLabels([
        { y: 100, priority: 0, height: 8 },
        { y: 108, priority: 2, height: 20 },
    ]), [false, true]);
    assert.deepEqual(layoutLabels([
        { y: 100, priority: 0, height: 8 },
        { y: 108, priority: 2, height: 8 },
    ]), [true, true]);
});

test('no labels means nothing to keep', () => {
    assert.deepEqual(layoutLabels([]), []);
});

// --- markers -----------------------------------------------------------------

test('a marker snaps to the nearest candle and reports where it landed', () => {
    // Deliberately between two bars: an annotation placed between candles belongs
    // to whichever bar is closer.
    const between = times[4] + 30_000;
    const resolved = resolveMarkers([{ time: between }], times, color);
    assert.equal(resolved[0].index, 4, 'a time 30s after a bar snapped to the earlier bar');
    const later = times[4] + 45_000;
    assert.equal(resolveMarkers([{ time: later }], times, color)[0].index, 5,
        'a time 45s after a bar snapped to the later bar');
    assert.equal(resolveMarkers([{ time: times[0] - 100_000 }], times, color)[0].index, 0,
        'a time before the series snapped to the first bar');
    assert.equal(resolveMarkers([{ time: times[15] + 100_000 }], times, color)[0].index, 15,
        'a time after the series snapped to the last bar');
    assert.equal(resolveMarkers([{ time: times[7] }], times, color)[0].index, 7, 'an exact time is exact');
});

test('markers take their defaults', () => {
    const resolved = resolveMarkers([{ time: times[0] }], times, color);
    assert.equal(resolved[0].position, 'aboveBar');
    assert.equal(resolved[0].shape, 'arrowUp');
    assert.equal(resolved[0].text, '');
    assert.equal(resolved[0].size, 1);
});

test('a marker with a non-finite time is rejected', () => {
    for (const time of [Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => resolveMarkers([{ time }], times, color), /finite time/);
    }
});

test('marker position, shape, and size are bounded rather than clamped', () => {
    assert.throws(() => resolveMarkers([{ time: times[0], position: 'inside' }], times, color), /position/);
    assert.throws(() => resolveMarkers([{ time: times[0], shape: 'triangle' }], times, color), /shape/);
    for (const size of [0, 0.1, 5, Number.NaN]) {
        assert.throws(() => resolveMarkers([{ time: times[0], size }], times, color), /size/);
    }
    assert.equal(resolveMarkers([{ time: times[0], size: 0.25 }], times, color)[0].size, 0.25);
});

test('markers against an empty series resolve to nothing rather than throwing', () => {
    assert.deepEqual(resolveMarkers([{ time: 1 }], [], color), []);
    assert.deepEqual(resolveMarkers([], times, color), []);
});

test('markers are dropped below a few pixels per bar', () => {
    // A marker is a fixed number of pixels wide, so a screen full of them at 2px
    // per bar is a smear. Dropped rather than shrunk: an unreadable marker is worse
    // than an absent one.
    assert.equal(shouldDrawMarkers(12), true);
    assert.equal(shouldDrawMarkers(4), true);
    assert.equal(shouldDrawMarkers(3.9), false);
    assert.equal(shouldDrawMarkers(0), false);
    assert.equal(shouldDrawMarkers(Number.NaN), false);
});
