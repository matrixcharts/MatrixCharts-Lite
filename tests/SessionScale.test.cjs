// Pure tests for src/core/sessionScale.ts. Wall-clock X is mostly arithmetic, and
// the arithmetic is where it goes wrong: a threshold derived from the wrong
// statistic, a cap that is per-break instead of cumulative, and an off-by-one in a
// binary search are all invisible on a chart that happens to be uniform.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    computeSlotOffsets,
    contiguousRuns,
    DEFAULT_COLLAPSED_SLOTS,
    findSessionBreaks,
    indexAtSlot,
    indexAtTime,
    modalInterval,
    resolveSessionBreaks,
    sizeSessionBreaks,
    slotAtIndex,
    totalSlots,
} = require('../.test-build/core/sessionScale.js');

const MINUTE = 60_000;
const sessionStart = Date.UTC(2025, 0, 6, 14, 30); // a Monday, mid-morning UTC

/** `count` one-minute bars, then an overnight gap, then `count` more. */
function twoSessions(count = 60, gapHours = 17) {
    const times = [];
    for (let i = 0; i < count; i++) times.push(sessionStart + i * MINUTE);
    const resume = times[times.length - 1] + gapHours * 60 * MINUTE;
    for (let i = 1; i <= count; i++) times.push(resume + i * MINUTE);
    return times;
}

test('the modal interval survives a weekend, which a mean would not', () => {
    // The case the whole feature exists for. The mean over these gaps is about ten
    // minutes, so a chart of 1-minute bars that used a mean would conclude its bars
    // are ten minutes wide and draw a 17-hour break as barely one of them.
    const times = twoSessions(60, 17);
    assert.equal(modalInterval(times), MINUTE);
    const mean = (times[times.length - 1] - times[0]) / (times.length - 1);
    assert.ok(mean > 5 * MINUTE, `the mean should be badly wrong here, got ${mean / MINUTE} minutes`);
    assert.ok(
        mean > 5 * modalInterval(times),
        'the mean is supposed to differ from the modal interval, or this proves nothing',
    );
});

test('the modal interval prefers the shorter of two middles', () => {
    // A chart of mostly 1-minute bars with some 2-minute bars is a 1-minute chart.
    const times = [0, 1, 2, 3, 4, 5, 7, 9].map((m) => m * MINUTE);
    assert.equal(modalInterval(times), MINUTE);
});

test('a series too short to have an interval reports none', () => {
    assert.equal(modalInterval([]), 0);
    assert.equal(modalInterval([MINUTE]), 0);
    assert.equal(modalInterval([0, 0, 0]), 0, 'a series of identical times has no interval');
});

test('a break is found where the gap exceeds the threshold, and only there', () => {
    const times = twoSessions(10, 17);
    const resolved = resolveSessionBreaks(times, undefined);
    assert.equal(resolved.thresholdMs, 3 * MINUTE, 'the default threshold should be three intervals');
    const breaks = findSessionBreaks(times, resolved.thresholdMs);
    assert.equal(breaks.length, 1);
    assert.equal(breaks[0].index, 10, 'the break belongs to the bar after the gap');
    assert.ok(breaks[0].gapMs > 16 * 60 * MINUTE);
});

test('a continuous series has no breaks at all', () => {
    // What a crypto feed looks like. Nothing here should change.
    const times = Array.from({ length: 200 }, (_, i) => sessionStart + i * MINUTE);
    const resolved = resolveSessionBreaks(times, undefined);
    assert.deepEqual(sizeSessionBreaks(times, resolved), []);
});

test('a collapsed break is a fraction of a bar however long the gap is', () => {
    // 17 hours, one weekend and a month all collapse to the same half a bar. Drawn
    // to scale they would each be a different flavour of unusable, and the point is
    // that the reader sees a break without the chart ceasing to be a chart.
    for (const hours of [1.5, 17, 48, 24 * 30]) {
        const times = twoSessions(20, hours);
        const resolved = resolveSessionBreaks(times, { mode: 'collapsed' });
        const breaks = sizeSessionBreaks(times, resolved);
        assert.equal(breaks.length, 1, `${hours}h produced ${breaks.length} breaks`);
        assert.equal(breaks[0].slots, DEFAULT_COLLAPSED_SLOTS, `${hours}h was not collapsed`);
    }
});

