// The two view-control methods added in this release: `getPlotRect`, which tells a
// caller where the data actually is, and `setVisibleLogicalRange`, which lets one put
// the view somewhere the getter could only report on.
//
// The second one exists because drawing tools want empty space. A tool that projects
// forward, or a panel that wants room beside the series, needs somewhere to put that
// room, and a viewport whose only positions are "whatever the last gesture left" is not
// something the caller owns. These tests pin that, plus the one rule that keeps the new
// API and the pan bound from disagreeing.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createHeadlessChart, flatCandles } = require('./support/headlessChart.cjs');
const { slotForIndex, PANNING_MARGIN_RATIO } = require('../.test-build/core/coordinates.js');
const { computeSlotOffsets, resolveSessionBreaks, sizeSessionBreaks, slotAtIndex, totalSlots } =
    require('../.test-build/core/sessionScale.js');

const CSS_WIDTH = 1200;
const CSS_HEIGHT = 600;
const GUTTER = 78;   // default layout.priceAxisWidth
const TIME_AXIS = 22; // default layout.timeAxisHeight
const MINUTE = 60_000;
/**
 * The half-bar a view's edges sit inside the bars it frames, in slots. The same inset the
 * live edge parks the newest candle with, and the reason a range reads back as asked for
 * rather than one bar out: a plot edge on a bar's left edge is on the exact boundary the
 * getter's `from`/`to` are defined against, and float decides which side it lands on.
 */
const INSET = 0.5;

function chart(count = 300, options) {
    const harness = createHeadlessChart(options);
    harness.chart.setData(flatCandles(count));
    harness.flush();
    return harness;
}

// --- getPlotRect -------------------------------------------------------------------

test('getPlotRect reports where the data is, not where the element is', () => {
    // The whole reason for the method. The canvas includes a 78px price gutter on the
    // left and a 22px time axis along the bottom, so `x = 0` in element coordinates is
    // inside the price labels and not at the first bar. Every hit-test, clamp and overlay
    // a caller writes has to know the difference, and there was no way to ask.
    const harness = chart();
    try {
        const plot = harness.chart.getPlotRect();
        assert.equal(plot.x, GUTTER, 'the plot starts after the price gutter');
        assert.equal(plot.width, CSS_WIDTH - GUTTER, 'and is narrower than the canvas by it');
        assert.equal(plot.y, 0);
        assert.equal(plot.height, CSS_HEIGHT - TIME_AXIS, 'and shorter by the time axis');
    } finally {
        harness.dispose();
    }
});

test('view state captures and restores the viewport and price range', () => {
    const harness = chart(300);
    try {
        harness.chart.setVisibleLogicalRange({ from: 100, to: 200 });
        harness.chart.setPriceRange([99, 103]);
        const saved = harness.chart.getViewState();
        harness.chart.setVisibleLogicalRange({ from: 10, to: 60 });
        harness.chart.setPriceRange([80, 90]);
        harness.chart.setViewState(saved);
        assert.deepEqual(harness.chart.getVisibleLogicalRange(), saved.logical);
        assert.deepEqual(harness.chart.getPriceRange(), [99, 103]);
    } finally {
        harness.dispose();
    }
});

test('addSeries provides a managed line lifecycle', () => {
    const harness = chart(20);
    try {
        const series = harness.chart.addSeries({ id: 'managed', color: '#00ff00' });
        const points = [
            { time: harness.chart.getCandleAt(5).time, value: 100 },
            { time: harness.chart.getCandleAt(6).time, value: 101 },
        ];
        series.setData(points);
        assert.deepEqual(harness.chart.getOverlayIds(), ['managed']);
        assert.equal(harness.chart.getOverlayValueAt('managed', 6), 101);
        series.setVisible(false);
        series.remove();
        assert.deepEqual(harness.chart.getOverlayIds(), []);
    } finally {
        harness.dispose();
    }
});

