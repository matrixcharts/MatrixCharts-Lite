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

/** A two-pane chart with an oscillator in the lower one, plus its exact row geometry. */
function twoPaneChart(options = {}) {
    const h = createHeadlessChart({ panes: { weights: [3, 1] }, ...options });
    h.chart.setData(flatCandles(60, { start: 100, step: 0.5 }));
    h.flush();
    const points = flatCandles(60, { start: 50, step: 0.1 }).map((c) => ({ time: c.time, value: c.close }));
    h.chart.setOverlays([{ id: 'osc', points, pane: 1 }]);
    h.flush();

    const { priceAxisWidth, timeAxisHeight } = h.chart.options().layout;
    const separator = h.chart.options().panes.separatorHeight;
    const plotHeight = 600 - timeAxisHeight;
    const available = plotHeight - separator;
    const priceHeight = Math.round((3 / 4) * available);
    return {
        h,
        separator,
        axisX: Math.round(priceAxisWidth / 2),
        // The rows themselves, recomputed here rather than read back from the chart, so
        // the test states where it thinks the boundaries are and the chart has to agree.
        paneRows: [
            { top: 0, bottom: priceHeight },
            { top: priceHeight + separator, bottom: plotHeight },
        ],
    };
}

test('a drag in a lower pane scales that pane and leaves the price pane fitting', () => {
    const { h, axisX, paneRows } = twoPaneChart();
    try {
        const chart = h.chart;
        const priceBefore = chart.getPriceRange();
        const lowerBefore = chart.getPaneValueRange(1);
        assert.equal(chart.options().priceScale.autoScale, true, 'precondition');

        // One pixel inside pane 1's first row. The boundaries are whole pixels, so this
        // is the tightest press that can still be inside the pane at all.
        h.drag(axisX, paneRows[1].top + 1, axisX, paneRows[1].top + 161);

        const priceAfter = chart.getPriceRange();
        const lowerAfter = chart.getPaneValueRange(1);
        assert.ok(
            Math.abs((lowerAfter[1] - lowerAfter[0]) - (lowerBefore[1] - lowerBefore[0])) > 1e-9,
            `pane 1 should have been scaled, still [${lowerAfter}]`,
        );
        assert.deepEqual(priceAfter, priceBefore, 'the price pane moved');
        // Pane 0's auto-scale state is genuinely untouched, not merely still fitting: the
        // option is the price scale's, so a lower pane's lock must not write it.
        assert.equal(chart.options().priceScale.autoScale, true, 'a lower-pane lock wrote autoScale');
    } finally {
        h.dispose();
    }
});

test('a drag in the price pane does not touch a lower pane', () => {
    const { h, axisX, paneRows } = twoPaneChart();
    try {
        const chart = h.chart;
        const lowerBefore = chart.getPaneValueRange(1);
        h.drag(axisX, paneRows[0].top + 20, axisX, paneRows[0].top + 220);
        assert.equal(chart.options().priceScale.autoScale, false, 'the price pane should be locked');
        assert.deepEqual(
            chart.getPaneValueRange(1),
            lowerBefore,
            'locking the price pane disturbed the oscillator pane',
        );
    } finally {
        h.dispose();
    }
});

test('each pane keeps its own lock, and its own release', () => {
    const { h, axisX, paneRows } = twoPaneChart();
    try {
        const chart = h.chart;
        h.drag(axisX, paneRows[0].top + 20, axisX, paneRows[0].top + 220);
        const priceLocked = chart.getPriceRange();
        h.drag(axisX, paneRows[1].top + 1, axisX, paneRows[1].top + 161);
        const lowerLocked = chart.getPaneValueRange(1);

        // Both held at once: the second drag did not release the first.
        assert.deepEqual(chart.getPriceRange(), priceLocked, 'the price lock was lost');
        assert.deepEqual(chart.getPaneValueRange(1), lowerLocked, 'the lower lock was not taken');

        // Releasing one leaves the other alone.
        chart.fitPaneRange(1);
        assert.notDeepEqual(chart.getPaneValueRange(1), lowerLocked, 'fitPaneRange(1) did not release');
        assert.deepEqual(chart.getPriceRange(), priceLocked, 'releasing pane 1 released pane 0');
        assert.equal(chart.options().priceScale.autoScale, false, 'releasing pane 1 released pane 0');
    } finally {
        h.dispose();
    }
});

