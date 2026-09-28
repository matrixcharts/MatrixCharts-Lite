// Pure geometry tests for src/core/coordinates.ts. No DOM, no canvas, no
// chart: these are the formulas the renderer draws with and the public read API
// reports, so a change here has to be deliberate.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    BAR_SPACING_EPSILON,
    LIVE_EDGE_INSET,
    clampCandleIndex,
    coordinateToIndex,
    coordinateToPrice,
    fullPlotRect,
    indexToCoordinate,
    isAtLiveEdgeOffset,
    isSameVisibleRange,
    liveEdgeOffsetX,
    nearestCandleIndex,
    nearestCandleIndexByTime,
    plotCentreX,
    plotRight,
    priceToCoordinate,
    slotToCoordinate,
    visibleLogicalRange,
    visiblePriceRange,
} = require('../.test-build/core/coordinates.js');

// The plot rect defaults to the canvas and follows any cssWidth/cssHeight
// override, because that is the chart's default layout: nothing is reserved for
// the axes. A test that narrows the canvas must narrow the plot with it, or it is
// no longer describing a chart that exists.
// `slots: null` is the identity — an unbroken series — and is stated rather than
// left out, so a literal that forgets the field is a missing table rather than an
// absent one. The two read the same at runtime; the distinction is worth keeping in
// the test source, because the runtime cannot tell them apart and can therefore not
// defend against getting it wrong.
const viewport = (overrides = {}) => {
    const base = {
        offsetX: 0,
        offsetY: 0,
        scaleX: 8,
        scaleY: -2,
        cssWidth: 800,
        cssHeight: 500,
        slots: null,
        ...overrides,
    };
    return {
        ...base,
        plot: overrides.plot ?? { x: 0, y: 0, width: base.cssWidth, height: base.cssHeight },
    };
};

/** A viewport whose plot is inset, as it would be with axis gutters reserved. */
const insetViewport = (overrides = {}) => viewport({
    cssWidth: 800,
    cssHeight: 500,
    ...overrides,
    plot: overrides.plot ?? { x: 70, y: 12, width: 730, height: 470 },
});

const closeTo = (actual, expected, message) => {
    assert.ok(
        Math.abs(actual - expected) < 1e-9,
        `${message ?? ''} expected ${actual} to be within 1e-9 of ${expected}`,
    );
};

test('index and coordinate conversions invert each other', () => {
    const view = viewport({ offsetX: -120, scaleX: 6.5 });
    for (let index = 0; index <= 200; index += 7) {
        closeTo(coordinateToIndex(view, indexToCoordinate(view, index)), index, `index ${index}`);
    }
    for (const x of [0, 1, 137.5, 799, 1200]) {
        closeTo(indexToCoordinate(view, coordinateToIndex(view, x)), x, `x ${x}`);
    }
});

test('index coordinates extrapolate through session whitespace', () => {
    const view = viewport({
        offsetX: 10,
        scaleX: 8,
        slots: Float64Array.from([0, 1, 2, 5, 6]),
    });
    closeTo(indexToCoordinate(view, -2), 10 - 12, 'before the first candle');
    closeTo(indexToCoordinate(view, 99), 10 + (6 + 95.5) * 8, 'after the last candle');
    closeTo(slotToCoordinate(view, 7.25), 68, 'fractional slot inverse');
});

test('price and coordinate conversions invert each other', () => {
    const view = viewport({ offsetY: 1200, scaleY: -3.25 });
    for (let price = -500; price <= 500; price += 37) {
        closeTo(coordinateToPrice(view, priceToCoordinate(view, price)), price, `price ${price}`);
    }
    for (const y of [0, 42.25, 499, 900]) {
        closeTo(priceToCoordinate(view, coordinateToPrice(view, y)), y, `y ${y}`);
    }
});

test('the default plot rect is the whole canvas', () => {
    // The geometry here is layout-independent: it is the consumer functions that
    // must read the plot rect rather than the canvas. fullPlotRect is the
    // no-gutter case, kept as a named constructor for tests and for callers that
    // genuinely want an un-inset rect.
    assert.deepEqual(fullPlotRect(800, 500), { x: 0, y: 0, width: 800, height: 500 });
    const view = viewport();
    assert.equal(plotRight(view), view.cssWidth);
    assert.equal(plotCentreX(view), view.cssWidth / 2);
    assert.deepEqual(visibleLogicalRange(view, 100), { from: 0, to: 100 });
    // offsetY 1000 at -2 px per unit puts price 500 at the top and 250 at the bottom.
    assert.deepEqual(visiblePriceRange(viewport({ offsetY: 1000 })), [250, 500]);
    assert.equal(liveEdgeOffsetX(plotRight(view), null, 10, 8), 800 - 9.5 * 8);
});

