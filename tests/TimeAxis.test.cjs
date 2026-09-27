// Pure tests for src/core/timeAxis.ts.
//
// The defect this file exists for: the time axis stopped at the first session break.
// The old loop stepped in *slots*, and a slot inside a break resolves to the bar before
// it, so two ticks in the same break produced the same x and the loop's "x stopped
// advancing" exit fired there — taking every label and every vertical grid line to the
// right of it. It was invisible in review and invisible in the 231 tests, because the
// loop lived in a renderer that no headless test could reach.
//
// So the legacy algorithm is reproduced at the bottom of this file and asserted to
// truncate. A regression test that only describes the correct behaviour passes against
// code that was wrong; one that also pins the old failure says what it is guarding.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    timeAxisTicks,
    chooseTickStep,
    DEFAULT_MIN_LABEL_PX,
} = require('../.test-build/core/timeAxis.js');
const {
    computeSlotOffsets,
    indexAtSlot,
    resolveSessionBreaks,
    sizeSessionBreaks,
    slotAtIndex,
    totalSlots,
} = require('../.test-build/core/sessionScale.js');
const { niceStep } = require('../.test-build/core/panes.js');

const MINUTE = 60_000;
const SESSION_OPEN = Date.UTC(2025, 0, 6, 14, 30); // a Monday, mid-morning UTC
const SCALE_X = 6; // the default bar spacing, in CSS px per slot
/** Width of a rendered time label at 11px. Closer than this and two labels collide. */
const MIN_LABEL_WIDTH_PX = 60;

/** The slot table `Chart.rebuildSlots` would build, mirrors it option for option. */
function slotTable(times, { mode = 'proportional', maxWhitespaceRatio } = {}) {
    const resolved = resolveSessionBreaks(times, { mode, maxWhitespaceRatio });
    return computeSlotOffsets(times, sizeSessionBreaks(times, resolved));
}

/** `sessions` runs of one-minute bars, separated by an overnight gap. */
function sessions(count, sessionCount = 3, gapHours = 17) {
    const times = [];
    let cursor = SESSION_OPEN;
    for (let session = 0; session < sessionCount; session++) {
        for (let i = 0; i < count; i++) times.push(cursor + i * MINUTE);
        cursor += count * MINUTE + gapHours * 60 * MINUTE;
    }
    return times;
}

/** A window covering the whole series, with the pixel width that width implies. */
function wholeSeries(times, slots, scaleX = SCALE_X) {
    const total = totalSlots(slots);
    return { fromSlot: 0, toSlot: total, widthPx: total * scaleX };
}

/**
 * The loop this replaced, transcribed.
 *
 * `slot` stands in for `x`, which is what the old code compared: the two are the same
 * comparison, since x is affine in slot and the affine map is strictly increasing.
 */
function legacyTickIndices(slots, fromSlot, toSlot, scaleX) {
    const step = Math.max(1, Math.round(niceStep(96 / scaleX)));
    const out = [];
    let previous = Number.NEGATIVE_INFINITY;
    for (let time = Math.ceil(fromSlot / step) * step; ; time += step) {
        const slot = slotAtIndex(slots, indexAtSlot(slots, time));
        if (slot > toSlot || slot <= previous) break;
        previous = slot;
        out.push(indexAtSlot(slots, time));
    }
    return out;
}

test('the axis labels both sides of a session break, which is the regression', () => {
    // `proportional` is the mode that makes the old loop's exit fire: breaks come out
    // tens of slots wide, so a 20-slot tick step lands inside one, twice, and stops.
    const times = sessions(200);
    const slots = slotTable(times);
    const window = wholeSeries(times, slots);
    const ticks = timeAxisTicks({ times, slots, ...window });

    const breakStart = times.findIndex((time) => time > times[0] + 300 * MINUTE);
    const firstBreakBefore = ticks.filter((tick) => tick.index < breakStart).length;
    const firstBreakAfter = ticks.filter((tick) => tick.index > breakStart).length;
    assert.ok(firstBreakBefore > 0, 'no labels before the first break');
    assert.ok(firstBreakAfter > 0, 'no labels after the first break');
    assert.ok(
        ticks.some((tick) => tick.index >= times.length - 200),
        'the last session is unlabelled',
    );

    // And the old loop, on the same inputs, stops at the break.
    const legacy = legacyTickIndices(slots, window.fromSlot, window.toSlot, SCALE_X);
    assert.ok(
        legacy.length < ticks.length / 2,
        `the legacy loop should truncate here, got ${legacy.length} of ${ticks.length}`,
    );
    assert.ok(
        Math.max(...legacy) < times.length - 200,
        'the legacy loop was supposed to stop before the last session',
    );
});