test('orders validate, publish state, and resolve through hit testing', () => {
    const harness = chart(30);
    try {
        const events = [];
        harness.chart.subscribeOrders((orders) => events.push(orders));
        harness.chart.setOrders([{ id: 'entry', side: 'buy', price: 100, quantity: 2 }]);
        assert.equal(harness.chart.getOrders()[0].status, 'working');
        const y = harness.chart.priceToCoordinate(100);
        const hit = harness.chart.hitTest(harness.chart.getPlotRect().x + 10, y);
        assert.equal(hit.kind, 'order');
        assert.equal(hit.id, 'entry');
        harness.chart.updateOrderStatus('entry', 'filled');
        assert.equal(harness.chart.getOrders()[0].status, 'filled');
        assert.ok(events.length >= 3);
    } finally {
        harness.dispose();
    }
});

test('hitTest resolves engine-owned candles and decorations', () => {
    const harness = chart(40);
    try {
        const chartInstance = harness.chart;
        const candle = chartInstance.getCandleAt(20);
        const x = chartInstance.indexToCoordinate(20);
        assert.ok(candle);

        let hit = chartInstance.hitTest(x, chartInstance.priceToCoordinate(candle.close));
        assert.equal(hit.kind, 'candle');
        assert.equal(hit.index, 20);

        chartInstance.setPriceLines([{ id: 'level', price: candle.close }]);
        hit = chartInstance.hitTest(x, chartInstance.priceToCoordinate(candle.close));
        assert.deepEqual(hit, { kind: 'priceLine', id: 'level', price: candle.close });

        chartInstance.setPriceLines([]);
        chartInstance.setMarkers([{ time: candle.time, position: 'inBar' }]);
        hit = chartInstance.hitTest(x, chartInstance.priceToCoordinate(candle.close));
        assert.equal(hit.kind, 'marker');
        assert.equal(hit.index, 20);

        chartInstance.clearMarkers();
        chartInstance.setZones([{ id: 'zone', time: candle.time, top: candle.high, bottom: candle.low }]);
        hit = chartInstance.hitTest(x, chartInstance.priceToCoordinate(candle.close));
        assert.deepEqual(hit.kind, 'zone');
        assert.equal(hit.id, 'zone');
        assert.equal(chartInstance.hitTest(-1, -1), null);
    } finally {
        harness.dispose();
    }
});

test('getPlotRect follows a layout change', () => {
    // Reported, not cached. A gutter the caller widens has to move the plot with it, or
    // the number is a snapshot of the first frame and quietly wrong after the first
    // `applyOptions` that touches layout.
    const harness = chart();
    try {
        harness.chart.applyOptions({ layout: { priceAxisWidth: 140, timeAxisHeight: 40 } });
        harness.flush();
        const plot = harness.chart.getPlotRect();
        assert.equal(plot.x, 140);
        assert.equal(plot.width, CSS_WIDTH - 140);
        assert.equal(plot.height, CSS_HEIGHT - 40);
    } finally {
        harness.dispose();
    }
});

test('getPlotRect hands back a copy, so a caller cannot move the plot by writing to it', () => {
    // A public getter that returns the live object is a public setter with a misleading
    // name. `plotRect` is internal state that every render reads, so a stray write to it
    // would corrupt the next frame in a way nothing else would explain.
    const harness = chart();
    try {
        const plot = harness.chart.getPlotRect();
        plot.x = -5000;
        plot.width = 1;
        assert.equal(harness.chart.getPlotRect().x, GUTTER);
        assert.equal(harness.chart.getPlotRect().width, CSS_WIDTH - GUTTER);
    } finally {
        harness.dispose();
    }
});

// --- setVisibleLogicalRange: the ordinary case ---------------------------------------

    // The half-bar is the same inset the live edge parks the newest candle with, so a
    // view restored from a saved range is framed the way a live one is.