test('an inset plot rect narrows the visible range without moving the transform', () => {
    // A left gutter hides bars, but the data transform stays anchored to the same
    // offsetX/scaleX: the plot rect says what is visible, not where data lives.
    const plain = viewport({ offsetX: 0, scaleX: 10 });
    const inset = insetViewport({ offsetX: 0, scaleX: 10 });

    // `to` is 80, and the boundary is the whole reason. The plot's right edge sits at
    // exactly slot 80, and bars are positioned by their left edge, so bar 80 starts
    // where the plot ends and has no width on screen. It is excluded, and 79 is the
    // last bar drawn. The two ends of the range round differently for this reason:
    // a bar clipped on the left counts, a bar starting on the right does not.
    assert.deepEqual(visibleLogicalRange(plain, 200), { from: 0, to: 80 });
    // Plot x 70 at 10px per bar starts at index 7; plot right 800 still ends at 80.
    assert.deepEqual(visibleLogicalRange(inset, 200), { from: 7, to: 80 });

    assert.equal(indexToCoordinate(plain, 10), indexToCoordinate(inset, 10));
    assert.equal(indexToCoordinate(inset, 10), 100);
    assert.equal(nearestCandleIndex(inset, 100, 200), 10);
});

test('an inset plot rect bounds the visible price range to the plot', () => {
    const plain = viewport({ offsetY: 1000, scaleY: -2 });
    const inset = insetViewport({ offsetY: 1000, scaleY: -2 });

    // Plot top is 12, bottom is 12 + 470 = 482.
    assert.deepEqual(visiblePriceRange(inset), [259, 494]);
    // The canvas edges lie outside the plot, so they are not the visible bounds.
    assert.deepEqual(visiblePriceRange(plain), [250, 500]);
    // price 400 still maps to the same y: the transform did not move.
    assert.equal(priceToCoordinate(inset, 400), priceToCoordinate(plain, 400));
});

test('an empty or degenerate plot rect reports empty ranges rather than throwing', () => {
    const collapsed = viewport({ plot: { x: 0, y: 0, width: 0, height: 0 } });
    assert.deepEqual(visibleLogicalRange(collapsed, 50), { from: 0, to: 0 });
    // A zero-height plot divides to -0. That is not an error, so the assertion
    // checks magnitude rather than the sign of zero.
    const collapsedRange = visiblePriceRange(collapsed);
    assert.equal(collapsedRange.length, 2);
    assert.ok(Math.abs(collapsedRange[0]) === 0, `low was ${collapsedRange[0]}`);
    assert.ok(Math.abs(collapsedRange[1]) === 0, `high was ${collapsedRange[1]}`);
});

test('the live edge is an absolute plot edge, not a width', () => {
    // A left gutter shifts the plot right, so the live edge has to move with it.
    // Passing the plot width instead of its right edge would park the newest bar
    // 70px short, which is the bug this pins.
    const scaleX = 8;
    const count = 20;
    const right = 70 + 730;
    const offset = liveEdgeOffsetX(right, null, count, scaleX);
    assert.equal(indexToCoordinate(insetViewport({ offsetX: offset, scaleX }), count - 1), right - 4);
    assert.equal(isAtLiveEdgeOffset(offset, scaleX, null, count, right), true);
    // The stale width-based value is genuinely short, and is not at the edge.
    const widthBased = liveEdgeOffsetX(730, null, count, scaleX);
    assert.equal(indexToCoordinate(insetViewport({ offsetX: widthBased, scaleX }), count - 1), right - 4 - 70);
    assert.equal(isAtLiveEdgeOffset(widthBased, scaleX, null, count, right), false);
});

test('conversions are identical at dpr 1 and dpr 2', () => {
    // Nothing in the transform may depend on the backing-store scale. Renderers
    // apply dpr; every conversion below stays in CSS pixels.
    for (const dpr of [1, 2, 3]) {
        const backingWidth = 800 * dpr;
        const view = viewport({ offsetX: -45, offsetY: 700, scaleX: 9, scaleY: -1.5 });
        const cssX = indexToCoordinate(view, 42);
        const backingX = cssX * dpr;

        // Round-trip through the backing store, as a renderer would.
        closeTo(coordinateToIndex(view, backingX / dpr), 42, `index at dpr ${dpr}`);
        assert.equal(cssX, 42 * 9 - 45, `css x is dpr independent at dpr ${dpr}`);
        assert.equal(backingX, cssX * dpr, `backing x scales at dpr ${dpr}`);
        assert.equal(backingWidth, 800 * dpr);
    }
});

