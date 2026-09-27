// Chart-level tests for session breaks: the read path and the draw path agreeing about
// where a bar is.
//
// Every function in `sessionScale` is pure and tested there. What none of those tests
// can reach is the question that actually broke: whether the chart *uses* the slot table
// at each of the four places that turn a bar into a pixel. Four separate index/slot
// confusions shipped in this one, and each was invisible in review, invisible in the
// pure tests, and invisible to the headless chart tests — because the data-layer double
// recorded the *length* of the candle buffer and threw the coordinates away.
//
// So the double records the records, and the fixture is one with breaks wide enough
// that every one of the four mistakes moves a candle by more than a bar.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createHeadlessChart } = require('./support/headlessChart.cjs');
const { ChartFeedController } = require('../.test-build/feed/ChartFeedController.js');
const {
    computeSlotOffsets,
    resolveSessionBreaks,
    sizeSessionBreaks,
    slotAtIndex,
    totalSlots,
} = require('../.test-build/core/sessionScale.js');
const { CANDLE_STRIDE, CANDLE_X } = require('../.test-build/math/candleLayout.js');

const MINUTE = 60_000;
const SESSION_OPEN = Date.UTC(2025, 0, 6, 14, 30);
const PLOT_WIDTH = 1200 - 78; // the headless container less the default price gutter

/** 50 bars a session, three sessions, 17h apart. Fifty so a break lands mid-bucket. */
function sessionCandles(sessions = 3, perSession = 50) {
    const out = [];
    let cursor = SESSION_OPEN;
    for (let session = 0; session < sessions; session++) {
        for (let i = 0; i < perSession; i++) {
            const close = 100 + Math.sin(i / 5) * 3;
            out.push({ time: cursor + i * MINUTE, open: close, high: close + 0.5, low: close - 0.5, close, volume: 10 });
        }
        cursor += perSession * MINUTE + 17 * 60 * MINUTE;
    }
    return out;
}

/**
 * The slot table `Chart.rebuildSlots` builds, mirrored option for option.
 *
 * The mode is passed explicitly at every call site rather than defaulted here, because the
 * chart's own default is `collapsed` and a helper that quietly disagrees with it produces
 * a wrong expectation that looks like a right answer: the failure is then an offset of
 * exactly the difference between the two modes, which reads as a rendering bug in the code
 * under test rather than as a fixture mistake. That cost two debugging detours.
 */
function slotTable(candles, { mode, enabled = true } = {}) {
    const times = candles.map((candle) => candle.time);
    if (!enabled) return null;
    const resolved = resolveSessionBreaks(times, { mode });
    return computeSlotOffsets(times, sizeSessionBreaks(times, resolved));
}

/** The x of every record the data layer was handed, in slot units. */
function drawnX(dataRenderer) {
    const candles = dataRenderer.lastCandles;
    const xs = [];
    for (let offset = 0; offset < candles.length; offset += CANDLE_STRIDE) xs.push(candles[offset + CANDLE_X]);
    return xs;
}

function chartWith(candles, options) {
    const harness = createHeadlessChart(options);
    harness.chart.setData(candles);
    harness.flush();
    return harness;
}

test('fitContent shows every bar, gaps included', () => {
    // Dividing the plot width by the bar count rather than the slot count asks for a
    // spacing wide enough for the bars and forgets the gaps, so the series comes out
    // wider than the plot and the overflow hangs off the left. The result is not a chart
    // the caller can scroll to: a fifth of the data is simply not there.
    const candles = sessionCandles();
    const slots = slotTable(candles, { mode: 'proportional' });
    const harness = chartWith(candles, { timeScale: { sessionBreaks: { mode: 'proportional' } } });
    try {
        harness.chart.fitContent();
        harness.flush();
        const range = harness.chart.getVisibleLogicalRange();
        assert.equal(range.from, 0, `fitContent started at bar ${range.from}, so ${candles.length - range.from} bars are off-screen`);
        assert.ok(range.to >= candles.length, `fitContent stopped at ${range.to} of ${candles.length}`);

        // And the spacing it chose is the one that actually fits the slots.
        const expected = PLOT_WIDTH / totalSlots(slots);
        assert.ok(
            Math.abs(harness.chart.getBarSpacing() - expected) < 1e-6,
            `spacing ${harness.chart.getBarSpacing()} should be ${expected}`,
        );
        assert.ok(
            harness.chart.getBarSpacing() < PLOT_WIDTH / candles.length,
            'the spacing ignored the gaps and is the width that fit the bars alone',
        );
    } finally {
        harness.dispose();
    }
});