test('the divider belongs to no pane, at every exact boundary', () => {
    // The divider is the band `paneRects` leaves to neither pane, and the boundaries are
    // snapped to whole pixels precisely so two panes cannot both claim one. Checked at
    // every pixel of the band and at both edges, because an off-by-one here is invisible
    // in a screenshot and catastrophic in a use.
    const { h, axisX, paneRows, separator } = twoPaneChart();
    try {
        const chart = h.chart;
        const priceBefore = chart.getPriceRange();
        const lowerBefore = chart.getPaneValueRange(1);

        for (let offset = 0; offset < separator; offset++) {
            const y = paneRows[0].bottom + offset;
            h.drag(axisX, y, axisX, y + 160);
            assert.deepEqual(chart.getPriceRange(), priceBefore, `divider pixel ${offset} moved the price pane`);
            assert.deepEqual(
                chart.getPaneValueRange(1),
                lowerBefore,
                `divider pixel ${offset} moved pane 1`,
            );
            assert.equal(
                chart.options().priceScale.autoScale,
                true,
                `divider pixel ${offset} took the price pane's lock`,
            );
        }

        // The first pixel of each pane's own rows is live, so the boundary is exact in
        // both directions rather than merely generous.
        h.drag(axisX, paneRows[1].top, axisX, paneRows[1].top + 160);
        assert.notDeepEqual(
            chart.getPaneValueRange(1),
            lowerBefore,
            "pane 1's own first row should be draggable",
        );
    } finally {
        h.dispose();
    }
});

test("a lower pane's drag uses the same span arithmetic, about the same centre", () => {
    const { h, axisX, paneRows } = twoPaneChart();
    try {
        const chart = h.chart;
        // A known range first, so the expectation is a number rather than a comparison
        // against whatever the fit happened to produce.
        chart.setPaneRange(1, [20, 80]);
        const before = chart.getPaneValueRange(1);
        const wanted = 1.5;
        const paneHeight = paneRows[1].bottom - paneRows[1].top;
        h.pointer('pointerdown', axisX, paneRows[1].top + 10);
        const baseline = chart.getPaneValueRange(1);
        h.pointer('pointermove', axisX, paneRows[1].top + 10 + paneHeight * (wanted - 1));
        h.pointer('pointerup', axisX, paneRows[1].top + 10 + paneHeight * (wanted - 1));
        const after = chart.getPaneValueRange(1);

        assert.deepEqual(before, [20, 80], 'setPaneRange did not read back');
        close((after[1] - after[0]) / (baseline[1] - baseline[0]), wanted, 1e-9, 'factor');
        close((after[0] + after[1]) / 2, (baseline[0] + baseline[1]) / 2, 1e-9, 'middle held');
    } finally {
        h.dispose();
    }
});

test('an indicator pane stays linear while the price pane is a log axis', () => {
    // The asymmetry is the reason `paneValueToScale` is a function of the pane index. A
    // log price scale must not reach a bounded oscillator, and a log pane's range must
    // read back in indicator values rather than in logs.
    const { h, axisX, paneRows } = twoPaneChart({ priceScale: { mode: 'log' } });
    try {
        const chart = h.chart;
        chart.setPriceRange([50, 200]);
        // Not `deepEqual`: a log pane's round trip is `exp(log(x))`, which is 50 to
        // within 5e-14 rather than exactly 50. Comparing the exponent's precision against
        // the value's is asking the wrong question.
        close(chart.getPriceRange()[0], 50, 1e-9, 'log price round-trip low');
        close(chart.getPriceRange()[1], 200, 1e-9, 'log price round-trip high');

        // Pane 0's range reads in prices, not in logs. It was reading raw scale-space
        // values, so a log chart reported log(50) where a caller asked for 50.
        const paneZero = chart.getPaneValueRange(0);
        close(paneZero[0], 50, 1e-6, 'pane 0 low on a log axis');
        close(paneZero[1], 200, 1e-6, 'pane 0 high on a log axis');

        // And pane 1 is untouched by the log axis, and draggable in its own units.
        chart.setPaneRange(1, [10, 90]);
        assert.deepEqual(chart.getPaneValueRange(1), [10, 90]);
        h.drag(axisX, paneRows[1].top + 1, axisX, paneRows[1].top + 161);
        const after = chart.getPaneValueRange(1);
        assert.ok(after[1] - after[0] > 90, `pane 1 should have expanded past 80, got [${after}]`);
        // Still prices, not logs, on pane 0.
        close(chart.getPriceRange()[0], 50, 1e-6, 'price low after an indicator drag');
    } finally {
        h.dispose();
    }
});

