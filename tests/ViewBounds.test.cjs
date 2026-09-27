// Chart-level tests for the view bounds and for a collapsed container.
//
// Both of these are about what the chart refuses to do. The first is that the view cannot
// be scrolled out of sight — the drag and pinch paths add a delta to `offsetX` and, with
// nothing bounding them, a chart can be flung arbitrarily far into empty space in either
// direction. The second is that a panel collapsed to nothing stops being drawn into.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createHeadlessChart, flatCandles } = require('./support/headlessChart.cjs');
const { clampOffsetX, PANNING_MARGIN_RATIO, PANNING_MARGIN_SLOTS } = require('../.test-build/core/coordinates.js');
const {
    computeSlotOffsets, resolveSessionBreaks, sizeSessionBreaks, totalSlots,
} = require('../.test-build/core/sessionScale.js');

const PLOT_X = 78;          // the default price gutter
const PLOT_WIDTH = 1200 - PLOT_X;
const MINUTE = 60_000;

function chart(count = 60, options) {
    const harness = createHeadlessChart(options);
    harness.chart.setData(flatCandles(count));
    harness.flush();
    return harness;
}

/**
 * A drag far larger than the plot, in one direction.
 *
 * Far larger than it looks like it needs to be: 300 bars at 14px is 4200px of series, the
 * live edge starts at an offset of about -3000, and the plot is 1122px wide. A 4000px drag
 * to the right therefore leaves bar 0 at x=1000 — still comfortably on screen, and an
 * assertion written against it passes whether or not anything is bounded. Both flings have
 * to overshoot the plot by a wide margin to mean anything.
 */
const fling = (harness, dx) => harness.drag(600, 300, 600 + dx, 300);

// --- the pure bound ---------------------------------------------------------------

/** The effective margin: half the plot, or one bar, whichever is larger. */
const marginFor = (plotWidth, scaleX) =>
    Math.max(PANNING_MARGIN_SLOTS, (plotWidth * PANNING_MARGIN_RATIO) / scaleX);

test('the margin is half the plot, so an ordinary drag never meets it', () => {
    // The number that matters, and the reason the margin is a fraction of the plot rather
    // than a bar. A one-bar margin stopped the series ~14px past the newest candle, so a
    // 220px drag ran into it and the series stopped following the pointer — a chart that
    // does not track 1:1, which is the one property that cannot be traded away.
    const plotWidth = 1122, scaleX = 14;
    const margin = marginFor(plotWidth, scaleX);
    assert.equal(margin, (plotWidth * PANNING_MARGIN_RATIO) / scaleX);
    // In pixels, which is the unit a drag is measured in: half the plot.
    assert.equal(margin * scaleX, plotWidth * PANNING_MARGIN_RATIO);
    // And it never drops below a bar, so a heavily zoomed chart still has somewhere to go.
    assert.equal(marginFor(1122, 2000), PANNING_MARGIN_SLOTS, 'a bar of slack at high zoom');
});

test('the bound is a half-plot of slack past each end', () => {
    // 300 bars at 8px is 2400px of series in a 1000px plot, so the series is *wider* than
    // the plot and the two bounds are ordered: a large negative offset is "scrolled past
    // the newest bar" and a large positive one is "scrolled before the oldest".
    const plotX = 0, plotWidth = 1000, scaleX = 8, count = 300;
    const margin = marginFor(plotWidth, scaleX);
    const pastNewest = clampOffsetX(-1e6, plotX, plotWidth, scaleX, null, count);
    const beforeOldest = clampOffsetX(1e6, plotX, plotWidth, scaleX, null, count);

    assert.equal(pastNewest, plotX + plotWidth - (count + margin) * scaleX);
    assert.equal(beforeOldest, plotX + margin * scaleX);
    assert.ok(pastNewest < beforeOldest, 'a series wider than the plot must have an ordered span');
});

test('a series narrower than the plot may sit anywhere rather than being pinned', () => {
    // The bounds cross when the series fits, and the answer is the span between them. A
    // clamp that picked one edge would take the viewport away from a caller who is
    // deliberately parking the chart in the middle, and would fight every append.
    const plotX = 0, plotWidth = 1000, scaleX = 8, count = 50; // 400px in a 1000px plot
    const margin = marginFor(plotWidth, scaleX);
    assert.equal(clampOffsetX(300, plotX, plotWidth, scaleX, null, count), 300, 'free placement');
    // The two bounds cross here, so the smaller offset is the *newest* end — a more
    // negative offset pushes the content left, which shows later slots. Getting this pair
    // the wrong way round is easy and the failure looks like a clamp that is too tight.
    assert.equal(clampOffsetX(-1e6, plotX, plotWidth, scaleX, null, count), plotX + plotWidth - (count + margin) * scaleX);
    assert.equal(clampOffsetX(1e6, plotX, plotWidth, scaleX, null, count), plotX + margin * scaleX);
});

