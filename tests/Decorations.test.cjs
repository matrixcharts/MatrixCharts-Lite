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
    resolveZones,
    shouldDrawMarkers,
    ZONE_WEIGHTS,
    zonesWithinBudget,
    zoneStackingOrder,
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
    // A marker is a fixed number of pixels wide, so a screen full of them at 2px
    // per bar is a smear. Dropped rather than shrunk: an unreadable marker is worse
    // than an absent one.
    assert.equal(shouldDrawMarkers(12), true);
    assert.equal(shouldDrawMarkers(4), true);
    assert.equal(shouldDrawMarkers(3.9), false);
    assert.equal(shouldDrawMarkers(0), false);
    assert.equal(shouldDrawMarkers(Number.NaN), false);
});

// --- zones -------------------------------------------------------------------

// Anchor candles with distinguishable bounds, so a test can tell which bar a zone
// took its extent from.
const ohlc = new Map(times.map((time, index) => [time, {
    high: 100 + index,
    low: 90 + index,
    close: 95 + index,
}]));
const candleAt = (index) => ohlc.get(times[index]);
// A stand-in for the library's CSS parser that reports *which* string it was given,
// so a test can tell an override from a default. The real parser is exercised in
// Options.test.cjs.
const PARSED = {
    '#3b82f6': [1, 0.5, 0.2, 1],
    'rgba(1, 2, 3, 0.4)': [1, 2, 3, 0.4],
    'rgba(4, 5, 6, 0.9)': [4, 5, 6, 0.9],
};
const parse = (css) => {
    const found = PARSED[css];
    if (found === undefined) throw new Error(`test parser has no entry for ${css}`);
    return found;
};
const zone = (extra) => resolveZones(
    [{ id: 'z', time: times[4], ...extra }],
    times, candleAt, [0.5, 0.5, 0.5, 1], parse,
);

test('a zone takes its extent from the candle it is anchored to', () => {
    // The caller had a bar and nothing else, and should still get the conventional
    // zone for it rather than being asked for numbers it does not have.
    const resolved = zone({});
    assert.equal(resolved[0].fromIndex, 4);
    assert.equal(resolved[0].top, 104, 'top did not come from the anchor candle high');
    assert.equal(resolved[0].bottom, 94, 'bottom did not come from the anchor candle low');
    assert.equal(resolved[0].toIndex, null, 'a zone without an end should extend right');
    assert.equal(resolved[0].state, 'live');
    assert.equal(resolved[0].borderStyle, 'solid');
    assert.equal(resolved[0].extendLeft, false);
    assert.equal(resolved[0].label, '');
});

test('one colour gives the conventional fill and border pairing', () => {
    // The point of supplying a single colour: the caller should not have to invent
    // two alphas, and the result should be a zone with definition that does not
    // compete with the candles.
    const resolved = zone({ color: '#3b82f6' });
    assert.deepEqual(resolved[0].fill, [1, 0.5, 0.2, ZONE_WEIGHTS.live.fill]);
    assert.deepEqual(resolved[0].border, [1, 0.5, 0.2, ZONE_WEIGHTS.live.border]);
    // The ratio is the whole point: a border that fades with the fill has no
    // definition, which is the washed-out look this decoupling exists to fix.
    assert.ok(
        resolved[0].border[3] > resolved[0].fill[3] * 3,
        `border alpha ${resolved[0].border[3]} is not clearly above fill alpha ${resolved[0].fill[3]}`,
    );
    assert.ok(resolved[0].fill[3] > 0 && resolved[0].fill[3] < 0.2, 'the default fill is not a faint tint');
});

test('fill and border can be overridden independently', () => {
    const resolved = zone({ fill: 'rgba(1, 2, 3, 0.4)', border: 'rgba(4, 5, 6, 0.9)' });
    assert.deepEqual(resolved[0].fill, [1, 2, 3, 0.4]);
    assert.deepEqual(resolved[0].border, [4, 5, 6, 0.9]);
});

test('a mitigated zone fades to a faint dashed outline rather than disappearing', () => {
    const live = zone({})[0];
    const mitigated = zone({ state: 'mitigated' })[0];
    assert.equal(mitigated.fill[3], 0, 'a mitigated zone should have no fill at all');
    assert.equal(mitigated.borderStyle, 'dashed', 'the border, not the hue, carries the state');
    assert.ok(mitigated.border[3] < live.border[3], 'a mitigated zone is not fainter than a live one');
    assert.ok(mitigated.border[3] > 0, 'a mitigated zone still has a visible outline');
    assert.equal(zone({ state: 'invalidated' })[0].borderStyle, 'dashed');
    assert.ok(zone({ state: 'invalidated' })[0].border[3] <= ZONE_WEIGHTS.mitigated.border);
});