test('a pane range survives a feed append and a theme change', () => {
    const { h, axisX, paneRows } = twoPaneChart();
    try {
        const chart = h.chart;
        h.drag(axisX, paneRows[1].top + 1, axisX, paneRows[1].top + 161);
        const locked = chart.getPaneValueRange(1);
        // A lower pane's lock lives in the chart's own map, which `applyOptions` does not
        // rebuild, so it survives a re-resolve for free. Pane 0's has to be written into
        // both option objects to achieve the same thing.
        chart.setTheme('paper');
        assert.deepEqual(chart.getPaneValueRange(1), locked, 'a theme change released pane 1');
        chart.appendData({
            time: 1_700_000_000_000 + 60 * 60_000, open: 1, high: 2, low: 0, close: 1.5, volume: 1,
        });
        h.flush();
        assert.deepEqual(chart.getPaneValueRange(1), locked, 'an append released pane 1');
    } finally {
        h.dispose();
    }
});

test('shrinking the pane count drops a lock for a pane that no longer exists', () => {
    const { h, axisX, paneRows } = twoPaneChart();
    try {
        const chart = h.chart;
        h.drag(axisX, paneRows[1].top + 1, axisX, paneRows[1].top + 161);
        const locked = chart.getPaneValueRange(1);
        assert.notDeepEqual(locked, [20, 80], 'precondition: pane 1 is locked');

        // The overlay goes first, and it has to: an overlay naming a pane that no longer
        // exists is rejected by name, which is the documented behaviour and leaves the
        // chart untouched. So the lock cannot be observed from under it.
        chart.setOverlays([]);
        chart.applyOptions({ panes: { weights: [1] } });
        h.flush();
        assert.throws(() => chart.fitPaneRange(1), /pane 1/);
        assert.throws(() => chart.setPaneRange(1, [0, 1]), /pane 1/);

        // The real claim: grow the layout back and pane 1 is fitting again, not showing
        // the range it held before its pane was removed. A lock left in the map would
        // come straight back, and the caller would see a pane they had released months
        // ago still stuck at a scale they no longer remember choosing.
        chart.applyOptions({ panes: { weights: [3, 1] } });
        h.flush();
        chart.setOverlays([{
            id: 'osc',
            points: flatCandles(60, { start: 50, step: 0.1 }).map((c) => ({ time: c.time, value: c.close })),
            pane: 1,
        }]);
        h.flush();
        const refitted = chart.getPaneValueRange(1);
        assert.notDeepEqual(refitted, locked, 'a lock for a removed pane came back');
    } finally {
        h.dispose();
    }
});