test('the bound counts a session break, so a gapped series scrolls further', () => {
    // The whole reason the bound is in slots. In index units a chart with an overnight
    // break would be given the same slack as a dense one, and the newest bar would sit
    // short of the edge by the whole of the gap. The scale here keeps the series wider
    // than the plot so the bounds are ordered and the comparison is meaningful.
    const times = [];
    let cursor = Date.UTC(2025, 0, 6, 14, 30);
    for (let bar = 0; bar < 120; bar++) {
        if (bar === 40 || bar === 80) cursor += 17 * 60 * MINUTE;
        times.push(cursor);
        cursor += MINUTE;
    }
    const slots = computeSlotOffsets(times, sizeSessionBreaks(times, resolveSessionBreaks(times, { mode: 'proportional' })));
    const extent = totalSlots(slots);
    const scaleX = 10;
    const margin = marginFor(PLOT_WIDTH, scaleX);
    assert.ok(extent > times.length, 'the fixture needs gaps for this to mean anything');
    assert.ok(extent * scaleX > PLOT_WIDTH, 'the series must be wider than the plot');

    const bound = clampOffsetX(-1e6, PLOT_X, PLOT_WIDTH, scaleX, slots, times.length);
    assert.equal(bound, PLOT_X + PLOT_WIDTH - (extent + margin) * scaleX);
    // The index-space answer would be short by every slot the breaks added, which is the
    // whole distance between these two numbers.
    const inIndexSpace = PLOT_X + PLOT_WIDTH - (times.length + margin) * scaleX;
    assert.ok(bound < inIndexSpace);
    assert.equal(inIndexSpace - bound, (extent - times.length) * scaleX);
});

test('a degenerate input is returned rather than turned into a jump', () => {
    assert.equal(clampOffsetX(123, 0, 1000, 8, null, 0), 123, 'no data');
    assert.equal(clampOffsetX(123, 0, 1000, 0, null, 100), 123, 'a zero scale');
    assert.equal(clampOffsetX(Number.NaN, 0, 1000, 8, null, 100), Number.NaN);
});

// --- through the chart -------------------------------------------------------------

test('a drag cannot fling the chart past the newest bar', () => {
    // The case that was reported. Dragged left, the content moves left and the plot's
    // right edge ends up past the newest bar: the live-edge latch clears and the feed
    // carries on appending into a window nobody is looking at, which is indistinguishable
    // from a dead chart until someone calls `scrollToRealtime()`.
    const harness = chart(300);
    try {
        fling(harness, -6000);
        harness.flush();
        const spacing = harness.chart.getBarSpacing();
        const lastX = harness.chart.indexToCoordinate(299);
        // Dragged left scrolls *past* the newest bar, so what leaves the screen is the
        // oldest end — and past the bound it is the newest bar itself that walks off the
        // left, leaving a plot of clamped nothing. So the assertion is that the newest bar
        // is still on the plot, and within the margin of its right edge.
        assert.ok(lastX >= PLOT_X, `the newest bar is at ${lastX}, off the left of ${PLOT_X}`);
        assert.ok(
            lastX + spacing / 2 <= PLOT_X + PLOT_WIDTH + spacing * (marginFor(PLOT_WIDTH, spacing) + 1),
            `the newest bar is at ${lastX}, beyond the margin past the right edge`,
        );
    } finally {
        harness.dispose();
    }
});

test('a drag cannot fling the chart before the oldest bar', () => {
    // The mirror: dragged right scrolls before the oldest bar, and it is the newest end
    // that walks off the right.
    const harness = chart(300);
    try {
        fling(harness, 6000);
        harness.flush();
        const spacing = harness.chart.getBarSpacing();
        const firstX = harness.chart.indexToCoordinate(0);
        assert.ok(firstX <= PLOT_X + PLOT_WIDTH, `the oldest bar is at ${firstX}, off the right`);
        assert.ok(
            firstX >= PLOT_X - spacing * (marginFor(PLOT_WIDTH, spacing) + 1),
            `the oldest bar is at ${firstX}, beyond the margin before the left edge`,
        );
    } finally {
        harness.dispose();
    }
});

test('a pan tracks the pointer 1:1, and only the last half-screen meets a bound', () => {
    // The property that must not be traded away, and the one a too-tight margin breaks.
    // The interaction harness caught this in a browser: with a one-bar margin a 220px drag
    // moved the series 11.76px. So the invariant here is that an ordinary drag is followed
    // exactly, and only a drag longer than the margin is stopped.
    const harness = chart(300);
    try {
        const before = harness.chart.indexToCoordinate(299);
        fling(harness, -220);
        harness.flush();
        // Negative: the drag is to the left, so the series follows it left by exactly 220px.
        const moved = harness.chart.indexToCoordinate(299) - before;
        assert.ok(Math.abs(moved + 220) < 1e-6, `a 220px drag moved the series ${moved}px`);
    } finally {
        harness.dispose();
    }
});