test('a range set and read back is the range asked for', () => {
    // The round trip, and it is exact rather than approximate. The getter's `from` is
    // the bar at the plot's left edge and its `to` is the count of bars started before
    // the right edge, so framing the requested bars half a slot in from both edges lands
    // the answer on the request rather than on a boundary float could go either side of.
    const harness = chart(300);
    try {
        harness.chart.setVisibleLogicalRange({ from: 100, to: 200 });
        harness.flush();
        assert.deepEqual(harness.chart.getVisibleLogicalRange(), { from: 100, to: 200 });
    } finally {
        harness.dispose();
    }
});

test('the plot edges land half a bar inside the requested bars', () => {
    // Stated in slots rather than pixels, because a slot is the unit the placement is
    // actually made in and a pixel assertion would only be testing the spacing. Half a
    // bar in from each edge is what makes the round trip exact — see the note on the
    // setter.
    const harness = chart(300);
    try {
        harness.chart.setVisibleLogicalRange({ from: 100, to: 200 });
        harness.flush();
        const plot = harness.chart.getPlotRect();
        const left = harness.chart.coordinateToSlot(plot.x);
        const right = harness.chart.coordinateToSlot(plot.x + plot.width);
        assert.ok(Math.abs(left - (100 + INSET)) < 1e-6, `left edge at slot ${left}`);
        assert.ok(Math.abs(right - (199 + INSET)) < 1e-6, `right edge at slot ${right}`);
    } finally {
        harness.dispose();
    }
});

test('the range is honoured by moving the spacing, not only the position', () => {
    // A range that does not fit at the current spacing cannot be shown at that spacing,
    // and quietly showing a different range than the one asked for is worse than not
    // honouring it. So the spacing moves too — which is what makes the method a complete
    // view description and a saved range actually restorable.
    const harness = chart(300);
    try {
        const before = harness.chart.getBarSpacing();
        harness.chart.setVisibleLogicalRange({ from: 100, to: 200 });
        harness.flush();
        const after = harness.chart.getBarSpacing();
        assert.notEqual(after, before, 'fitting 100 bars into the plot needs a different spacing');
        assert.deepEqual(harness.chart.getVisibleLogicalRange(), { from: 100, to: 200 });
    } finally {
        harness.dispose();
    }
});

test('a range survives a session break, because it is fitted in slots', () => {
    // The break is drawn as whitespace, so it has to be included in the width the range
    // is fitted to. Fitting in index units would squeeze a gapped range into the plot and
    // the view would come back showing more bars than were asked for.
    const times = [];
    let cursor = Date.UTC(2025, 0, 6, 14, 30);
    for (let bar = 0; bar < 120; bar++) {
        if (bar === 30 || bar === 60) cursor += 17 * 60 * MINUTE;
        times.push(cursor);
        cursor += MINUTE;
    }
    const harness = createHeadlessChart({ timeScale: { barSpacing: 12 } });
    try {
        harness.chart.setData(times.map((time) => ({ time, open: 1, high: 2, low: 0, close: 1.5 })));
        harness.flush();
        const slots = computeSlotOffsets(
            times,
            sizeSessionBreaks(times, resolveSessionBreaks(times, { mode: 'proportional' })),
        );
        assert.ok(totalSlots(slots) > times.length, 'the fixture needs gaps to mean anything');

        harness.chart.setVisibleLogicalRange({ from: 40, to: 80 });
        harness.flush();
        assert.deepEqual(harness.chart.getVisibleLogicalRange(), { from: 40, to: 80 });
    } finally {
        harness.dispose();
    }
});

// --- the point of the method: room past the data ------------------------------------