test('no two labels ever land on the same bar', () => {
    // The mechanism of the truncation, stated as an invariant rather than as a symptom:
    // duplicate x is what ended the old loop, and it can only come from two ticks
    // naming one bar.
    for (const mode of ['collapsed', 'proportional']) {
        const times = sessions(150, 4);
        const slots = slotTable(times, { mode });
        const window = wholeSeries(times, slots);
        const ticks = timeAxisTicks({ times, slots, ...window });
        for (let i = 1; i < ticks.length; i++) {
            assert.ok(
                ticks[i].index > ticks[i - 1].index,
                `${mode}: label ${i} is bar ${ticks[i].index}, not past ${ticks[i - 1].index}`,
            );
        }
    }
});

test('a wide collapsed break truncates too, and no longer does', () => {
    // `collapsedSlots` is public and any positive number is accepted, so a break can be
    // wider than the tick step in the default mode as well. The default 0.5 happens to
    // be narrower than the minimum step of 1, which is why this needed the option set
    // to two to reach it — and why the bug survived a look at the defaults.
    const times = sessions(120);
    const resolved = resolveSessionBreaks(times, { mode: 'collapsed', collapsedSlots: 2 });
    const slots = computeSlotOffsets(times, sizeSessionBreaks(times, resolved));
    const window = wholeSeries(times, slots);
    const ticks = timeAxisTicks({ times, slots, ...window });
    assert.ok(ticks.length > 3, `expected labels throughout, got ${ticks.length}`);
    assert.ok(legacyTickIndices(slots, window.fromSlot, window.toSlot, SCALE_X).length < ticks.length);
});

test('a plot reaching left of the series still labels the bars in it', () => {
    // The same exit, reached without a break at all. A series narrower than its plot
    // puts the first visible slot left of bar 0, every tick there resolves to bar 0, and
    // the old loop stopped after one — so a short series got a single vertical line and
    // a single time label however much of it was on screen.
    const times = sessions(200, 2);
    const slots = slotTable(times, { mode: 'collapsed' });
    const fromSlot = -500;
    const toSlot = 200;
    const window = { fromSlot, toSlot, widthPx: (toSlot - fromSlot) * SCALE_X };

    const ticks = timeAxisTicks({ times, slots, ...window });
    assert.ok(ticks.length > 3, `expected several labels, got ${ticks.length}`);
    assert.ok(ticks.every((tick) => tick.index >= 0 && tick.index < times.length));

    assert.equal(legacyTickIndices(slots, fromSlot, toSlot, SCALE_X).length, 1);
});

test('labels are never denser than the pixel budget allows', () => {
    const times = sessions(200);
    const slots = slotTable(times);
    for (const widthPx of [200, 640, 1100, 3840]) {
        const ticks = timeAxisTicks({ times, slots, ...wholeSeries(times, slots), widthPx });
        const budget = Math.max(1, Math.floor(widthPx / DEFAULT_MIN_LABEL_PX)) + 1;
        assert.ok(
            ticks.length <= budget,
            `${widthPx}px allowed ${budget} labels, got ${ticks.length}`,
        );
    }
});

test('labels are spaced evenly, and gaps never make the axis denser', () => {
    // The property that makes a break cheap to draw: a weekend costs about half a bar of
    // width, so it must not also change how the labels are spaced. Held at a fixed plot
    // width, the series *with* gaps shows fewer bars than the one without, so it may
    // have fewer labels — but never more, and never unevenly spaced.
    const times = sessions(200);
    const slots = slotTable(times);
    const PLOT = 3600;

    const withGaps = timeAxisTicks({ times, slots, fromSlot: 0, toSlot: PLOT / SCALE_X, widthPx: PLOT });
    const without = timeAxisTicks({ times, slots: null, fromSlot: 0, toSlot: PLOT / SCALE_X, widthPx: PLOT });

    const gaps = (ticks) => ticks.slice(1).map((tick, i) => tick.index - ticks[i].index);
    for (const [name, ticks] of [['with gaps', withGaps], ['without', without]]) {
        const steps = gaps(ticks);
        assert.ok(steps.length > 0, `${name}: no labels`);
        assert.ok(
            Math.max(...steps) - Math.min(...steps) <= 1,
            `${name}: uneven spacing ${steps.join(',')}`,
        );
    }
    assert.ok(
        withGaps.length <= without.length,
        `gaps added labels: ${withGaps.length} against ${without.length}`,
    );
});