test('fitContent is unchanged on a series with no breaks', () => {
    // The no-breaks path must be the identity, or every existing consumer shifts.
    const candles = Array.from({ length: 200 }, (_, i) => ({
        time: SESSION_OPEN + i * MINUTE, open: 100, high: 101, low: 99, close: 100.5, volume: 10,
    }));
    const harness = chartWith(candles);
    try {
        harness.chart.fitContent();
        harness.flush();
        assert.equal(harness.chart.getVisibleLogicalRange().from, 0);
        assert.ok(Math.abs(harness.chart.getBarSpacing() - PLOT_WIDTH / 200) < 1e-6);
    } finally {
        harness.dispose();
    }
});

test('the cull keeps the bar at the left edge of the plot', () => {
    // The window is found through the slot table, so a break to the left of the plot's
    // edge cannot make it name a bar further right than the one on screen. If it did,
    // the slice would start after bars that are still on the plot and the left of the
    // chart would be empty.
    //
    // Asserted at level 0, where a drawn x *is* a bar's slot, so the claim can be exact:
    // the slot of the first visible bar has to be one of the slots drawn. Comparing a
    // bucket's centre against a bar's slot at an aggregated level is not a like-for-like
    // comparison — a bucket legitimately sits to the right of the first bar it covers —
    // which is why the aggregated levels are covered by the two tests below instead.
    for (const [sessions, perSession] of [[2, 50], [2, 100], [3, 50]]) {
        const candles = sessionCandles(sessions, perSession);
        const slots = slotTable(candles, { mode: 'proportional' });
        const harness = chartWith(candles, { timeScale: { sessionBreaks: { mode: 'proportional' } } });
        try {
            harness.chart.fitContent();
            harness.flush();
            const xs = drawnX(harness.dataRenderer);
            const range = harness.chart.getVisibleLogicalRange();
            assert.ok(harness.chart.getBarSpacing() > 3,
                `${candles.length} bars should be drawn at level 0, spacing was ${harness.chart.getBarSpacing()}`);

            const firstSlot = slotAtIndex(slots, Math.floor(range.from));
            const lastSlot = slotAtIndex(slots, Math.ceil(range.to) - 1);
            assert.ok(
                xs.some((x) => Math.abs(x - firstSlot) < 1e-6),
                `${candles.length} bars: the bar at the plot's left edge (slot ${firstSlot}) was culled; drew ${xs[0]}..${xs[xs.length - 1]}`,
            );
            assert.ok(
                xs.some((x) => Math.abs(x - lastSlot) < 1e-6),
                `${candles.length} bars: the bar at the plot's right edge (slot ${lastSlot}) was culled`,
            );
            for (let i = 1; i < xs.length; i++) {
                assert.ok(xs[i] > xs[i - 1], `${candles.length} bars: x went backwards at ${i}`);
            }
        } finally {
            harness.dispose();
        }
    }
});

test('candles are drawn at their own slot, not at an ordinal wearing a slot label', () => {
    // Level 0 was the only level that mapped through the slot table; every aggregated
    // level handed the shader a raw ordinal, which it then transformed as though it
    // were a slot. Each candle drifted left by the sum of the breaks before it, so the
    // error grows the further right you look and is worst exactly where the gaps are.
    const candles = sessionCandles();
    const slots = slotTable(candles, { mode: 'proportional' });
    const harness = chartWith(candles, { timeScale: { sessionBreaks: { mode: 'proportional' } } });
    try {
        harness.chart.fitContent();
        harness.flush();
        const xs = drawnX(harness.dataRenderer);
        // Aggregated: every x must be a slot position of some real bar or bucket, and
        // never smaller than the ordinal it came from — the gaps only ever add width.
        const ordinalOf = (slot) => {
            let best = 0;
            for (let i = 0; i < candles.length; i++) {
                if (slotAtIndex(slots, i) <= slot + 1e-9) best = i;
            }
            return best;
        };
        for (const x of xs) {
            assert.ok(x >= ordinalOf(x) - 1e-9, `x ${x} is left of the bar it came from`);
        }
        // The decisive one: the last candle of the last session belongs at the far right,
        // and a raw ordinal would put it short by every break in the series.
        const lastBar = slotAtIndex(slots, candles.length - 1);
        const lastDrawn = xs[xs.length - 1];
        assert.ok(
            Math.abs(lastDrawn - lastBar) < 1e-6,
            `the last candle is at slot ${lastDrawn}, its bar is at ${lastBar}`,
        );
        assert.ok(
            lastDrawn - (candles.length - 1) > 1,
            'the drawing is not offset at all, so this fixture is not exercising the bug',
        );
    } finally {
        harness.dispose();
    }
});