test('a proportional break is sized by its duration', () => {
    // With the cap out of the way, so this measures the sizing rule rather than the
    // ceiling: a 2-hour gap is 119 bars' worth of time and a 10-hour gap is 599, and
    // the widths should say so. With the default cap a single oversized break lands
    // exactly on the budget whichever gap it is, which is the ceiling working and is
    // covered separately.
    const generous = { mode: 'proportional', maxWhitespaceRatio: 100 };
    const short = sizeSessionBreaks(twoSessions(20, 2), resolveSessionBreaks(twoSessions(20, 2), generous));
    const long = sizeSessionBreaks(twoSessions(20, 10), resolveSessionBreaks(twoSessions(20, 10), generous));
    assert.ok(long[0].slots > short[0].slots, 'a longer gap should be a wider break');
    assert.ok(long[0].slots / short[0].slots > 4, 'a five-times-longer gap should be visibly wider');
});

test('a proportional break is wider than a collapsed one', () => {
    // The two modes are not the same thing scaled: collapsed says "there was a gap",
    // proportional says roughly how big it was, up to the cap.
    const times = twoSessions(20, 17);
    const generous = { mode: 'proportional', maxWhitespaceRatio: 100 };
    const collapsed = sizeSessionBreaks(times, resolveSessionBreaks(times, { mode: 'collapsed' }));
    const proportional = sizeSessionBreaks(times, resolveSessionBreaks(times, generous));
    assert.ok(proportional[0].slots > collapsed[0].slots * 10,
        `proportional ${proportional[0].slots} vs collapsed ${collapsed[0].slots}`);
});

test('the whitespace cap is on the total, not per break', () => {
    // Thirty individually reasonable breaks are still a chart of nothing, and a
    // per-break cap would let them through.
    const times = [0];
    for (let session = 0; session < 30; session++) {
        for (let i = 1; i <= 20; i++) times.push(times[times.length - 1] + MINUTE);
        times.push(times[times.length - 1] + 17 * 60 * MINUTE);
    }
    const resolved = resolveSessionBreaks(times, { mode: 'proportional', maxWhitespaceRatio: 0.25 });
    const breaks = sizeSessionBreaks(times, resolved);
    assert.equal(breaks.length, 30);
    const total = breaks.reduce((sum, b) => sum + b.slots, 0);
    assert.ok(
        total <= 0.25 * times.length + 1e-6,
        `breaks took ${total} slots against a budget of ${0.25 * times.length}`,
    );
    // Capped, not truncated: no break was collapsed to nothing while its
    // neighbours stayed wide, which would read as data rather than as a cap.
    for (const entry of breaks) assert.ok(entry.slots > 0, 'a break was truncated away');
    // And they stay in proportion to each other.
    const ratio = breaks[0].slots / breaks[breaks.length - 1].slots;
    assert.ok(Math.abs(ratio - 1) < 1e-6, 'equal gaps produced unequal breaks after capping');
});

test('a rejected break policy is refused rather than repaired', () => {
    const times = twoSessions(10, 17);
    for (const options of [
        { thresholdMs: -1 },
        { thresholdMs: Number.NaN },
        { collapsedSlots: 0 },
        { collapsedSlots: Number.POSITIVE_INFINITY },
        { maxWhitespaceRatio: 0 },
        { mode: 'squish' },
    ]) {
        assert.throws(() => resolveSessionBreaks(times, options), /sessionBreaks/,
            `${JSON.stringify(options)} was not rejected`);
    }
});

test('slot offsets are one per bar plus the breaks, and cover the series', () => {
    const times = twoSessions(20, 17);
    const resolved = resolveSessionBreaks(times, undefined);
    const offsets = computeSlotOffsets(times, sizeSessionBreaks(times, resolved));
    assert.equal(offsets.length, times.length);
    // Bars 0..19 are the first session and sit exactly one slot apart, which is what
    // makes a continuous series identical to the index transform it replaces.
    for (let i = 1; i < 20; i++) {
        assert.equal(offsets[i] - offsets[i - 1], 1, `slot ${i} is not one bar after its neighbour`);
    }
    // Bar 20 is the first bar of the next session, pushed out by the break's width.
    assert.equal(offsets[20] - offsets[19] - 1, DEFAULT_COLLAPSED_SLOTS);
    // Everything after it is contiguous again.
    assert.equal(offsets[21] - offsets[20], 1, 'the bar after the break is not one slot wide');
    // Forty bars plus one break.
    assert.equal(totalSlots(offsets), 40 + DEFAULT_COLLAPSED_SLOTS);
    // Monotonic, always: a non-monotonic prefix sum breaks the binary search.
    for (let i = 1; i < offsets.length; i++) {
        assert.ok(offsets[i] > offsets[i - 1], `offsets went backwards at ${i}`);
    }
});