test('a zoom is not bounded, because its anchor cannot fling the view', () => {
    // The mirror, and the reason the clamp is not on the zoom path. A zoom is anchored on
    // the bar under the pointer, so the anchored bar must stay under the pointer at every
    // step. Clamping it would not prevent a fling — there is none — it would only pull that
    // bar out from under the cursor.
    const harness = chart(300);
    try {
        for (let i = 0; i < 12; i++) {
            const anchorX = PLOT_X + 300;
            const bar = harness.chart.coordinateToNearestIndex(anchorX);
            const before = harness.chart.indexToCoordinate(bar);
            harness.pointer('wheel', anchorX, 300, { deltaY: 120, deltaMode: 0 });
            harness.flush();
            const after = harness.chart.indexToCoordinate(bar);
            // 1px rather than the interaction harness's 0.5px: that limit is on a single
            // step on its own fixture, and this walks twelve of them against a bar chosen
            // by a nearest-index search, so the anchor bar is not the same one each time
            // and the comparison carries a little more float. The point being asserted is
            // that a zoom does not *walk* the anchored bar away, and a bound of a pixel
            // says that with room to spare.
            assert.ok(
                Math.abs(after - before) < 1,
                `zoom step ${i} moved the anchored bar from ${before} to ${after}`,
            );
        }
    } finally {
        harness.dispose();
    }
});

test('zooming out cannot lose the chart off one side', () => {
    // A guard rather than a detector: a zoom keeps the bar under the pointer fixed, so it
    // does not fling the chart anywhere. What is asserted is the property a user would
    // notice — the view is never left showing nothing.
    const harness = chart(300);
    try {
        for (let i = 0; i < 30; i++) {
            harness.pointer('wheel', PLOT_X + 4, 300, { deltaY: 120, deltaMode: 0 });
        }
        harness.flush();
        const range = harness.chart.getVisibleLogicalRange();
        assert.ok(range.from < 300, `zoom left the view entirely after bar ${range.from}`);
        assert.ok(range.to > 0, 'zoom left the view entirely before the series');
    } finally {
        harness.dispose();
    }
});

test('a panned view is not moved by the feed arriving', () => {
    // The reason the bound is on the gesture and not in `updateViewport`. The bound moves
    // whenever the series does, so clamping on every update would pull a chart the caller
    // has taken over sideways every time a bar printed.
    const candles = flatCandles(60);
    const harness = createHeadlessChart();
    try {
        harness.chart.setData(candles);
        harness.flush();
        fling(harness, 300);
        harness.flush();
        assert.equal(harness.chart.isAtRealtime(), false, 'the pan did not take');
        const anchorX = harness.chart.indexToCoordinate(candles.length - 1);

        harness.chart.appendBatch(flatCandles(20, { from: 1_700_000_000_000 + 60 * MINUTE }));
        harness.flush();
        assert.equal(harness.chart.isAtRealtime(), false, 'appending re-latched a panned chart');
        assert.ok(
            Math.abs(harness.chart.indexToCoordinate(candles.length - 1) - anchorX) < 1e-6,
            'appending scrolled a panned view',
        );
    } finally {
        harness.dispose();
    }
});

test('a collapsed container is not drawn into, and is not measured against', () => {
    // A panel taken through zero by a divider drag used to get a frame laid out for the
    // 800x500 fallback geometry, which is how a squeezed pane ended up with a mangled time
    // axis: labels sized for a wide plot, crammed into a fraction of it. Nothing is drawn,
    // and the last frame stays on the canvas because there is nothing better to put there.
    const harness = createHeadlessChart({ dom: { width: 1200, height: 600 } });
    try {
        const wrapper = harness.chart;
        void wrapper;
        harness.chart.setData(flatCandles(200));
        harness.flush();
        const drawn = harness.dataRenderer.calls.length;
        assert.ok(drawn > 0, 'nothing was drawn to begin with');

        // Squeeze it to nothing, the way a divider dragged through zero would.
        const host = harness.dom.container.children[0];
        host.style.width = '0px';
        host.style.height = '0px';
        // The stub reports size from its own fields, so drive those.
        harness.dom.container.style.width = '0px';
        host.width = 0;
        host.height = 0;
        Object.defineProperty(host, 'clientWidth', { value: 0, configurable: true });
        Object.defineProperty(host, 'clientHeight', { value: 0, configurable: true });

        const before = harness.dataRenderer.calls.length;
        harness.flush();
        assert.equal(
            harness.dataRenderer.calls.length,
            before,
            'a collapsed container was still being drawn into',
        );
    } finally {
        harness.dispose();
    }
});