test('a range running past the newest candle is honoured, and the room is on screen', () => {
    // The feature. `to` above the candle count is not a mistake to be clamped away: it is
    // a request for bar-widths of empty space after the last candle, and that space is
    // drawn, hit-testable, and where a forward projection gets drawn.
    //
    // Asserted on where the plot's right edge ended up rather than on the range coming
    // back, because the getter reports visible *candles* and clamps to the series by
    // design — it can say "300 bars" about a window that extends past 300 and no more.
    const harness = chart(300);
    try {
        harness.chart.setVisibleLogicalRange({ from: 250, to: 350 });
        harness.flush();
        const plot = harness.chart.getPlotRect();
        const rightSlot = harness.chart.coordinateToSlot(plot.x + plot.width);
        // The right edge sits half a bar in from bar 349, so 49.5 bar-widths of the
        // 50 requested are past the last candle's centre — the half-bar being the same
        // inset every framed view carries.
        assert.ok(
            Math.abs(rightSlot - (349 + INSET)) < 1e-6,
            `the plot's right edge is at slot ${rightSlot}, not past the newest candle as asked`,
        );
        // The space is inside the plot, so it is somewhere a drawing can be placed, and
        // the candles asked for are the ones on screen.
        assert.ok(plot.x + plot.width > harness.chart.indexToCoordinate(299));
        assert.deepEqual(harness.chart.getVisibleLogicalRange(), { from: 250, to: 300 });
    } finally {
        harness.dispose();
    }
});

test('a range before the oldest candle is honoured too', () => {
    // The mirror. Retention means the oldest bar moves under a live feed, so a caller
    // laying out a panel with space on the left is asking for a position, not a bar.
    const harness = chart(300);
    try {
        harness.chart.setVisibleLogicalRange({ from: -40, to: 60 });
        harness.flush();
        const plot = harness.chart.getPlotRect();
        const leftSlot = harness.chart.coordinateToSlot(plot.x);
        assert.ok(
            Math.abs(leftSlot - (-40 + INSET)) < 1e-6,
            `the plot's left edge is at slot ${leftSlot}, not before the oldest candle as asked`,
        );
        assert.ok(harness.chart.indexToCoordinate(0) > plot.x, 'the first candle is inside the plot');
        assert.deepEqual(harness.chart.getVisibleLogicalRange(), { from: 0, to: 60 });
    } finally {
        harness.dispose();
    }
});

test('a requested range is held to the same bound a drag is', () => {
    // One rule, not two. If the method could place a view further out than a gesture may,
    // a caller could ask for a view and then lose it on the first drag — the same chart
    // refusing two requests it was happy to honour a moment before. So an out-of-bounds
    // ask is honoured as far as the bound goes rather than rejected.
    const harness = chart(300);
    try {
        harness.chart.setVisibleLogicalRange({ from: -5000, to: 5000 });
        harness.flush();
        const plot = harness.chart.getPlotRect();
        const spacing = harness.chart.getBarSpacing();
        const marginPx = plot.width * PANNING_MARGIN_RATIO;
        const firstX = harness.chart.indexToCoordinate(0);
        const lastX = harness.chart.indexToCoordinate(299);
        assert.ok(
            firstX >= plot.x - marginPx - spacing,
            `the first bar is at ${firstX}, past the bound before the plot's left edge`,
        );
        assert.ok(
            lastX <= plot.x + plot.width + marginPx + spacing,
            `the last bar is at ${lastX}, past the bound after the plot's right edge`,
        );
    } finally {
        harness.dispose();
    }
});

test('a range set into the extended space is not lost by the next drag', () => {
    // The consequence of holding to one bound, checked end to end. A caller asks for room
    // on the right, the user then pans, and the pan is bounded by the same number — so the
    // view has to still contain the data rather than snapping back to the middle of it.
    const harness = chart(300);
    try {
        harness.chart.setVisibleLogicalRange({ from: 250, to: 350 });
        harness.flush();
        harness.drag(600, 300, 700, 300);
        harness.flush();
        const plot = harness.chart.getPlotRect();
        const spacing = harness.chart.getBarSpacing();
        assert.ok(
            harness.chart.indexToCoordinate(299) >= plot.x,
            'a pan after an extended range pushed the data off the left of the plot',
        );
        assert.ok(
            harness.chart.indexToCoordinate(299) + spacing / 2 <= plot.x + plot.width + plot.width * PANNING_MARGIN_RATIO,
            'and left the data further past the right edge than the bound allows',
        );
    } finally {
        harness.dispose();
    }
});

// --- the axis keeps going outside the series ---------------------------------------