test('a zero-width price axis disables the gesture on every pane', () => {
    const h = createHeadlessChart({ panes: { weights: [3, 1] }, layout: { priceAxisWidth: 0 } });
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

test('getPaneAtCoordinate answers the same question the drag asks', () => {
    // The reason this method exists: a caller's own double-click has to reach
    // `fitPaneRange(n)`, and without it the only way to learn `n` is to reimplement
    // `paneRects` in application code. So the assertion is not just that it returns
    // something sensible — it is that it agrees with the drag at every pixel, because
    // two copies of "which pane is this" is what produces a divider desync.
    const { h, axisX, paneRows, separator } = twoPaneChart();
    try {
        const chart = h.chart;
        // The x bound is the canvas width, not the plot's: the gutter and the plot are
        // one surface with rows either side, and asking from the gutter must give the
        // same answer as asking from the middle of the plot.
        const canvasWidth = 1200;

        for (let y = 0; y < 578; y++) {
            const expected = (y >= paneRows[0].top && y < paneRows[0].bottom)
                ? 0
                : (y >= paneRows[1].top && y < paneRows[1].bottom ? 1 : null);
            // The gutter and the plot must answer alike: they share rows.
            assert.equal(chart.getPaneAtCoordinate(axisX, y), expected, `gutter at y=${y}`);
            assert.equal(
                chart.getPaneAtCoordinate(canvasWidth - 1, y),
                expected,
                `plot at y=${y}`,
            );
        }
        // Every pixel of the divider is nobody's.
        for (let offset = 0; offset < separator; offset++) {
            assert.equal(
                chart.getPaneAtCoordinate(axisX, paneRows[0].bottom + offset),
                null,
                `divider pixel ${offset}`,
            );
        }
        // And off the side of the chart is null rather than answered from y alone.
        assert.equal(chart.getPaneAtCoordinate(-1, 100), null, 'x left of the canvas');
        assert.equal(chart.getPaneAtCoordinate(canvasWidth + 1, 100), null, 'x right of the canvas');
        // Below the plot, in the time-axis strip.
        assert.equal(chart.getPaneAtCoordinate(axisX, 590), null, 'the time axis strip');
    } finally {
        h.dispose();
    }
});

test('a pane range change is reported once, and only when it moved', () => {
    const { h, axisX, paneRows } = twoPaneChart();
    try {
        const chart = h.chart;
        const events = [];
        const unsubscribe = chart.subscribePaneRangeChange((e) => events.push(e));
        h.flush();
        // A first subscription reports the current state rather than waiting for the next
        // change, so a readout mounted after the chart is already drawn is not blank.
        assert.deepEqual(events.map((e) => e.pane), [0, 1], 'initial report');
        const initialPrice = events.find((e) => e.pane === 0).range;
        assert.deepEqual(initialPrice, chart.getPriceRange(), 'reported range must match the getter');

        // A deliberate stretch of the lower pane: one event, for that pane only.
        events.length = 0;
        h.drag(axisX, paneRows[1].top + 1, axisX, paneRows[1].top + 161);
        h.flush();
        assert.deepEqual(events.map((e) => e.pane), [1], 'a lower-pane drag reported other panes');
        assert.deepEqual(events[0].range, chart.getPaneValueRange(1), 'event range must match the getter');

        // Doing nothing reports nothing. A pan is not a vertical change.
        events.length = 0;
        h.drag(400, 200, 300, 200);
        h.flush();
        assert.deepEqual(events, [], 'a pan reported a pane range change');

        // Neither does a re-lock to the range it already holds.
        events.length = 0;
        chart.setPaneRange(1, chart.getPaneValueRange(1));
        h.flush();
        assert.deepEqual(events, [], 're-locking to the same range reported a change');

        // And the price pane's fit wobbling must not wake a reader of pane 1.
        events.length = 0;
        const lowerBefore = chart.getPaneValueRange(1);
        chart.setPriceRange([100, 200]);
        h.flush();
        assert.deepEqual(events.map((e) => e.pane), [0], 'a price change woke the lower pane');
        assert.deepEqual(chart.getPaneValueRange(1), lowerBefore);

        unsubscribe();
        events.length = 0;
        chart.setPriceRange([10, 20]);
        h.flush();
        assert.deepEqual(events, [], 'an unsubscribed handler was still called');
    } finally {
        h.dispose();
    }
});

test('the range event follows the auto-fit, not only deliberate locks', () => {
    // A readout that only heard about deliberate changes would be stale from the first
    // new high — the same permanent lie as a barSpacing readout reporting its
    // construction value, which is the defect this engine shipped twice.
    const h = withData();
    try {
        const chart = h.chart;
        const events = [];
        chart.subscribePaneRangeChange((e) => events.push(e));
        h.flush();
        events.length = 0;

        // A candle far outside the fitted range must move the fit and be reported.
        chart.appendData({
            time: 1_700_000_000_000 + 60 * 60_000, open: 400, high: 500, low: 390, close: 450, volume: 1,
        });
        h.flush();
        assert.ok(events.length > 0, 'a new high reported no range change');
        const last = events[events.length - 1];
        assert.equal(last.pane, 0);
        assert.deepEqual(last.range, chart.getPriceRange(), 'reported range must match the getter');
        assert.ok(last.range[1] > 400, `the fit should have moved up, reported ${last.range}`);
    } finally {
        h.dispose();
    }
});

test('a drag of the plot still pans, and leaves a locked price range alone', () => {    const h = withData();
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