test('an overlay lands on the candle it annotates, at the aggregated level', () => {
    const candles = sessionCandles();
    const slots = slotTable(candles, { mode: 'proportional' });
    // Overlays are registered by method rather than by option, so this is the call a
    // caller makes rather than one the constructor accepts.
    const harness = createHeadlessChart({ timeScale: { sessionBreaks: { mode: 'proportional' } } });
    try {
        harness.chart.setData(candles);
        harness.chart.setOverlays([{
            id: 'ema',
            points: candles.map((candle) => ({ time: candle.time, value: candle.close })),
        }]);
        harness.flush();
        harness.chart.fitContent();
        harness.flush();

        const candleXs = drawnX(harness.dataRenderer);
        assert.ok(candleXs.length > 4, 'expected an aggregated level to draw several candles');
        const points = harness.dataRenderer.overlays.ema.points;
        const overlayXs = [];
        for (let i = 0; i < points.length; i += 2) overlayXs.push(points[i]);

        // Both sides converted their bucket through one function, so the sets of x
        // overlap exactly over the shared range. Before the fix the overlay went
        // through the slot table and the candles did not, so at an aggregated level the
        // two were in different places by the sum of the breaks to their left.
        const shared = overlayXs.filter((x) => x >= candleXs[0] - 1e-6 && x <= candleXs[candleXs.length - 1] + 1e-6);
        assert.ok(shared.length > 2, `only ${shared.length} overlay points were in the drawn range`);
        for (const x of shared) {
            const nearest = candleXs.reduce((best, c) => (Math.abs(c - x) < Math.abs(best - x) ? c : best), candleXs[0]);
            assert.ok(
                Math.abs(nearest - x) < 1e-6,
                `overlay at slot ${x} has no candle there; nearest is ${nearest}`,
            );
        }
        // And the offset is real, so the test is not passing on an identity mapping.
        assert.ok(totalSlots(slots) > candles.length, 'the fixture has no gaps');
    } finally {
        harness.dispose();
    }
});

test('a series with breaks disabled takes the index path end to end', () => {
    // The control. Every assertion above is about a difference from this.
    const candles = sessionCandles();
    const harness = chartWith(candles, { timeScale: { sessionBreaks: { enabled: false } } });
    try {
        harness.chart.fitContent();
        harness.flush();
        const xs = drawnX(harness.dataRenderer);
        assert.equal(harness.chart.getBarSpacing() > 0, true);
        assert.ok(
            Math.abs(harness.chart.getBarSpacing() - PLOT_WIDTH / candles.length) < 1e-6,
            'spacing should divide the plot by the bar count when there are no gaps',
        );
        assert.equal(xs[0], 0, 'the first bar is at slot 0 with no gaps');
    } finally {
        harness.dispose();
    }
});