test('the index axis continues one bar per slot past either end', () => {
    // What "past the data" means numerically, and the convention it uses: a slot is a
    // bar's **left edge**, matching `computeSlotOffsets` and `totalSlots`. Inside the
    // series a slot is a bar's position and the gaps make it non-uniform; outside there is
    // nothing but bars, so the only continuation matching how the bars inside are spaced
    // is one per slot. The half-bar that frames a view is added by the caller, not baked
    // in here.
    assert.equal(slotForIndex(null, 5, 300), 5);
    assert.equal(slotForIndex(null, -40, 300), -40);
    // Index 300 is the first whole slot past the last bar's left edge.
    assert.equal(slotForIndex(null, 300, 300), 300);
    assert.equal(slotForIndex(null, 350, 300), 350);
});

test('the axis continues past the end by slot, so a trailing break still counts', () => {
    // The same extrapolation against a gapped series, where `candleCount` and
    // `totalSlots` are no longer the same number. Getting this wrong by the gap width is
    // what would put the requested room in the wrong place on a chart with an overnight
    // break in it — the case a trading chart spends its life in.
    const times = [];
    let cursor = Date.UTC(2025, 0, 6, 14, 30);
    for (let bar = 0; bar < 120; bar++) {
        if (bar === 30 || bar === 60) cursor += 17 * 60 * MINUTE;
        times.push(cursor);
        cursor += MINUTE;
    }
    const slots = computeSlotOffsets(
        times,
        sizeSessionBreaks(times, resolveSessionBreaks(times, { mode: 'proportional' })),
    );
    const extent = totalSlots(slots);
    assert.ok(extent > times.length, 'the fixture needs gaps to mean anything');
    // Left edges, so the last bar's left edge is exactly one slot short of the end.
    assert.equal(slotForIndex(slots, 119, times.length), extent - 1, 'the last bar is one slot short of the end');
    assert.equal(slotForIndex(slots, times.length, times.length), extent, 'one past it is the end');
    assert.equal(slotForIndex(slots, times.length + 10, times.length), extent + 10);
    // And it is the offsets table itself, not `slotAtIndex` — which returns a bar's
    // centre, and would put every placement half a slot out on a gapped chart while
    // leaving an unbroken one correct. A view placed by a range must not depend on
    // whether the session-break option is on.
    assert.equal(slotForIndex(slots, 60, times.length), slots[60]);
    assert.notEqual(slotForIndex(slots, 60, times.length), slotAtIndex(slots, 60), 'a centre, not an edge');
});

// --- bad input -----------------------------------------------------------------------

test('a degenerate range throws rather than silently doing nothing', () => {
    // `setPriceRange` throws for a range it cannot honour, and this is the same kind of
    // argument. A silent no-op would look like the chart ignoring the request, which is the
    // hardest version of this bug to diagnose from the outside.
    const harness = chart();
    try {
        assert.throws(
            () => harness.chart.setVisibleLogicalRange({ from: 200, to: 200 }),
            /a "to" above its "from"/,
        );
        assert.throws(
            () => harness.chart.setVisibleLogicalRange({ from: 200, to: 100 }),
            /a "to" above its "from"/,
        );
        assert.throws(
            () => harness.chart.setVisibleLogicalRange({ from: Number.NaN, to: 10 }),
            /two finite indices/,
        );
        assert.throws(
            () => harness.chart.setVisibleLogicalRange({ from: 0, to: Number.POSITIVE_INFINITY }),
            /two finite indices/,
        );
    } finally {
        harness.dispose();
    }
});

test('a range on an empty chart changes nothing', () => {
    // Nothing to place a range against. Not a throw: the request is well formed, there is
    // simply no series, and the same call is a legitimate one to make before data arrives.
    const harness = createHeadlessChart();
    try {
        harness.chart.setVisibleLogicalRange({ from: 0, to: 50 });
        harness.flush();
        assert.deepEqual(harness.chart.getVisibleLogicalRange(), { from: 0, to: 0 });
    } finally {
        harness.dispose();
    }
});