test('labels are never packed close enough to overlap', () => {
    // The requirement is not "hit the 96px target" — a coarse ladder cannot hit an exact
    // target, and asking it to is what produced labels a third of a bar apart. The
    // requirement is that no two labels are closer than their own text is wide, which is
    // what a trader actually sees.
    const times = sessions(200);
    const slots = slotTable(times);
    const total = totalSlots(slots);
    for (const widthPx of [200, 400, 640, 900, 1100, 1800, 3600, 7200, 14400]) {
        const ticks = timeAxisTicks({ times, slots, fromSlot: 0, toSlot: total, widthPx });
        const spacing = ticks.length > 1 ? widthPx / (ticks.length - 1) : widthPx;
        assert.ok(
            spacing >= MIN_LABEL_WIDTH_PX,
            `${widthPx}px gave ${ticks.length} labels, ${spacing.toFixed(0)}px apart`,
        );
    }
});

test('a daily series can still space its labels months apart', () => {
    // A chart of daily bars has no rung between one day and one week to choose from unless
    // the ladder carries one, and the result is 129 labels in a plot with room for ten.
    const DAY = 24 * 60 * MINUTE;
    const times = [];
    for (let i = 0; i < 900; i++) times.push(SESSION_OPEN + i * DAY);
    const ticks = timeAxisTicks({
        times,
        slots: null,
        fromSlot: 0,
        toSlot: times.length,
        widthPx: 1920,
    });
    const spacing = 1920 / (ticks.length - 1);
    assert.ok(ticks.length <= 24, `expected at most a label a fortnight, got ${ticks.length}`);
    assert.ok(spacing >= MIN_LABEL_WIDTH_PX, `${spacing.toFixed(0)}px apart is too close`);
    const step = ticks[1].index - ticks[0].index;
    assert.equal(
        ticks.slice(1).every((tick, i) => tick.index - ticks[i].index === step),
        true,
        'daily labels must be evenly spaced in bars',
    );
});

test('every label is on a wall-clock boundary, not just the first', () => {
    // The bug this replaced aligned the *phase* and left the *step* to the pixel budget,
    // which put labels at 14:30, 14:44, 14:58 — a round first label and nothing round
    // after it. One rung now decides both, so every label is on the ladder.
    const times = sessions(200);
    const slots = slotTable(times);
    for (const widthPx of [400, 900, 1800, 3600, 7200]) {
        const ticks = timeAxisTicks({
            times,
            slots,
            fromSlot: 0,
            toSlot: totalSlots(slots),
            widthPx,
        });
        assert.ok(ticks.length > 1, `${widthPx}px: expected labels`);
        for (const tick of ticks) {
            assert.equal(
                (tick.time / MINUTE) % 5,
                0,
                `${widthPx}px: label at ${new Date(tick.time).toISOString()} is off the ladder`,
            );
        }
    }
});

test('alignment is best-effort, and never costs the axis its labels', () => {
    // Bars at 7 minutes past, so no ladder boundary ever lands on one. Alignment snaps
    // forward to the first *real* bar after the boundary and the phase is kept, because
    // losing it would only move the labels without making them rounder. What matters is
    // the guarantee either way: a full complement of labels, none of them outside the
    // window, and none of them invented.
    const times = [];
    for (let i = 0; i < 300; i++) times.push(SESSION_OPEN + 7 * MINUTE + i * 7 * MINUTE);
    const slots = slotTable(times, { mode: 'collapsed' });
    const ticks = timeAxisTicks({ times, slots, ...wholeSeries(times, slots) });
    const budget = Math.max(1, Math.floor(wholeSeries(times, slots).widthPx / DEFAULT_MIN_LABEL_PX));
    assert.ok(ticks.length >= 2, `expected several labels, got ${ticks.length}`);
    assert.ok(
        Math.abs(ticks.length - budget) <= budget,
        `alignment starved the axis: ${ticks.length} labels against a budget of ${budget}`,
    );
    assert.ok(
        ticks.every((tick) => tick.index >= 0 && tick.index < times.length),
        'alignment produced a bar outside the series',
    );
    assert.ok(
        ticks.every((tick) => times.includes(tick.time)),
        'a label named a time no bar has',
    );
});