test('appending across a session break draws the new bars and keeps following', () => {
    // A live feed is the one path that mutates an existing series rather than replacing
    // it, and it is the one path that never rebuilt the slot table: `rebuildSlots` ran on
    // `setData`, on `applyOptions` and on the *replace* branch, and not on append. So the
    // table went on describing the series as it was before the append, and three things
    // read it — the live-edge shift, the visible-window cull, and the axis ticks. All
    // three clamp to the table's length, so all three quietly stopped at the last bar
    // that existed when the data was last replaced: the new bars were in the array and
    // off the screen, the cull reported a visible range that stopped short of them, and
    // the axis drew its last label one bar early and bunched it against the edge.
    //
    // Reproduced with a proportional break so the gap is wide enough that a slot-space
    // answer and an index-space one cannot be confused for each other.
    const first = sessionCandles(1, 50);
    const gapHours = 17;
    const resumeAt = first[first.length - 1].time + gapHours * 60 * MINUTE;
    const second = [];
    for (let i = 0; i < 50; i++) {
        const close = 100 + Math.sin(i / 5) * 3;
        second.push({
            time: resumeAt + i * MINUTE, open: close, high: close + 0.5, low: close - 0.5, close, volume: 10,
        });
    }
    const all = first.concat(second);
    const slots = slotTable(all, { mode: 'proportional' });
    const lastBar = all.length - 1;

    const harness = createHeadlessChart({ timeScale: { sessionBreaks: { mode: 'proportional' } } });
    try {
        harness.chart.setData(first);
        harness.flush();
        harness.chart.appendBatch(second);
        harness.flush();

        assert.equal(harness.chart.getCandleCount(), all.length, 'the bars did not arrive');

        // 1. The cull must see the new bars. It asks the table, so a stale table stops it
        //    short of them however many the array holds.
        const range = harness.chart.getVisibleLogicalRange();
        assert.ok(
            range.to > first.length,
            `the visible range stops at ${range.to}, before the appended bars at ${first.length}..${lastBar}`,
        );

        // 2. And they must actually be drawn, at their own slots.
        const xs = drawnX(harness.dataRenderer);
        const lastSlot = slotAtIndex(slots, lastBar);
        assert.ok(
            Math.abs(xs[xs.length - 1] - lastSlot) < 1e-6,
            `the last candle is at slot ${xs[xs.length - 1]}, its bar is at ${lastSlot}`,
        );
        // The break must be a gap and not a tear: the drawn x's have to clear the whole of
        // it, which they cannot if the appended bars are placed in index space.
        const lastOfFirst = slotAtIndex(slots, first.length - 1);
        const firstOfSecond = slotAtIndex(slots, first.length);
        assert.ok(
            xs[xs.length - 1] >= firstOfSecond,
            'the appended bars were drawn left of the break they follow',
        );
        assert.ok(firstOfSecond - lastOfFirst > 1, 'the fixture has no gap to cross');

        // 3. The chart was following the live edge before the append, so it must still be
        //    parked at it — half a bar inside the plot's right edge, not where the stale
        //    table said the old last bar was.
        const spacing = harness.chart.getBarSpacing();
        const lastX = harness.chart.indexToCoordinate(lastBar);
        const plotRight = 1200;
        assert.ok(
            Math.abs(lastX - (plotRight - 0.5 * spacing)) < 1e-6,
            `the live edge is at ${lastX}, expected ${plotRight - 0.5 * spacing}`,
        );
        assert.equal(harness.chart.isAtRealtime(), true, 'the chart stopped following the live edge');
    } finally {
        harness.dispose();
    }
});

test('a panned chart holds its bars still when a session break is appended', () => {
    // The other half of the same branch. A chart that has been panned off the live edge
    // keeps the bars it is looking at where they are, and the shift that does that was
    // measured in bars while the axis is in slots — so a pinned bar moves by half a gap
    // every time a session closes underneath a feed left running.
    const first = sessionCandles(1, 50);
    const resumeAt = first[first.length - 1].time + 17 * 60 * MINUTE;
    const second = [];
    for (let i = 0; i < 50; i++) {
        const close = 100 + Math.sin(i / 5) * 3;
        second.push({
            time: resumeAt + i * MINUTE, open: close, high: close + 0.5, low: close - 0.5, close, volume: 10,
        });
    }
    const all = first.concat(second);
    const slots = slotTable(all, { mode: 'proportional' });

    const harness = createHeadlessChart({ timeScale: { sessionBreaks: { mode: 'proportional' } } });
    try {
        harness.chart.setData(first);
        harness.flush();
        // Pan so the live edge latch is off. Dragging left moves the view towards older
        // bars, which is the direction that leaves the newest bar off the right edge.
        harness.drag(600, 300, 300, 300);
        harness.flush();
        assert.equal(harness.chart.isAtRealtime(), false, 'the pan did not take, so this proves nothing');
        const before = harness.chart.indexToCoordinate(20);

        harness.chart.appendBatch(second);
        harness.flush();

        const after = harness.chart.indexToCoordinate(20);
        assert.ok(
            Math.abs(after - before) < 1e-6,
            `bar 20 moved from x ${before} to ${after} when a session break was appended`,
        );
        // And the break is still honoured for the bar that now precedes it.
        assert.ok(slotAtIndex(slots, first.length) - slotAtIndex(slots, first.length - 1) > 1);
    } finally {
        harness.dispose();
    }
});