test('a zone time between two candles is rejected rather than snapped', () => {
    // The deliberate difference from a marker. A marker is a point, so a bar's
    // error is invisible; a zone's left edge is a boundary, so snapping would move
    // the whole zone by a bar and change which bar it claims to be.
    assert.throws(
        () => resolveZones([{ id: 'z', time: times[4] + 30_000 }], times, candleAt, [1, 1, 1, 1], parse),
        /is not a candle/,
    );
});

test('zone bounds are validated, including an inverted range', () => {
    assert.throws(() => zone({ top: Number.NaN }), /finite top and bottom/);
    assert.throws(() => zone({ top: 90, bottom: 110 }), /below its bottom/);
    assert.doesNotThrow(() => zone({ top: 110, bottom: 110 }));
    assert.doesNotThrow(() => zone({ top: 104, bottom: 100 }));
});

test('a zone may end at a candle, and may not end before it starts', () => {
    assert.equal(zone({ to: times[9] })[0].toIndex, 9);
    assert.throws(() => zone({ to: times[1] }), /ends before it starts/);
    assert.throws(() => zone({ to: times[9] + 30_000 }), /which is not a candle/);
    assert.equal(zone({ to: null })[0].toIndex, null, 'an explicit null still extends right');
});

test('zone ids must be present and unique, and state must be known', () => {
    assert.throws(() => zone({ id: '' }), /non-empty string id/);
    assert.throws(
        () => resolveZones([
            { id: 'a', time: times[1] },
            { id: 'a', time: times[2] },
        ], times, candleAt, [1, 1, 1, 1], parse),
        /used more than once/,
    );
    assert.throws(() => zone({ state: 'stale' }), /expected one of/);
});

test('zones paint invalidated, then mitigated, then live', () => {
    // A mitigated zone must sit under the live ones. A faint dashed outline drawn
    // on top of a live fill puts the quietest thing in the chart over the loudest.
    const built = resolveZones([
        { id: 'live-early', time: times[2] },
        { id: 'mitigated-late', time: times[9], state: 'mitigated' },
        { id: 'invalidated', time: times[1], state: 'invalidated' },
        { id: 'live-late', time: times[8] },
    ], times, candleAt, [1, 1, 1, 1], parse);
    assert.deepEqual(zoneStackingOrder(built).map((z) => z.id), [
        'invalidated', 'mitigated-late', 'live-early', 'live-late',
    ]);
});

test('the drawing budget keeps every live zone and the most recent history', () => {
    // Dropping the oldest *live* zone would drop the most visually dominant thing
    // on the chart, since a live zone extends right across everything.
    const built = resolveZones([
        ...Array.from({ length: 6 }, (_, i) => ({ id: `live-${i}`, time: times[i] })),
        ...Array.from({ length: 6 }, (_, i) => ({
            id: `mit-${i}`, time: times[6 + i], state: 'mitigated',
        })),
    ], times, candleAt, [1, 1, 1, 1], parse);
    const kept = zonesWithinBudget(built, 8);
    const keptIds = kept.map((z) => z.id);
    assert.equal(kept.length, 8);
    for (let i = 0; i < 6; i++) {
        assert.ok(keptIds.includes(`live-${i}`), `live zone live-${i} was dropped`);
    }
    // The two most recent mitigated ones, not the two oldest.
    assert.ok(keptIds.includes('mit-5'), 'the most recent mitigated zone was dropped');
    assert.ok(!keptIds.includes('mit-0'), 'the oldest mitigated zone was kept over a newer one');
    // And the result is still in paint order.
    const firstLive = keptIds.indexOf('live-0');
    const lastMitigated = keptIds.lastIndexOf('mit-5');
    assert.ok(lastMitigated < firstLive, 'a mitigated zone is painting over a live one');
});

test('a chart within budget keeps everything, and a limit of zero keeps nothing', () => {
    const built = zone({});
    assert.deepEqual(zonesWithinBudget(built, 200), built);
    assert.equal(zonesWithinBudget(built, 0).length, 0);
});