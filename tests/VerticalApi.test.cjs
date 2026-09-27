// The vertical public API, tested headlessly.
//
// Every test in this file is about a claim a caller can make and be wrong about. Two of
// them are regressions for defects that shipped: `getPriceRange` read `offsetY` as a
// scale-space value and reported -56732 for a pane showing 106.6 to 111.6, and
// `setPriceRange` moved the model without ever broadcasting a frame, so the chart stayed
// drawn at the old range until the next unrelated pan. Neither had any test, because the
// vertical API had none at all — the horizontal one it mirrors had coverage for several
// phases, and that asymmetry is what let both through.
//
// These run in about a millisecond each. The browser harness still earns its place for
// anything to do with compositing or real input plumbing, but arithmetic and state do not
// belong there.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHeadlessChart, flatCandles } = require('./support/headlessChart.cjs');

/** A chart with data, sized so pane arithmetic is exact. */
function withData(options = {}, { count = 60, start = 100, step = 0.5 } = {}) {
    const harness = createHeadlessChart(options);
    harness.chart.setData(flatCandles(count, { start, step }));
    harness.flush();
    return harness;
}

const close = (actual, expected, tolerance, what) => {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${what}: expected ${expected}, got ${actual} (tolerance ${tolerance})`,
    );
};

test('getPriceRange reports the range the pane is showing', () => {
    const h = withData();
    try {
        const chart = h.chart;
        const { timeAxisHeight } = chart.options().layout;
        const bottom = 600 - timeAxisHeight;
        const atTop = chart.coordinateToPrice(0);
        const atBottom = chart.coordinateToPrice(bottom);
        const [low, high] = chart.getPriceRange();
        close(low, Math.min(atTop, atBottom), 1e-9, 'low');
        close(high, Math.max(atTop, atBottom), 1e-9, 'high');
    } finally {
        h.dispose();
    }
});

test('a set price range reads back exactly, and survives an unrelated options change', () => {
    const h = withData();
    try {
        const chart = h.chart;
        chart.setPriceRange([100, 200]);
        assert.deepEqual(chart.getPriceRange(), [100, 200]);

        // The half-sync this guards: `autoScale` has to go false in the *explicit* options
        // as well as the resolved ones, because `applyOptions` rebuilds the resolved
        // snapshot from the explicit pair. A theme change is the cheapest way to prove
        // it, since it re-resolves everything and touches nothing vertical.
        chart.setTheme('paper');
        assert.deepEqual(chart.getPriceRange(), [100, 200], 'a theme change reverted the lock');
        assert.equal(chart.options().priceScale.autoScale, false);
    } finally {
        h.dispose();
    }
});

test('the transform broadcast to the data layer matches the range the model reports', () => {
    // The assertion that would have caught the unbroadcast lock. The model said one
    // range and the renderer was handed another; every public getter agreed with the
    // model, so nothing that only read getters could see it.
    //
    // The transform is read from the 'viewport' broadcast rather than from a draw call,
    // because that is the only channel a renderer has. `drawCandlesticks` takes no
    // transform — the real renderer holds it from the last broadcast — so a double that
    // only watched draw calls would never have seen a stale one.
    const h = withData();
    try {
        const chart = h.chart;
        const paneHeight = 600 - chart.options().layout.timeAxisHeight;
        const assertAgrees = (what) => {
            const [low, high] = chart.getPriceRange();
            const vertical = h.dataRenderer.lastVertical;
            assert.ok(vertical, `${what}: the data layer was never broadcast a transform`);
            const magnitude = Math.abs(vertical.scaleY);
            assert.ok(magnitude > 0, `${what}: degenerate scaleY ${vertical.scaleY}`);
            // The pane's height in pixels divided by the scale is the span in scale
            // space, which is the reported span on a linear axis.
            close(paneHeight / magnitude, high - low, Math.max(1e-9, (high - low) * 1e-9), `${what}: span`);
        };

        assertAgrees('after fit');
        chart.setPriceRange([100, 200]);
        assertAgrees('after setPriceRange');
        chart.fitPriceRange();
        assertAgrees('after fitPriceRange');
    } finally {
        h.dispose();
    }
});

test('getPaneValueRange(0) and getPriceRange describe the same range', () => {
    const h = withData();
    try {
        const chart = h.chart;
        const compare = (what) => {
            const [low, high] = chart.getPriceRange();
            const pane = chart.getPaneValueRange(0);
            assert.ok(pane, `${what}: pane 0 reported no range`);
            close(pane[0], low, 1e-9, `${what}: pane low`);
            close(pane[1], high, 1e-9, `${what}: pane high`);
        };
        compare('after fit');
        chart.setPriceRange([50, 150]);
        compare('after locking');
    } finally {
        h.dispose();
    }
});

test('fitPriceRange hands the pane back to the auto-scaler', () => {
    const h = withData();
    try {
        const chart = h.chart;
        const fitted = chart.getPriceRange();
        chart.setPriceRange([100, 200]);
        assert.equal(chart.options().priceScale.autoScale, false);
        chart.fitPriceRange();
        assert.equal(chart.options().priceScale.autoScale, true);
        // Back to a fit of the data, so not the range we forced.
        const after = chart.getPriceRange();
        assert.ok(
            Math.abs((after[1] - after[0]) - (fitted[1] - fitted[0])) < 1e-9,
            `expected the original fit ${fitted}, got ${after}`,
        );
    } finally {
        h.dispose();
    }
});

test('a log price range round-trips, and refuses a non-positive low', () => {
    const h = createHeadlessChart({ priceScale: { mode: 'log' } });
    try {
        const chart = h.chart;
        chart.setData(flatCandles(40, { start: 50, step: 1 }));
        h.flush();
        chart.setPriceRange([20, 400]);
        const [low, high] = chart.getPriceRange();
        close(low, 20, 1e-9, 'log low');
        close(high, 400, 1e-6, 'log high');
        assert.throws(() => chart.setPriceRange([0, 100]), /log price scale/);
    } finally {
        h.dispose();
    }
});

test('a drag of the price axis scales the span by the distance travelled', () => {
    const h = withData({}, { start: 100, step: 0.5 });
    try {
        const chart = h.chart;
        const { priceAxisWidth, timeAxisHeight } = chart.options().layout;
        const paneHeight = 600 - timeAxisHeight;
        const axisX = Math.round(priceAxisWidth / 2);
        const midY = Math.round(paneHeight / 2);

        const before = chart.getPriceRange();
        const wanted = 1.5;
        h.pointer('pointerdown', axisX, midY);
        // Read after the press: the baseline is captured there, and nothing has moved
        // yet, so this is the drag's own starting point.
        const baseline = chart.getPriceRange();
        h.pointer('pointermove', axisX, midY + paneHeight * (wanted - 1));
        h.pointer('pointerup', axisX, midY + paneHeight * (wanted - 1));
        const after = chart.getPriceRange();

        close((after[1] - after[0]) / (baseline[1] - baseline[0]), wanted, 1e-9, 'factor');
        close((after[0] + after[1]) / 2, (baseline[0] + baseline[1]) / 2, 1e-9, 'middle held');
        assert.ok(before[1] > before[0], 'sanity: the starting range was ordered');
    } finally {
        h.dispose();
    }
});

test('a press that never travels leaves the scale alone', () => {
    const h = withData();
    try {
        const chart = h.chart;
        const { priceAxisWidth, timeAxisHeight } = chart.options().layout;
        const axisX = Math.round(priceAxisWidth / 2);
        const midY = Math.round((600 - timeAxisHeight) / 2);
        const before = chart.getPriceRange();
        h.drag(axisX, midY, axisX + 1, midY + 1);
        assert.deepEqual(chart.getPriceRange(), before, 'a 1px press moved the range');
        assert.equal(chart.options().priceScale.autoScale, true, 'a 1px press took the lock');
    } finally {
        h.dispose();
    }
});

test('a drag of the price axis does not move the horizontal one', () => {
    const h = withData();
    try {
        const chart = h.chart;
        const { priceAxisWidth, timeAxisHeight } = chart.options().layout;
        const axisX = Math.round(priceAxisWidth / 2);
        const midY = Math.round((600 - timeAxisHeight) / 2);
        const spacingBefore = chart.options().timeScale.barSpacing;
        const offsetBefore = chart.indexToCoordinate(0);
        h.drag(axisX, midY, axisX, midY + 200);
        close(chart.options().timeScale.barSpacing, spacingBefore, 1e-12, 'bar spacing');
        close(chart.indexToCoordinate(0), offsetBefore, 1e-9, 'offsetX');
    } finally {
        h.dispose();
    }
});

test('a drag beside a lower pane does nothing, and the divider is inert', () => {
    // The leak: the gutter runs the full height, so hit-testing it as one strip let a
    // drag beside an oscillator reach up and stretch the price chart. A one-pane chart
    // cannot show this, because there the gutter and the price pane's rows are the same
    // rectangle — which is why the browser suite needs its own two-pane page and this one
    // needs two panes declared.
    const h = createHeadlessChart({ panes: { weights: [3, 1] } });
    try {
        const chart = h.chart;
        chart.setData(flatCandles(60, { start: 100, step: 0.5 }));
        h.flush();
        chart.setOverlays([{
            id: 'osc',
            points: flatCandles(60, { start: 50, step: 0.1 }).map((c) => ({ time: c.time, value: c.close })),
            pane: 1,
        }]);
        h.flush();

        const { priceAxisWidth, timeAxisHeight } = chart.options().layout;
        const separator = chart.options().panes.separatorHeight;
        const plotHeight = 600 - timeAxisHeight;
        const available = plotHeight - separator;
        const priceHeight = Math.round((3 / 4) * available);
        const axisX = Math.round(priceAxisWidth / 2);

        // Read, and a separate reset. These were one function at first, and the reset
        // ran after the drag as well as before it, so every measurement compared
        // [100, 200] with [100, 200] and the case failed for looking inert.
        const read = () => ({
            price: chart.getPriceRange(),
            lower: chart.getPaneValueRange(1),
            offsetX: chart.indexToCoordinate(0),
        });
        const dragAt = (y) => {
            chart.setPriceRange([100, 200]);
            const before = read();
            h.drag(axisX, y, axisX, y + 160);
            return { before, after: read() };
        };

        // Pane 0's rows: the gesture is live.
        const inPrice = dragAt(Math.round(priceHeight / 2));
        assert.ok(
            Math.abs(inPrice.after.price[1] - inPrice.after.price[0]
                - (inPrice.before.price[1] - inPrice.before.price[0])) > 1e-9,
            'a drag in pane 0 rows should scale the price pane',
        );

        // The divider between them belongs to neither.
        const onDivider = dragAt(priceHeight);
        assert.deepEqual(onDivider.after.price, onDivider.before.price, 'the divider was not inert');
        assert.equal(onDivider.after.offsetX, onDivider.before.offsetX, 'the divider panned');

        // Pane 1's rows: nothing at all. Not the price pane, not itself, not a pan.
        const inLower = dragAt(priceHeight + separator + Math.round((available - priceHeight) / 2));
        assert.deepEqual(inLower.after.price, inLower.before.price, 'a lower-pane drag scaled the price chart');
        assert.deepEqual(inLower.after.lower, inLower.before.lower, 'a lower-pane drag scaled its own pane');
        assert.equal(inLower.after.offsetX, inLower.before.offsetX, 'a lower-pane drag panned');

        // The boundary is exact, not merely generous: the last row of pane 0 still works.
        const lastRow = dragAt(priceHeight - 1);
        assert.ok(
            Math.abs(lastRow.after.price[1] - lastRow.after.price[0]
                - (lastRow.before.price[1] - lastRow.before.price[0])) > 1e-9,
            'the last row above the divider should still scale',
        );
    } finally {
        h.dispose();
    }
});

test('a zero-width price axis disables the gesture', () => {
    const h = createHeadlessChart({ layout: { priceAxisWidth: 0 } });
    try {
        const chart = h.chart;
        chart.setData(flatCandles(40, { start: 100, step: 0.5 }));
        h.flush();
        const before = chart.getPriceRange();
        h.drag(0, 300, 0, 450);
        assert.deepEqual(chart.getPriceRange(), before, 'a drag with no gutter moved the range');
    } finally {
        h.dispose();
    }
});

test('a drag of the plot still pans, and leaves a locked price range alone', () => {
    const h = withData();
    try {
        const chart = h.chart;
        const { priceAxisWidth, timeAxisHeight } = chart.options().layout;
        const startX = priceAxisWidth + 100;
        const midY = Math.round((600 - timeAxisHeight) / 2);
        // Locked first, and that is the point. A pan legitimately *does* move the price
        // range while the pane is autoscaling, because it re-fits to the newly visible
        // candles — so "a pan must not change the range" is only a true statement about
        // a pane somebody has already taken ownership of. Asserting it on an autoscaling
        // chart failed here, and was wrong to.
        chart.setPriceRange([100, 200]);
        const offsetBefore = chart.indexToCoordinate(0);
        const rangeBefore = chart.getPriceRange();
        h.drag(startX, midY, startX - 120, midY);
        close(chart.indexToCoordinate(0) - offsetBefore, -120, 1e-9, 'pan distance');
        assert.deepEqual(chart.getPriceRange(), rangeBefore, 'a pan disturbed a locked range');
    } finally {
        h.dispose();
    }
});