/**
 * A feed source whose every message is asked for, so a session break lands on a bar the
 * test chose rather than on whichever one a timer happened to reach.
 *
 * A real `MockCandleSource` is the wrong tool here for the same reason a wall clock is:
 * the interesting event is a single bar crossing a 17-hour gap, and a timer makes that a
 * race. `MockCandleSource` has its own tests; what is untested here is whether the chart
 * keeps up with what a feed hands it.
 */
class ScriptedSource {
    constructor(barTimes) {
        this.times = barTimes;
        this.listeners = new Set();
        this.sequence = 0;
        this.started = false;
    }

    get state() {
        return this.started ? 'connected' : 'idle';
    }

    subscribe(onMessage) {
        this.listeners.add(onMessage);
        return () => this.listeners.delete(onMessage);
    }

    start() {
        this.started = true;
    }

    stop() {
        this.started = false;
    }

    emit(message) {
        this.sequence += 1;
        for (const listener of this.listeners) listener({ ...message, sequence: this.sequence });
    }

    /** The opening snapshot: every bar up to and including `count`. */
    snapshot(count) {
        this.emit({ type: 'snapshot', candles: this.times.slice(0, count).map(candleAt) });
    }

    /** One append of the bars from `from` to `to`, exclusive. */
    append(from, to) {
        this.emit({ type: 'append', candles: this.times.slice(from, to).map(candleAt) });
    }
}

const candleAt = (time) => {
    const close = 100 + Math.sin(time / 3.6e6) * 3;
    return { time, open: close, high: close + 0.5, low: close - 0.5, close, volume: 10 };
};

test('a feed that crosses a session break on its own keeps the chart with it', () => {
    // The reported symptom, on the real feed wiring: a tape running across a close, the
    // data array growing, the newest bars on no screen. The two tests above drive
    // `appendBatch` directly, which is the same chart path but leaves the controller and
    // the message shapes untested — and the controller is what a caller runs.
    //
    // The break is on bar 12, so the snapshot ends four bars short of it and the first
    // append is what introduces it. That ordering is the whole defect: the series that
    // existed when the table was last built contained no break at all, so the table was
    // null, and nothing rebuilt it when the first one appeared.
    const times = [];
    let cursor = SESSION_OPEN;
    for (let bar = 0; bar < 40; bar++) {
        if (bar === 12 || bar === 26) cursor += 17 * 60 * MINUTE;
        times.push(cursor);
        cursor += MINUTE;
    }

    const harness = createHeadlessChart({ timeScale: { sessionBreaks: { mode: 'proportional' } } });
    const source = new ScriptedSource(times);
    const controller = new ChartFeedController(harness.chart, source);
    try {
        source.snapshot(8);
        harness.flush();
        assert.equal(harness.chart.getCandleCount(), 8, 'the snapshot did not land');

        // Bar 8..12 is still the first session; bar 12 opens the second.
        source.append(8, 12);
        harness.flush();
        assert.equal(harness.chart.getCandleCount(), 12);
        assert.ok(harness.chart.isAtRealtime(), 'the chart stopped following before the break');

        source.append(12, 30);
        harness.flush();

        const count = harness.chart.getCandleCount();
        assert.equal(count, 30, 'the bars did not arrive');
        // Candles, not timestamps: the helper reads `candle.time`, and handing it a list
        // of numbers yields a table of NaNs, which resolves to the identity rather than
        // failing — a wrong expectation that looks like a right answer.
        const slots = slotTable(times.slice(0, count).map(candleAt), { mode: 'proportional' });
        assert.ok(slots !== null, 'the series now has breaks');

        // The live edge is on the newest bar, not on the last bar the table knew about.
        const range = harness.chart.getVisibleLogicalRange();
        assert.ok(range.to > count - 3, `the visible range stops at ${range.to} of ${count} bars`);
        assert.equal(harness.chart.isAtRealtime(), true, 'the chart stopped following');

        // And the newest bar is drawn at its own slot, not at its ordinal — the two differ
        // by the whole of every break before it, which is why ordinals looked like the
        // candles had been thrown off the right-hand edge.
        const xs = drawnX(harness.dataRenderer);
        const lastSlot = slotAtIndex(slots, count - 1);
        assert.ok(
            Math.abs(xs[xs.length - 1] - lastSlot) < 1e-6,
            `the newest candle is at slot ${xs[xs.length - 1]}, its bar is at ${lastSlot}`,
        );
        assert.ok(
            lastSlot - (count - 1) > 1,
            'the drawing is not offset, so this fixture is not exercising the break',
        );
        for (let i = 1; i < xs.length; i++) {
            assert.ok(xs[i] > xs[i - 1], `x went backwards at ${i}`);
        }
    } finally {
        controller.dispose();
        harness.dispose();
    }
});