test('a series with no breaks is unchanged by any of this', () => {
    // `slots: null` is the identity, so the pre-feature transform is the answer and a
    // chart with `sessionBreaks.enabled: false` looks exactly as it did.
    const times = sessions(200, 1);
    const ticks = timeAxisTicks({
        times,
        slots: null,
        fromSlot: 0,
        toSlot: times.length,
        widthPx: 1200,
    });
    assert.ok(ticks.length > 0);
    assert.equal(ticks[0].index, 0);
    assert.deepEqual(
        ticks.map((tick) => tick.time),
        ticks.map((tick) => times[tick.index]),
        'a tick must carry its own bar timestamp',
    );
});

test('degenerate windows answer without throwing or inventing bars', () => {
    const times = sessions(50, 2);
    const slots = slotTable(times, { mode: 'collapsed' });
    const base = { times, slots, widthPx: 800 };

    assert.deepEqual(timeAxisTicks({ ...base, times: [], fromSlot: 0, toSlot: 10 }), []);
    // A zero-width window is not "no data": it is one bar, and the bar at that slot is a
    // real bar. It gets one label, which is the whole of what is on screen.
    const sliver = timeAxisTicks({ ...base, fromSlot: 0, toSlot: 0 });
    assert.ok(sliver.length <= 1, `expected at most one label, got ${sliver.length}`);
    // A window entirely past the end of the series clamps to the last bar rather than
    // reporting bars that are not there, so it yields that one bar and no more.
    const past = timeAxisTicks({ ...base, fromSlot: 1e6, toSlot: 2e6 });
    assert.ok(past.length <= 1, `expected at most one label past the end, got ${past.length}`);
    // A zero-width plot still gets a label, rather than an empty gutter.
    const narrow = timeAxisTicks({ ...base, fromSlot: 0, toSlot: 20, widthPx: 0 });
    assert.ok(narrow.length >= 1);
    assert.ok(narrow.every((tick) => tick.index >= 0 && tick.index < times.length));
});

test('the rung is chosen by the label count it produces, not by snapping a target', () => {
    // A ladder is coarse — 15 minutes to 30 is a factor of two — so snapping a target up
    // or down lands badly somewhere. Each rung is scored by the count it yields instead.
    const DAY = 24 * 60 * MINUTE;
    assert.deepEqual(chooseTickStep(600, MINUTE, 46), { bars: 15, ms: 15 * MINUTE });
    assert.deepEqual(chooseTickStep(600, MINUTE, 8), { bars: 60, ms: 60 * MINUTE });
    // Fewer bars than the budget asks for: label every one of them.
    assert.deepEqual(chooseTickStep(3, MINUTE, 40), { bars: 1, ms: 0 });
    // Daily bars reach the nominal long rungs, so a year of them is labelled monthly
    // rather than weekly.
    assert.deepEqual(chooseTickStep(900, DAY, 25), { bars: 30, ms: 30 * DAY });
    // A budget exactly between two rungs resolves to the sparser one, because too many
    // labels overlap and too few merely leave a gap.
    assert.deepEqual(chooseTickStep(900, DAY, 20), { bars: 91, ms: 91 * DAY });
    // A rung finer than the bar interval is one label per bar, and then the boundary
    // phase is dropped: every label is its own bar, so there is nothing to align. This
    // asks for a label on every bar, which is what a plot of 500 hourly bars 500 labels
    // wide is asking for.
    assert.deepEqual(chooseTickStep(500, 60 * MINUTE, 500), { bars: 1, ms: 0 });
    // An hourly series spaced to fit 100 labels lands on six hours, not on a rung that
    // divides the interval — a label every 84 bars reads better than one every 2.
    assert.deepEqual(chooseTickStep(500, 60 * MINUTE, 100), { bars: 6, ms: 6 * 60 * MINUTE });
});
