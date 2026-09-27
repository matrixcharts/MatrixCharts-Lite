// Chart-level tests for the live-edge affordance.
//
// The finding behind this file: the demo showed `visible 103..154 of 181` and read as a
// frozen feed. Nothing was frozen — the view had been panned, `followsLiveEdge` was off,
// and the feed was appending into a window nobody was looking at. A chart that is twenty-six
// bars behind a live feed is pixel-identical to a dead one.
//
// The fix is deliberately not in the engine. No badge, no banner, no button: the chart
// reports the state and the caller's UI decides what to do with it, because a charting
// library that draws its own chrome is a charting library every application has to fight.
// What is here is the data — a boolean on the event that already fires — plus the two
// methods that let a caller read it and act on it.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createHeadlessChart, flatCandles } = require('./support/headlessChart.cjs');

/** A chart with data and every visible-range event recorded, in order. */
function watching(count = 200) {
    const harness = createHeadlessChart();
    // Subscribed before the data, which is the order a UI uses: the first range event
    // arrives with `setData`, and a subscriber added afterwards never sees it.
    const events = [];
    harness.chart.subscribeVisibleRangeChange((event) => events.push(event));
    harness.chart.setData(flatCandles(count));
    harness.flush();
    return { harness, events };
}

/**
 * A drag to the right, which is the gesture that leaves the chart *behind* a live feed:
 * the content follows the pointer, older bars are revealed on the left, and the newest
 * bar ends up off screen to the right.
 *
 * The opposite drag matters too and is the more common accident. Dragging left moves the
 * content off the right edge and puts the chart *past* the data, with empty space beside
 * it. The live-edge latch is off either way, so `isAtRealtime()` cannot tell them apart —
 * but `visible.to` is clamped to the last bar in the second case, so a test that wants to
 * reason about being behind has to drag the right way.
 */
const panBehind = (harness) => harness.drag(300, 300, 700, 300);

/** Every distinct value of `atRealtime` the subscriber saw, in order. */
const realtimeStates = (events) => events
    .map((event) => event.atRealtime)
    .filter((value, index, all) => index === 0 || value !== all[index - 1]);

test('the event says whether the chart is following, and it agrees with the method', () => {
    const { harness, events } = watching();
    try {
        // A chart that has never been touched is following.
        harness.flush();
        assert.ok(events.length > 0, 'setData should have reported a range');
        assert.equal(events[0].atRealtime, true);
        assert.equal(events[0].atRealtime, harness.chart.isAtRealtime());

        // Panned away: the event that reports the pan says so.
        panBehind(harness);
        harness.flush();
        assert.equal(harness.chart.isAtRealtime(), false, 'the pan did not take');
        const panned = events[events.length - 1];
        assert.equal(panned.atRealtime, false);
        assert.equal(panned.atRealtime, harness.chart.isAtRealtime());
    } finally {
        harness.dispose();
    }
});

test('scrollToRealtime puts the view back and says so in the same event', () => {
    const { harness, events } = watching();
    try {
        panBehind(harness);
        harness.flush();
        assert.equal(harness.chart.isAtRealtime(), false);
        const behind = harness.chart.getVisibleLogicalRange().to;
        assert.ok(behind < harness.chart.getCandleCount(), 'the pan did not take us behind the feed');

        harness.chart.scrollToRealtime();
        harness.flush();
        assert.equal(harness.chart.isAtRealtime(), true);
        const back = events[events.length - 1];
        assert.equal(back.atRealtime, true, 'the event did not report the return to the live edge');
        assert.equal(back.logical.to, harness.chart.getCandleCount(), 'the newest bar is still off screen');
        assert.equal(harness.chart.isAtRealtime(), back.atRealtime);
    } finally {
        harness.dispose();
    }
});

test('every change of the flag arrives on an event, in both directions', () => {
    // The claim the field's usefulness rests on. `atRealtime` is the `followsLiveEdge`
    // latch, and the latch only moves in three places — a pan away from the edge,
    // `fitContent` and `scrollToRealtime` — each of which changes which bars are on
    // screen, so each of which the event already fires for. If that were ever untrue the
    // field would silently go stale, and a UI showing a LIVE badge would be lying. So it
    // is walked back and forth and every transition is required to be observable.
    //
    // Small steps, because a fast pan can cross the edge in one move and a slow one can
    // stop short of it, and both are real gestures.
    const { harness, events } = watching(120);
    try {
        for (let step = 0; step < 6; step++) {
            panBehind(harness);
            harness.flush();
            harness.chart.scrollToRealtime();
            harness.flush();
        }
        const states = realtimeStates(events);
        assert.ok(states.includes(false), 'never observed the chart behind the feed');
        assert.ok(states.includes(true), 'never observed the chart back at the feed');
        assert.equal(states[states.length - 1], true, 'the loop should end at the live edge');
        // No gap: every event carries a boolean, and it only ever alternates.
        for (const event of events) {
            assert.equal(typeof event.atRealtime, 'boolean', 'the field must be a boolean, not absent');
        }
    } finally {
        harness.dispose();
    }
});

test('a chart with no data is trivially following, and reports nothing to say so', () => {
    // "Behind the feed" needs a feed. With nothing loaded the latch is on, there is no
    // state to be behind, and no event fires — a UI that keys its badge off the event
    // keeps whatever it had, which is the honest outcome rather than a badge claiming to
    // follow an empty chart.
    const harness = createHeadlessChart();
    const events = [];
    try {
        harness.chart.subscribeVisibleRangeChange((event) => events.push(event));
        assert.equal(harness.chart.isAtRealtime(), true);
        assert.equal(harness.chart.getCandleCount(), 0);
        harness.flush();
        assert.equal(events.length, 0, 'an empty chart should not report a range change');
        // And the call is safe, and still a no-op.
        harness.chart.scrollToRealtime();
        harness.flush();
        assert.equal(harness.chart.isAtRealtime(), true);
        assert.equal(events.length, 0);
    } finally {
        harness.dispose();
    }
});

test('a feed that keeps arriving while the view is panned does not re-latch it', () => {
    // The behaviour that made the demo look broken. A view the caller has taken over must
    // stay taken over: the feed appending is not a reason to move someone's window, and
    // the flag must not quietly return to `true` because bars arrived.
    const { harness, events } = watching(60);
    try {
        panBehind(harness);
        harness.flush();
        assert.equal(harness.chart.isAtRealtime(), false);
        const before = harness.chart.getVisibleLogicalRange().to;

        harness.chart.appendBatch(flatCandles(20, { from: 1_700_000_000_000 + 60 * 60_000 }));
        harness.flush();
        assert.equal(harness.chart.isAtRealtime(), false, 'appending re-latched a panned chart');
        assert.equal(harness.chart.getVisibleLogicalRange().to, before, 'appending moved a panned view');
        assert.equal(events[events.length - 1].atRealtime, false);
    } finally {
        harness.dispose();
    }
});
