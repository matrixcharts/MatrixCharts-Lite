// Tests for the caller's gesture seam: `Chart.setPointerClaimHandler`, and the
// reachable `Chart.redraw()`.
//
// The engine owns the pointer surface. A press in the plot pans, a press in the gutter
// scales that pane, and both are correct for a chart and wrong for a drawing tool. These
// pin the contract that lets a tool take a press the engine would otherwise have: that a
// claimed press does not pan, that the claim cannot outlive its gesture, that the chart
// is still pannable afterwards, and that a handler which throws cannot break the chart.
//
// The failure this exists to prevent is visible to a user — the series sliding while a
// drawing moves — and unreachable to a unit test that only calls the public setters, so
// these drive real dispatched gestures through the same wrapper the browser would use.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHeadlessChart, flatCandles } = require('./support/headlessChart.cjs');

const MINUTE = 60_000;
const START = Date.UTC(2024, 0, 1);

function candles(count) {
    return flatCandles(count, { step: 0.5 }).map((candle, index) => ({
        ...candle, time: START + index * MINUTE,
    }));
}

/** A chart with data, and the log of gestures it actually received. */
function setup(count = 200) {
    const harness = createHeadlessChart();
    const { chart } = harness;
    chart.setData(candles(count));
    // A window in the middle of the series, not at its start. A pan is bounded, and a
    // window parked against the first bar is already at that bound: dragging right slides
    // the far edge instead of moving the near one, so a test watching `from` would see no
    // movement and conclude the chart was stuck when it panned correctly.
    chart.setVisibleLogicalRange({ from: 40, to: 140 });
    // Drained before the test measures anything. A pan schedules its viewport update on
    // a frame, so a frame still pending from setup would be counted against the first
    // gesture under test — and a test asserting "the view did not move" would then pass
    // for the wrong reason.
    harness.flush();
    return harness;
}

// --- the claim itself -------------------------------------------------------

test('a claimed press does not pan the chart', () => {
    const h = setup();
    const before = h.chart.getVisibleLogicalRange().from;
    const seen = [];
    h.chart.setPointerClaimHandler((claim) => { seen.push(claim); return true; });

    // A press, a long move, and a release, in the plot. This is exactly the gesture
    // that panned the series before the seam existed.
    h.pointer('pointerdown', 500, 250);
    h.pointer('pointermove', 700, 250);
    h.pointer('pointerup', 700, 250);

    assert.equal(h.chart.getVisibleLogicalRange().from, before, 'the series moved during a claimed drag');
    assert.equal(seen.length, 1, 'the handler was offered the press');
    assert.equal(seen[0].clientX, 500);
    assert.equal(seen[0].clientY, 250);
    assert.equal(seen[0].pointerCount, 0, 'a first press should report no pointers down');
    h.flush();
    h.flush();
    h.dispose();
});

test('an unclaimed press still pans, so the chart is unchanged when no handler claims', () => {
    const h = setup();
    h.chart.setPointerClaimHandler(() => false);
    const before = h.chart.getVisibleLogicalRange().from;

    h.pointer('pointerdown', 500, 250);
    h.pointer('pointermove', 700, 250);
    h.pointer('pointerup', 700, 250);

    assert.notEqual(h.chart.getVisibleLogicalRange().from, before, 'a declined press must still pan');
    h.flush();
    h.dispose();
});

test('a claimed press reports no click', () => {
    // A press that travelled far enough to be a pan is not also a click, and a claimed
    // press is the caller's to report through its own means.
    const h = setup();
    const clicks = [];
    h.chart.subscribeClick((event) => clicks.push(event));
    h.chart.setPointerClaimHandler(() => true);

    h.pointer('pointerdown', 500, 250);
    h.pointer('pointerup', 500, 250);

    assert.equal(clicks.length, 0, 'a claimed press emitted a click');
    h.flush();
    h.dispose();
});