test('an empty series has no slots and no offsets', () => {
    const offsets = computeSlotOffsets([], []);
    assert.equal(offsets.length, 0);
    assert.equal(totalSlots(offsets), 0);
    assert.equal(indexAtSlot(offsets, 5), -1);
    assert.equal(slotAtIndex(offsets, 0), 0);
});

test('a slot resolves to the bar containing it, and clamps past either end', () => {
    // Five bars, with bar 2 widened by a one-slot break before bar 3.
    const offsets = Float64Array.from([0, 1, 2, 5, 6]);
    assert.equal(indexAtSlot(offsets, 0), 0);
    assert.equal(indexAtSlot(offsets, 1.9), 1);
    assert.equal(indexAtSlot(offsets, 2), 2);
    assert.equal(indexAtSlot(offsets, 4.9), 2, 'a slot inside a break belongs to the bar before it');
    assert.equal(indexAtSlot(offsets, 5), 3);
    assert.equal(indexAtSlot(offsets, -100), 0, 'a slot before the series clamps to the first bar');
    assert.equal(indexAtSlot(offsets, 999), 4, 'a slot after the series clamps to the last bar');
});

test('a bar is one slot wide, so a break does not widen the bar before it', () => {
    // Five bars, with a three-slot break before bar 3. The model is one slot per bar
    // plus extra slots *after* a break, so bar 2 occupies [2, 3) and the whitespace is
    // [3, 5). Its centre is 2.5.
    //
    // The midpoint between this bar's left edge and the next one's — 3.5 here — is the
    // alternative that reads as natural and is wrong: it puts the last candle of a
    // session half a gap into the whitespace, and it makes bar 2 two slots from bar 1
    // while every other bar in the series is one slot from its neighbour. It agreed with
    // this answer on any series with no breaks, which is why it shipped.
    const offsets = Float64Array.from([0, 1, 2, 5, 6]);
    assert.equal(slotAtIndex(offsets, 0), 0.5);
    assert.equal(slotAtIndex(offsets, 2), 2.5, 'the bar before a break is still one slot wide');
    assert.equal(slotAtIndex(offsets, 3), 5.5);
    // Out-of-range indices clamp rather than reading past the array.
    assert.equal(slotAtIndex(offsets, -5), 0.5);
    assert.equal(slotAtIndex(offsets, 99), 6.5);
    // And the centre never leaves the bar's own slot, which is the whole claim.
    for (let index = 0; index < offsets.length; index++) {
        const centre = slotAtIndex(offsets, index);
        assert.ok(centre >= offsets[index] && centre < offsets[index] + 1,
            `bar ${index} has its centre at ${centre}, outside its own slot`);
    }
});

test('slot lookup and index lookup agree on every bar of a uniform series', () => {
    // The regression that matters most: a chart with no breaks must come out
    // identical to the index transform it replaces, or every existing consumer
    // shifts by a fraction of a bar.
    const count = 500;
    const times = Array.from({ length: count }, (_, i) => sessionStart + i * MINUTE);
    const resolved = resolveSessionBreaks(times, undefined);
    const offsets = computeSlotOffsets(times, sizeSessionBreaks(times, resolved));
    for (let i = 0; i < count; i++) {
        assert.equal(offsets[i], i, `bar ${i} is not at slot ${i} on a uniform series`);
        assert.equal(indexAtSlot(offsets, offsets[i]), i, `slot lookup lost bar ${i}`);
    }
});