test("the demo's own shape: a stale table, not a missing one", () => {
    // The configuration that was reported, and it is a different failure from the test
    // above. Here the snapshot is 120 bars with a session break every 30, so the table is
    // *not* null when the feed starts — it is merely 120 entries long and describes the
    // series as it was at the first snapshot. That distinction decides the symptom:
    //
    // - Every read of the table clamps to its length, so the visible-window cull stopped
    //   at exactly bar 120 and reported `visible 48..120 of 124` however many bars the
    //   array went on to hold.
    // - The axis ticks stopped one bar later rather than one bar earlier, because
    //   `barsBeforeSlot` answers "one past the last bar whose left edge is before this
    //   slot", and a slot past the end of a stale table lands it one bar too far. Those
    //   surplus ticks then had nowhere to go but the right-hand edge, which is where the
    //   bunched labels came from.
    //
    // With a null table instead, everything falls back to ordinals and the candles simply
    // appear off the right side. Two different-looking symptoms, one missing line.
    const times = [];
    let cursor = SESSION_OPEN;
    for (let bar = 0; bar < 200; bar++) {
        if (bar > 0 && bar % 30 === 0) cursor += 17 * 60 * MINUTE;
        times.push(cursor);
        cursor += MINUTE;
    }

    const harness = createHeadlessChart({ timeScale: { sessionBreaks: { mode: 'collapsed' } } });
    const source = new ScriptedSource(times);
    const controller = new ChartFeedController(harness.chart, source);
    try {
        source.snapshot(120);
        harness.flush();
        assert.equal(harness.chart.getCandleCount(), 120);
        // The snapshot's own breaks are present, so the table exists and is the right one.
        const snapshotSlots = slotTable(times.slice(0, 120).map(candleAt), { mode: 'collapsed' });
        assert.ok(snapshotSlots !== null, 'the snapshot should already contain breaks');

        // The feed crosses the break at bar 120 and runs on past it.
        source.append(120, 150);
        harness.flush();
        source.append(150, 175);
        harness.flush();

        const count = harness.chart.getCandleCount();
        assert.equal(count, 175, 'the bars did not arrive');

        // The cull must reach the newest bar rather than stopping at the snapshot's end.
        const range = harness.chart.getVisibleLogicalRange();
        assert.ok(
            range.to > 120,
            `the visible range stops at ${range.to}, which is where the snapshot ended`,
        );
        assert.equal(harness.chart.isAtRealtime(), true);

        // The newest bar's own coordinate must name it, which it cannot do if the
        // coordinate-to-index conversion is clamping against a table of 120.
        assert.equal(
            harness.chart.coordinateToIndex(harness.chart.indexToCoordinate(count - 1)),
            count - 1,
            'a bar cannot be placed at its own coordinate',
        );

        // And the ticks reach into the appended bars, so nothing is left bunched at the
        // right-hand edge.
        const xs = drawnX(harness.dataRenderer);
        const slots = slotTable(times.slice(0, count).map(candleAt), { mode: 'collapsed' });
        const lastSlot = slotAtIndex(slots, count - 1);
        assert.ok(
            Math.abs(xs[xs.length - 1] - lastSlot) < 1e-6,
            `the newest candle is at slot ${xs[xs.length - 1]}, its bar is at ${lastSlot}`,
        );
        assert.equal(
            harness.chart.getVisibleTimeRange().to,
            times[count - 1],
            'the reported time range does not reach the newest bar',
        );
    } finally {
        controller.dispose();
        harness.dispose();
    }
});