test('the claim ends on release, and the chart pans again afterwards', () => {
    // The invariant this whole seam hangs on. A claim that outlived its gesture would
    // leave the chart unpannable for the rest of the session, with nothing on screen
    // to say why.
    const h = setup();
    let claimEverything = true;
    h.chart.setPointerClaimHandler(() => claimEverything);

    h.pointer('pointerdown', 500, 250);
    h.pointer('pointermove', 700, 250);
    h.pointer('pointerup', 700, 250);

    claimEverything = false;
    const before = h.chart.getVisibleLogicalRange().from;
    h.pointer('pointerdown', 500, 250);
    h.pointer('pointermove', 700, 250);
    h.pointer('pointerup', 700, 250);
    assert.notEqual(
        h.chart.getVisibleLogicalRange().from, before,
        'the chart stayed unpannable after a claimed gesture ended',
    );
    h.flush();
    h.dispose();
});

test('the claim ends on pointercancel, not only on release', () => {
    // A touch gesture the browser takes over — a system edge swipe, a palm rejection —
    // delivers `pointercancel` and no `pointerup`. Leaving the chart stuck would be the
    // worst outcome, because the user has no release to try again with.
    const h = setup();
    let claim = true;
    h.chart.setPointerClaimHandler(() => claim);

    h.pointer('pointerdown', 500, 250, { pointerType: 'touch' });
    h.pointer('pointercancel', 500, 250, { pointerType: 'touch' });
    claim = false;

    const before = h.chart.getVisibleLogicalRange().from;
    h.pointer('pointerdown', 500, 250, { pointerType: 'touch' });
    h.pointer('pointermove', 700, 250, { pointerType: 'touch' });
    h.pointer('pointerup', 700, 250, { pointerType: 'touch' });
    assert.notEqual(
        h.chart.getVisibleLogicalRange().from, before,
        'the chart stayed unpannable after a cancelled claim',
    );
    h.flush();
    h.dispose();
});

test('a handler can decline a second finger so a pinch is still the engine\'s', () => {
    // Claiming one finger of a pinch is not a gesture any tool wants: the other finger
    // arrives, the engine sees two pointers, and the chart zooms underneath a drawing.
    // `pointerCount` is what lets a handler say no.
    const h = setup();
    const counts = [];
    h.chart.setPointerClaimHandler((claim) => {
        counts.push(claim.pointerCount);
        return claim.pointerCount === 0;
    });

    h.pointer('pointerdown', 400, 250, { id: 1, pointerType: 'touch' });
    h.pointer('pointerdown', 600, 250, { id: 2, pointerType: 'touch' });
    h.pointer('pointermove', 500, 250, { id: 1, pointerType: 'touch' });
    h.pointer('pointermove', 700, 250, { id: 2, pointerType: 'touch' });
    h.pointer('pointerup', 500, 250, { id: 1, pointerType: 'touch' });
    h.pointer('pointerup', 700, 250, { id: 2, pointerType: 'touch' });

    // The first press is claimed and tracked by id, deliberately outside the set a pinch
    // is built from, so the second press still reports zero pointers down. That is the
    // behaviour that keeps a second finger from becoming a pinch under a claimed drag —
    // and it is why a handler must count its *own* outstanding claims rather than read
    // `pointerCount` as "presses down".
    assert.deepEqual(counts, [0, 0], 'a claimed press entered the pinch bookkeeping');
    h.flush();
    h.dispose();
});

test('a claimed press does not scale the price pane', () => {
    // The gutter is a separate gesture, and a tool working in the plot must not be able
    // to leave a vertical drag behind either.
    const h = setup();
    h.chart.setPointerClaimHandler(() => true);
    const before = h.chart.getPriceRange();

    h.pointer('pointerdown', 10, 250);
    h.pointer('pointermove', 10, 350);
    h.pointer('pointerup', 10, 350);

    assert.deepEqual(h.chart.getPriceRange(), before, 'the price pane scaled during a claimed drag');
    h.flush();
    h.dispose();
});

test('a handler that throws does not claim, and does not break the chart', () => {
    // The fallback direction is the point. A handler failing on every press would
    // otherwise leave a chart that cannot be panned at all, with nothing on screen
    // explaining why.
    const h = setup();
    const originalError = console.error;
    console.error = () => {};
    try {
        h.chart.setPointerClaimHandler(() => { throw new Error('boom'); });
        const before = h.chart.getVisibleLogicalRange().from;
        h.pointer('pointerdown', 500, 250);
        h.pointer('pointermove', 700, 250);
        h.pointer('pointerup', 700, 250);
        assert.notEqual(
            h.chart.getVisibleLogicalRange().from, before,
            'a throwing handler stopped the chart from panning',
        );
    } finally {
        console.error = originalError;
    }
    h.flush();
    h.dispose();
});