test('a timestamp inside a break belongs to the nearer side', () => {
    // The distinction that wall-clock X buys: the same time can resolve to two
    // different ordinals depending on where the break is, so this cannot be the
    // nearest-ordinal snap the index transform uses.
    const times = twoSessions(10, 17);
    const resolved = resolveSessionBreaks(times, undefined);
    const offsets = computeSlotOffsets(times, sizeSessionBreaks(times, resolved));
    const gapStart = times[9];
    const gapEnd = times[10];
    assert.equal(indexAtTime(times, gapStart), 9, 'the gap start belongs to the earlier bar');
    assert.equal(indexAtTime(times, gapEnd), 10, 'the gap end belongs to the later bar');
    assert.equal(
        indexAtTime(times, gapStart + (gapEnd - gapStart) / 2 - 1),
        9,
        'the first half of a break belongs to the earlier bar',
    );
    assert.equal(
        indexAtTime(times, gapStart + (gapEnd - gapStart) / 2 + 1),
        10,
        'the second half belongs to the later bar',
    );
    // And outside the series it clamps.
    assert.equal(indexAtTime(times, 0), 0);
    assert.equal(indexAtTime(times, Number.MAX_SAFE_INTEGER), times.length - 1);
    assert.equal(indexAtTime([], offsets, 0), -1);
});

// A zone laid down before a break and still valid after it must be drawn in both
// sessions and absent in the gap. One rectangle spanning the whole thing is a claim
// that the level was occupied continuously, including while the market was shut.
test('a decoration spanning a break is split at it', () => {
    // Five bars, one collapsed break before bar 3.
    const offsets = Float64Array.from([0, 1, 2, 3.5, 4.5, 5.5]);
    assert.deepEqual(contiguousRuns(offsets, 1, 4, 5), [[1, 2], [3, 4]]);
});

test('a decoration entirely inside one session is one run', () => {
    const offsets = Float64Array.from([0, 1, 2, 3.5, 4.5, 5.5]);
    assert.deepEqual(contiguousRuns(offsets, 0, 2, 5), [[0, 2]]);
    assert.deepEqual(contiguousRuns(offsets, 3, 4, 5), [[3, 4]]);
});

test('a decoration spanning several breaks is split at each', () => {
    // Breaks before bars 2 and 6. Every step is at least one slot: a smaller step
    // would mean two bars overlapping, which the model cannot produce, and the split
    // rule keys on a step *greater* than one precisely so ordinary bars are never
    // treated as a break.
    const offsets = Float64Array.from([0, 1, 2.5, 3.5, 4.5, 5.5, 7, 8]);
    assert.deepEqual(contiguousRuns(offsets, 0, 7, 8), [[0, 1], [2, 5], [6, 7]]);
});

test('an unbroken series is a single run, whatever the range', () => {
    assert.deepEqual(contiguousRuns(null, 3, 9, 20), [[3, 9]]);
    // The identity has to be the identity here too, or every zone on an unbroken
    // chart would gain a border seam it never had.
    assert.deepEqual(contiguousRuns(null, 0, 0, 1), [[0, 0]]);
});

test('a collapsed break still splits, because it is wider than a bar', () => {
    // The step across a half-slot break is 1.5. Treating that as contiguous is what
    // would leave a decoration painted over the gap it is meant to respect, and it
    // is the exact case the default mode produces.
    const offsets = Float64Array.from([0, 1, 2, 3.5]);
    assert.equal(contiguousRuns(offsets, 0, 3, 4).length, 2);
});

test('runs are clamped to the series and never inverted', () => {
    const offsets = Float64Array.from([0, 1, 2, 3.5, 4.5]);
    // Clamped to bars 0..4, and still split at the break inside that clamped range:
    // clamping the ends is not the same as forgetting what is between them.
    assert.deepEqual(contiguousRuns(offsets, -5, 99, 5), [[0, 2], [3, 4]]);
    assert.deepEqual(contiguousRuns(offsets, 4, 1, 5), []);
    assert.deepEqual(contiguousRuns(offsets, 0, 3, 0), []);
});

test('every bar in the requested range appears in exactly one run', () => {
    const offsets = Float64Array.from([0, 1, 2.5, 3.5, 4.5, 5.5, 7, 8]);
    const seen = new Set();
    for (const [start, end] of contiguousRuns(offsets, 0, 7, 8)) {
        for (let i = start; i <= end; i++) {
            assert.ok(!seen.has(i), `bar ${i} is in two runs`);
            seen.add(i);
        }
    }
    assert.equal(seen.size, 8, 'a bar was dropped between two runs');
});