test('nearest index snaps by distance and clamps to the series', () => {
    const view = viewport({ offsetX: 0, scaleX: 10 });
    assert.equal(nearestCandleIndex(view, 0, 5), 0);
    assert.equal(nearestCandleIndex(view, 4, 5), 0);
    assert.equal(nearestCandleIndex(view, 6, 5), 1);
    assert.equal(nearestCandleIndex(view, 15, 5), 2);
    // Rounding is half-up, so 5.5 belongs to index 1.
    assert.equal(nearestCandleIndex(view, 5, 5), 1);
    assert.equal(nearestCandleIndex(view, 15.5, 5), 2);
    // Off either end of the series.
    assert.equal(nearestCandleIndex(view, -500, 5), 0);
    assert.equal(nearestCandleIndex(view, 5000, 5), 4);
    assert.equal(nearestCandleIndex(view, 100, 0), -1);
});

test('clampCandleIndex stays inside the series for any input', () => {
    assert.equal(clampCandleIndex(-10, 4), 0);
    assert.equal(clampCandleIndex(10, 4), 3);
    assert.equal(clampCandleIndex(2.4, 4), 2);
    assert.equal(clampCandleIndex(2.6, 4), 3);
});

test('visible range is half-open and includes partial bars', () => {
    // Ten bars of 8px starting at x=0, 800px wide: bars span 0..80, all visible.
    assert.deepEqual(visibleLogicalRange(viewport(), 10), { from: 0, to: 10 });

    // A 75px window ends mid-bar, and that partial bar still counts.
    // lastPartial = 75/8 = 9.375 -> ceil 10.
    const partial = viewport({ cssWidth: 75 });
    assert.deepEqual(visibleLogicalRange(partial, 10), { from: 0, to: 10 });

    // Scrolled right by two bars the series spans 16..96, still inside 0..800.
    assert.deepEqual(visibleLogicalRange(viewport({ offsetX: 16 }), 10), { from: 0, to: 10 });

    // An 8px window over a series starting at x=-4: bar 0 is clipped in half but
    // still counts. firstPartial = 0.5 -> 0, lastPartial = 1.5 -> 2.
    const clipped = viewport({ offsetX: -4, scaleX: 8, cssWidth: 8 });
    assert.deepEqual(visibleLogicalRange(clipped, 10), { from: 0, to: 2 });
});

test('visible range includes the newest candle at the live edge', () => {
    const count = 120;
    const scaleX = 7;
    const offsetX = liveEdgeOffsetX(800, null, count, scaleX);

    // The live edge insets the last bar by half a bar, so it is fully on screen.
    closeTo(offsetX, 800 - (count - LIVE_EDGE_INSET) * scaleX, 'live edge offset');
    const range = visibleLogicalRange(viewport({ offsetX, scaleX }), count);
    assert.equal(range.to, count, 'the newest candle must be visible at the live edge');
    // offsetX = -36.5, so firstPartial = 36.5/7 = 5.2143 -> floor 5.
    assert.equal(range.from, Math.floor(count - LIVE_EDGE_INSET - 800 / scaleX), 'leftmost visible bar');
    assert.equal(range.from, 5);
});

test('visible range is empty when scrolled off the live edge', () => {
    const count = 10;
    const scaleX = 8;
    // The window 0..800 sits entirely past the series, which ends at 980.
    // firstPartial = -112.5, lastPartial = -12.5, so nothing is on screen.
    assert.deepEqual(visibleLogicalRange(viewport({ offsetX: 900, scaleX, cssWidth: 800 }), count), { from: 0, to: 0 });
    // The window sits entirely before the series, which starts at -180.
    // firstPartial = 22.5, lastPartial = 122.5, both past the last index.
    assert.deepEqual(visibleLogicalRange(viewport({ offsetX: -180, scaleX, cssWidth: 800 }), count), { from: 10, to: 10 });
});

test('visible range is empty for an empty series', () => {
    assert.deepEqual(visibleLogicalRange(viewport(), 0), { from: 0, to: 0 });
    assert.deepEqual(visibleLogicalRange(viewport({ cssWidth: 0 }), 0), { from: 0, to: 0 });
});