test('replacing the handler drops an outstanding claim', () => {
    // A handler swapped mid-gesture cannot take over a press that is already
    // outstanding, so the chart must become pannable immediately rather than stay
    // claimed against a handler the caller has discarded.
    const h = setup();
    h.chart.setPointerClaimHandler(() => true);
    h.pointer('pointerdown', 500, 250);
    h.chart.setPointerClaimHandler(() => false);
    h.pointer('pointerup', 500, 250);

    const before = h.chart.getVisibleLogicalRange().from;
    h.pointer('pointerdown', 500, 250);
    h.pointer('pointermove', 700, 250);
    h.pointer('pointerup', 700, 250);
    assert.notEqual(h.chart.getVisibleLogicalRange().from, before, 'the stale claim survived');
    h.flush();
    h.dispose();
});

test('setPointerClaimHandler rejects a non-function and null clears it', () => {
    const h = setup();
    assert.throws(
        () => h.chart.setPointerClaimHandler(42),
        /MatrixCharts: setPointerClaimHandler requires a function or null\./,
    );
    h.chart.setPointerClaimHandler(() => true);
    h.chart.setPointerClaimHandler(null);
    const before = h.chart.getVisibleLogicalRange().from;
    h.pointer('pointerdown', 500, 250);
    h.pointer('pointermove', 700, 250);
    h.pointer('pointerup', 700, 250);
    assert.notEqual(h.chart.getVisibleLogicalRange().from, before, 'null did not unregister');
    h.flush();
    h.dispose();
});

test('a destroyed chart drops the claim handler and refuses both new methods', () => {
    const h = setup();
    h.chart.setPointerClaimHandler(() => true);
    h.chart.destroy();
    assert.throws(
        () => h.chart.setPointerClaimHandler(() => true),
        /MatrixCharts: This chart has been destroyed\./,
    );
    assert.throws(
        () => h.chart.redraw(),
        /MatrixCharts: This chart has been destroyed\./,
    );
    h.flush();
    h.dispose();
});

// --- the reachable repaint ---------------------------------------------------

test('redraw() repaints every layer, which the renderer log records', () => {
    // Asserted on the renderers rather than on a painter's output, because the headless
    // UI stub records a registered painter without invoking it — the invocation is the
    // real Canvas2DRenderer's, and the seam test covers that separately. What belongs
    // here is that one call reaches all three layers.
    const h = setup();
    h.flush();
    const baseline = h.rendererLog.length;

    h.chart.redraw();
    const layers = h.rendererLog.slice(baseline).map(([layer, call]) => `${layer}:${call}`);
    for (const name of ['grid', 'data', 'ui']) {
        assert.ok(
            layers.some((entry) => entry === `${name}:render`),
            `redraw() did not render the ${name} layer (saw ${JSON.stringify(layers)})`,
        );
    }
    h.flush();
    h.dispose();
});

test('redraw() emits no viewport event', () => {
    // Nothing about the chart's state changed, so a subscriber must not be woken. A
    // repaint that re-notified would make a tool that repaints on every mouse move
    // produce an event storm.
    const h = setup();
    const events = [];
    h.chart.subscribeVisibleRangeChange((event) => events.push(event));
    h.chart.setVisibleLogicalRange({ from: 0, to: 100 });
    h.flush();
    const before = events.length;

    h.chart.redraw();
    h.chart.redraw();
    h.chart.redraw();
    assert.equal(events.length, before, 'redraw() notified a viewport subscriber');
    h.flush();
    h.dispose();
});

test('redraw() is idempotent and does not move the view', () => {
    const h = setup();
    const before = h.chart.getVisibleLogicalRange();
    h.chart.redraw();
    h.chart.redraw();
    assert.deepEqual(h.chart.getVisibleLogicalRange(), before, 'redraw() moved the viewport');
    h.flush();
    h.dispose();
});
