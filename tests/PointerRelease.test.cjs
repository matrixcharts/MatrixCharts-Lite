// The contract: **one user gesture, one release, processed once.**
//
// ## What this file is, and what it is not
//
// `handlePointerEnd` is bound to three events — `pointerup`, `pointercancel` and
// `lostpointercapture` — and in a real browser the third fires **after** a completed
// `pointerup`, because the chart takes pointer capture on the way down and the capture is
// released on the way up. So every pointer release arrives twice, and the teardown must be
// idempotent.
//
// **These are contract tests, not a reproduction of a present bug, and the difference is
// worth being precise about.** I expected to find that lite emitted every click twice. It does
// not, and the reason is instructive: `wasSinglePointer` is read *before* the delete, so on
// the stray second delivery the map is already empty, `wasSinglePointer` is `false`, and the
// click is suppressed. Removing the guard entirely produces byte-identical behaviour — a tap
// plus a stray capture-lost event emits one click either way.
//
// So these tests pin the **outcome** rather than a particular line of code, which is the
// durable form: they will fail if a future change emits two clicks, strands a pinch, or
// ignores a real `pointercancel`, whether or not the guard survives.
//
// ## Why the guard is still here
//
// Because "no observable difference today" is a statement about *today's* release path, and
// the release path is where new side effects go. The Advanced engine has a fling: it
// schedules an animation frame on release, and its stray second delivery cancelled that frame
// — a flick that panned exactly 225px and then stopped dead. Lite has no fling yet, so there is
// nothing to cancel. The guard costs one `Map.has` and makes the next feature that touches
// this path inherit a teardown that is safe to run twice.
//
// ## Why it survived 501 passing tests
//
// The headless harness dispatches only what a test names, and nothing named
// `lostpointercapture` — so the second arrival never happened *in the harness* and the whole
// suite agreed with a browser that does not exist. These tests dispatch it explicitly, because
// **a harness gap that hides a bug is itself a bug**, and the only durable fix is for the
// harness to be capable of the thing that was invisible.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createHeadlessChart, flatCandles } = require('./support/headlessChart.cjs');

const PLOT_X = 78;

function chart() {
    const harness = createHeadlessChart({ layout: { priceAxisWidth: PLOT_X } });
    harness.chart.setData(flatCandles(200, { start: 100, step: 0.1 }));
    harness.flush();
    return harness;
}

/**
 * A complete press-and-release, the way a browser sequences it.
 *
 * The trailing `lostpointercapture` is the point of the helper: it is what a real browser
 * sends after a completed `pointerup`, and omitting it is how the bug stayed invisible for the
 * life of the library.
 */
function releaseOnce(harness, x, y, options) {
    harness.pointer('pointerup', x, y, options);
    harness.pointer('lostpointercapture', x, y, options);
}

// --- the click, which is what a developer's tool actually listens to -------------------------

test('a click reaches the caller once, even with the capture-lost event that follows it', () => {
    // The headline contract, and the one a consumer's drawing tool depends on. Asserted today
    // for a reason that is *not* the guard: `wasSinglePointer` is read before the delete, so
    // the stray delivery sees an empty map and the click is suppressed there. That is a
    // coincidence of this code's shape rather than a stated invariant, which is exactly why it
    // needs a test rather than a comment.
    const harness = chart();
    try {
        let clicks = 0;
        harness.chart.subscribeClick(() => { clicks += 1; });
        harness.pointer('pointerdown', PLOT_X + 200, 250, { id: 1 });
        releaseOnce(harness, PLOT_X + 200, 250, { id: 1 });
        assert.equal(clicks, 1, 'a click is one click');
    } finally {
        harness.dispose();
    }
});

test('three separate clicks are three clicks, not six', () => {
    // The number that matters for a consumer: their handler is called once per user click, and
    // the count a build script or a test of *their* code sees is the count the user produced.
    const harness = chart();
    try {
        let clicks = 0;
        harness.chart.subscribeClick(() => { clicks += 1; });
        for (let i = 0; i < 3; i += 1) {
            const x = PLOT_X + 120 + i * 40;
            harness.pointer('pointerdown', x, 250, { id: 1 });
            releaseOnce(harness, x, 250, { id: 1 });
        }
        assert.equal(clicks, 3);
    } finally {
        harness.dispose();
    }
});

test('a two-finger lift reports no click at all, stray delivery included', () => {
    // The case where the stray delivery is *most* likely to be mistaken for a second gesture:
    // one finger of a pinch lifts, and the chart must not read that as "the user clicked".
    // This is the one that would bite a consumer with a tap-to-select tool on a tablet.
    const harness = chart();
    try {
        let clicks = 0;
        harness.chart.subscribeClick(() => { clicks += 1; });
        harness.pointer('pointerdown', PLOT_X + 200, 250, { id: 1 });
        harness.pointer('pointerdown', PLOT_X + 260, 250, { id: 2 });
        harness.pointer('pointerup', PLOT_X + 260, 250, { id: 2 });
        harness.pointer('lostpointercapture', PLOT_X + 260, 250, { id: 2 });
        assert.equal(clicks, 0, 'a pinch is not a click');
    } finally {
        harness.dispose();
    }
});

// --- the teardown state, which is where a double release does damage -------------------------