test('visible range covers a single candle from either side', () => {
    const view = viewport({ offsetX: -4, scaleX: 8 });
    assert.deepEqual(visibleLogicalRange(view, 1), { from: 0, to: 1 });
    // Scrolled so the only candle is just off the left edge.
    assert.deepEqual(visibleLogicalRange(viewport({ offsetX: -20, scaleX: 8 }), 1), { from: 1, to: 1 });
    // Pinned at the live edge.
    const edge = viewport({ offsetX: liveEdgeOffsetX(800, null, 1, 8), scaleX: 8 });
    assert.deepEqual(visibleLogicalRange(edge, 1), { from: 0, to: 1 });
});

test('visible range never inverts when the window is narrower than a bar', () => {
    const view = viewport({ offsetX: -3.5, scaleX: 8, cssWidth: 2 });
    const range = visibleLogicalRange(view, 10);
    assert.ok(range.to >= range.from, 'to must be at least from');
    assert.ok(range.from >= 0 && range.to <= 10, 'range stays inside the series');
});

test('visible price range is ordered low to high', () => {
    const rising = viewport({ scaleY: -2, offsetY: 1000 });
    const [low, high] = visiblePriceRange(rising);
    assert.equal(low, 250, 'price at the bottom edge');
    assert.equal(high, 500, 'price at the top edge');
    assert.ok(low < high);

    // An inverted scale must still report low first.
    const inverted = viewport({ scaleY: 2, offsetY: 100 });
    const [invertedLow, invertedHigh] = visiblePriceRange(inverted);
    assert.ok(invertedLow < invertedHigh, 'low is first even when scaleY is positive');
    assert.equal(invertedLow, -50);
    assert.equal(invertedHigh, 200);
});

test('live edge detection tolerates a drag but not a real pan', () => {
    const count = 100;
    const scaleX = 8;
    const cssWidth = 800;
    const edgeOffset = liveEdgeOffsetX(cssWidth, null, count, scaleX);

    assert.equal(isAtLiveEdgeOffset(edgeOffset, scaleX, null, count, cssWidth), true);
    // Dragging the last bar anywhere within the tolerance still counts as live.
    assert.equal(isAtLiveEdgeOffset(edgeOffset - 20, scaleX, null, count, cssWidth), true);
    assert.equal(isAtLiveEdgeOffset(edgeOffset + 20, scaleX, null, count, cssWidth), true);
    // A real pan out of the tolerance does not.
    assert.equal(isAtLiveEdgeOffset(edgeOffset - 200, scaleX, null, count, cssWidth), false);
    assert.equal(isAtLiveEdgeOffset(edgeOffset + 400, scaleX, null, count, cssWidth), false);
    // An empty series is trivially at the live edge.
    assert.equal(isAtLiveEdgeOffset(12345, scaleX, null, 0, cssWidth), true);
});

test('live edge offset is monotonic in bar count and spacing', () => {
    const base = liveEdgeOffsetX(800, null, 100, 8);
    // Appending a bar while following keeps the last bar parked at the edge.
    const appended = liveEdgeOffsetX(800, null, 101, 8);
    assert.equal(base - appended, 8, 'one bar of spacing per appended candle');
    assert.ok(liveEdgeOffsetX(800, null, 100, 16) < base, 'wider bars park further left');
});

test('time lookup picks the nearest timestamp without interpolating a gap', () => {
    // A session gap: bars at 1s and 2s, then nothing until 300s.
    const times = [1_000, 2_000, 300_000, 400_000];
    const at = (time) => nearestCandleIndexByTime(times.length, time, (index) => times[index]);

    assert.equal(at(1_000), 0);
    assert.equal(at(1_400), 0);
    assert.equal(at(1_600), 1);
    assert.equal(at(2_000), 1);
    // The gap midpoint is 151s. A time on either side snaps to the closer real
    // bar and never to an interpolated position between them.
    assert.equal(at(150_000), 1, 'just below the midpoint keeps the earlier bar');
    assert.equal(at(152_000), 2, 'just above the midpoint moves to the later bar');
    assert.equal(at(299_999), 2);
    assert.equal(at(300_001), 2);
    // Outside the series clamps to the ends.
    assert.equal(at(0), 0);
    assert.equal(at(-999_999), 0);
    assert.equal(at(10_000_000), 3);
});