test('coordinateToSlot is the sub-bar precision coordinateToIndex rounds away', () => {
    // The reason the method exists. `coordinateToIndex` answers "which candle", which is
    // a whole number by definition; a hit-test needs "where in that candle", and a
    // drawing grabbed at a bar's left edge and one grabbed at its right edge are the same
    // point to the first method and different points to this one.
    const candles = sessionCandles();
    const harness = chartWith(candles, { timeScale: { sessionBreaks: { mode: 'proportional' } } });
    try {
        harness.chart.fitContent();
        harness.flush();
        const chart = harness.chart;
        const spacing = chart.getBarSpacing();
        const bar = 10;
        const left = chart.indexToCoordinate(bar) - spacing * 0.4;
        const right = chart.indexToCoordinate(bar) + spacing * 0.4;

        assert.equal(chart.coordinateToIndex(left), bar, 'the whole-bar answer cannot tell these apart');
        assert.equal(chart.coordinateToIndex(right), bar);
        assert.notEqual(
            chart.coordinateToSlot(left),
            chart.coordinateToSlot(right),
            'the sub-bar answer must, or the method has no reason to exist',
        );
        // And the fraction is where it should be: 0.1 of a bar to either side of centre.
        const centre = chart.coordinateToSlot(chart.indexToCoordinate(bar));
        assert.ok(Math.abs((chart.coordinateToSlot(left) - centre) + 0.4) < 1e-6);
        assert.ok(Math.abs((chart.coordinateToSlot(right) - centre) - 0.4) < 1e-6);
    } finally {
        harness.dispose();
    }
});

test('a bar and its slot are the same place, on both sides of a break', () => {
    // The round trip that matters, and the one that would have caught `slotAtIndex`
    // drifting half a gap to the right: the public pair has to agree about where a
    // candle is. Bar 49 is the last of its session, so it is the bar the old midpoint
    // got wrong, and the test says so by naming it.
    const candles = sessionCandles();
    const slots = slotTable(candles, { mode: 'proportional' });
    const harness = chartWith(candles, { timeScale: { sessionBreaks: { mode: 'proportional' } } });
    try {
        harness.chart.fitContent();
        harness.flush();
        const chart = harness.chart;
        for (const bar of [0, 1, 25, 49, 50, 75, 100, 149]) {
            const expected = slotAtIndex(slots, bar);
            const actual = chart.coordinateToSlot(chart.indexToCoordinate(bar));
            assert.ok(
                Math.abs(actual - expected) < 1e-6,
                `bar ${bar}: its slot reads as ${actual}, its own slot table says ${expected}`,
            );
        }
        // Named explicitly, because "the bar before the break" is the case the midpoint
        // got wrong and a list of indices does not make that obvious to a later reader.
        const lastOfSession = 49;
        const drift = Math.abs(
            chart.coordinateToSlot(chart.indexToCoordinate(lastOfSession)) - slotAtIndex(slots, lastOfSession),
        );
        assert.ok(drift < 1e-6, `bar ${lastOfSession} sits ${drift} slots from where it belongs`);
    } finally {
        harness.dispose();
    }
});

test('coordinateToSlot is the index on a series with no breaks, and is not clamped', () => {
    const candles = Array.from({ length: 200 }, (_, i) => ({
        time: SESSION_OPEN + i * MINUTE, open: 100, high: 101, low: 99, close: 100.5, volume: 10,
    }));
    const harness = chartWith(candles);
    try {
        harness.chart.fitContent();
        harness.flush();
        const chart = harness.chart;
        // With no breaks a slot *is* an ordinal, so the round trip is exact against the
        // index and the method is additive rather than a second answer.
        for (const bar of [0, 7, 100, 199]) {
            assert.ok(Math.abs(chart.coordinateToSlot(chart.indexToCoordinate(bar)) - bar) < 1e-6,
                `bar ${bar} did not round-trip`);
        }
        // Not clamped: a pointer dragged past either edge has to be able to see that it is
        // outside, which a clamped answer cannot report.
        const left = chart.coordinateToSlot(-500);
        const right = chart.coordinateToSlot(chart.indexToCoordinate(0) + 5000);
        assert.ok(left < 0, `a coordinate left of the series should read below slot 0, got ${left}`);
        assert.ok(right > 199, `a coordinate right of the series should read past the last bar, got ${right}`);
    } finally {
        harness.dispose();
    }
});