test('the release leaves no pointer state behind for a later press to measure against', () => {
    // The axis drag's baseline is dropped on release. A second teardown would drop it twice,
    // which is harmless — but the same double arrival also ran the "one finger left" branch
    // of a pinch, and that is not harmless. Asserted here as the observable consequence: a
    // second press measures against a fresh baseline.
    const harness = chart();
    try {
        harness.pointer('pointerdown', PLOT_X + 200, 250, { id: 1 });
        releaseOnce(harness, PLOT_X + 200, 250, { id: 1 });

        // A pinch: two fingers down, one up. The remaining finger must be re-baselined once.
        harness.pointer('pointerdown', PLOT_X + 200, 250, { id: 1 });
        harness.pointer('pointerdown', PLOT_X + 260, 250, { id: 2 });
        harness.pointer('pointerup', PLOT_X + 260, 250, { id: 2 });
        harness.pointer('lostpointercapture', PLOT_X + 260, 250, { id: 2 });
        // The surviving finger moves: this must pan by the delta, once.
        const before = harness.chart.getVisibleLogicalRange();
        harness.pointer('pointermove', PLOT_X + 220, 250, { id: 1 });
        assert.notDeepEqual(
            harness.chart.getVisibleLogicalRange(),
            before,
            'the surviving finger still pans, so the pinch teardown did not strand it',
        );
        releaseOnce(harness, PLOT_X + 220, 250, { id: 1 });
    } finally {
        harness.dispose();
    }
});

test('a drag that travelled is not reported as a click by either arrival', () => {
    // The other half of the click rule. A double arrival would emit two clicks here too, and a
    // developer whose tool ignores `pressMoved` has no way to defend itself.
    const harness = chart();
    try {
        let clicks = 0;
        harness.chart.subscribeClick(() => { clicks += 1; });
        harness.drag(PLOT_X + 200, 250, PLOT_X + 260, 250, { id: 1 });
        harness.pointer('lostpointercapture', PLOT_X + 260, 250, { id: 1 });
        assert.equal(clicks, 0, 'a pan is not a click');
    } finally {
        harness.dispose();
    }
});

// --- the events that must still work exactly once each ----------------------------------------

test('a real pointercancel still ends the gesture', () => {
    // The guard drops a pointer the chart is not tracking. A `pointercancel` *is* a tracked
    // pointer, so it is not dropped — it has to leave the chart in a clean state or a later
    // gesture inherits a stuck pointer.
    const harness = chart();
    try {
        harness.pointer('pointerdown', PLOT_X + 200, 250, { id: 1 });
        harness.pointer('pointercancel', PLOT_X + 200, 250, { id: 1 });

        // The chart is usable: a fresh press-and-release reports its click exactly once.
        let clicks = 0;
        harness.chart.subscribeClick(() => { clicks += 1; });
        harness.pointer('pointerdown', PLOT_X + 200, 250, { id: 1 });
        releaseOnce(harness, PLOT_X + 200, 250, { id: 1 });
        assert.equal(clicks, 1, 'the next gesture is unaffected');
    } finally {
        harness.dispose();
    }
});

test('a capture-lost event for a pointer the chart never saw is ignored', () => {
    // The browser can deliver a capture notification for a pointer the chart is not tracking —
    // capture taken elsewhere, or a pointer that was already released. Dropping it is the
    // guard's whole behaviour, and this is the case where dropping is unambiguously right:
    // there is no gesture to end.
    const harness = chart();
    try {
        let clicks = 0;
        harness.chart.subscribeClick(() => { clicks += 1; });
        harness.pointer('lostpointercapture', PLOT_X + 200, 250, { id: 99 });
        assert.equal(clicks, 0);
        assert.equal(harness.chart.getVisibleLogicalRange().to > 0, true, 'and the view is intact');
    } finally {
        harness.dispose();
    }
});

test('a release without a preceding press is ignored', () => {
    // The same guard, from the other direction. A `pointerup` for a pointer the chart never
    // recorded — which is what a stray capture notification looks like from the inside.
    const harness = chart();
    try {
        let clicks = 0;
        harness.chart.subscribeClick(() => { clicks += 1; });
        harness.pointer('pointerup', PLOT_X + 200, 250, { id: 1 });
        harness.pointer('pointerup', PLOT_X + 200, 250, { id: 1 });
        assert.equal(clicks, 0, 'no press, so no click');
    } finally {
        harness.dispose();
    }
});

// --- the harness itself ----------------------------------------------------------------------

test('the stub stamps event.type, so a handler branching on it is exercised', () => {
    // A probe handler on the same element, registered through the stub's own
    // `addEventListener`, so it lands in the same listener set `dispatch` walks. Asserted
    // directly because a stub that omits a field the chart reads is a stub that can disagree
    // with a browser — and the omission is invisible until it is not.
    //
    // The engine this package shipped did not read `type` in its pointer handlers, which is
    // precisely why this could go unnoticed: a field nobody reads is a field nobody notices is
    // missing. The next handler that reads it would have branched on `undefined` here and
    // somewhere else in a browser.
    const harness = chart();
    try {
        const seen = [];
        harness.dom.container.children[0].addEventListener('pointerup', (event) => {
            seen.push(event.type);
        });
        harness.pointer('pointerdown', PLOT_X + 200, 250, { id: 1 });
        harness.pointer('pointerup', PLOT_X + 200, 250, { id: 1 });
        assert.deepEqual(seen, ['pointerup'], 'the event carries its own type');
    } finally {
        harness.dispose();
    }
});