test('time lookup honours a start offset and rejects an empty range', () => {
    const times = [10, 20, 30, 40, 50];
    const at = (time) => nearestCandleIndexByTime(5, time, (index) => times[index], 2);

    assert.equal(at(10), 2, 'times before the start are clamped in');
    assert.equal(at(38), 3);
    assert.equal(at(50), 4);
    // An exact tie resolves to the earlier candle, so a lookup is deterministic.
    assert.equal(at(35), 2);
    assert.equal(nearestCandleIndexByTime(0, 10, (index) => times[index]), -1);
    assert.equal(nearestCandleIndexByTime(2, 10, (index) => times[index], 2), -1);
});

test('time lookup agrees with itself across a long series', () => {
    const count = 5000;
    const times = Array.from({ length: count }, (_, index) => index * 60_000);
    const at = (time) => nearestCandleIndexByTime(count, time, (index) => times[index]);

    for (const index of [0, 1, 17, 2500, count - 2, count - 1]) {
        assert.equal(at(times[index]), index, `exact hit at ${index}`);
    }
    // Halfway between two samples goes to the earlier one, consistently.
    assert.equal(at(times[100] + 30_000), 100);
    assert.equal(at(times[100] + 30_001), 101);
});

test('an unseen viewport always counts as changed', () => {
    assert.equal(isSameVisibleRange(null, { from: 0, to: 10 }, 8), false);
});

test('an identical logical range and spacing counts as unchanged', () => {
    const previous = { logical: { from: 4, to: 20 }, barSpacing: 8 };
    assert.equal(isSameVisibleRange(previous, { from: 4, to: 20 }, 8), true);
    // A fresh object with equal contents is still unchanged.
    assert.equal(isSameVisibleRange(previous, { from: 4, to: 20 }, 8), true);
});

test('either edge moving makes the range changed', () => {
    const previous = { logical: { from: 4, to: 20 }, barSpacing: 8 };
    assert.equal(isSameVisibleRange(previous, { from: 3, to: 20 }, 8), false, 'left edge');
    assert.equal(isSameVisibleRange(previous, { from: 4, to: 21 }, 8), false, 'right edge');
    assert.equal(isSameVisibleRange(previous, { from: 5, to: 19 }, 8), false, 'both edges');
});

test('bar spacing within the epsilon counts as unchanged', () => {
    const previous = { logical: { from: 4, to: 20 }, barSpacing: 8 };
    // Float drift from repeated wheel or pinch arithmetic must stay silent.
    assert.equal(isSameVisibleRange(previous, { from: 4, to: 20 }, 8 + BAR_SPACING_EPSILON / 2), true);
    assert.equal(isSameVisibleRange(previous, { from: 4, to: 20 }, 8 - BAR_SPACING_EPSILON / 2), true);
    // A real zoom step is far larger than the epsilon.
    assert.equal(isSameVisibleRange(previous, { from: 4, to: 20 }, 8 * 1.1), false);
    assert.equal(isSameVisibleRange(previous, { from: 4, to: 20 }, 8 / 1.1), false);
});

test('panning inside one bar can leave the visible range untouched', () => {
    // 8px bars in a 128px window. The visible set only changes when a pan moves
    // an edge across a bar boundary, which is sticky because the left edge floors
    // and the right edge ceils. Between boundaries a multi-pixel drag is silent.
    const viewport = (offsetX) => ({
        offsetX, offsetY: 0, scaleX: 8, scaleY: -2, slots: null, cssWidth: 128, cssHeight: 400,
        plot: { x: 0, y: 0, width: 128, height: 400 },
    });
    assert.deepEqual(visibleLogicalRange(viewport(-35), 100), { from: 4, to: 21 });
    assert.deepEqual(visibleLogicalRange(viewport(-38), 100), { from: 4, to: 21 });

    const before = { logical: visibleLogicalRange(viewport(-35), 100), barSpacing: 8 };
    assert.equal(isSameVisibleRange(before, visibleLogicalRange(viewport(-38), 100), 8), true);

    // Crossing a boundary does change it: one more bar peeks in at the right.
    assert.deepEqual(visibleLogicalRange(viewport(-32), 100), { from: 4, to: 20 });
    assert.equal(isSameVisibleRange(before, visibleLogicalRange(viewport(-32), 100), 8), false);
});

test('the epsilon is small enough to never hide a real bar change', () => {
    // One pixel at the widest supported spacing must still register.
    const previous = { logical: { from: 0, to: 1 }, barSpacing: 10_000 };
    assert.equal(isSameVisibleRange(previous, { from: 0, to: 1 }, 10_000 + 1), false);
    assert.ok(BAR_SPACING_EPSILON < 1e-4, 'epsilon must stay well under a pixel of drift');
});
