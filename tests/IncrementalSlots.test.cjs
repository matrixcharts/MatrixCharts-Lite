// Tests for src/core/incrementalSlots.ts
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    appendSlotOffsetsCollapsed,
    appendSlotOffsetsProportional,
    appendSlotOffsetsProportionalWithScale,
    trimSlotOffsetsIncremental,
    totalSlotsFast,
    slotOffsetAt,
    incrementalSlotUpdate,
    incrementalSlotUpdateWithScale,
} = require('../.test-build/core/incrementalSlots.js');

// --- collapsed mode ----------------------------------------------------------

test('appendSlotOffsetsCollapsed extends a table with no breaks', () => {
    const times = [0, 60_000, 120_000, 180_000];
    const result = appendSlotOffsetsCollapsed(null, Number.NEGATIVE_INFINITY, times, 180_000, 0.5);
    assert.equal(result.length, 4);
    assert.equal(result[0], 0);
    assert.equal(result[1], 1);
    assert.equal(result[2], 2);
    assert.equal(result[3], 3);
});

test('appendSlotOffsetsCollapsed adds break slots for gaps', () => {
    const times = [0, 60_000, 120_000, 360_000]; // gap of 240_000 between index 2 and 3
    const result = appendSlotOffsetsCollapsed(null, Number.NEGATIVE_INFINITY, times, 180_000, 0.5);
    assert.equal(result[0], 0);
    assert.equal(result[1], 1);
    assert.equal(result[2], 2);
    // Bar 3 is after a break (gap of 240_000 > 180_000), so it gets 0.5 extra slots
    assert.equal(result[3], 3.5);
});

test('appendSlotOffsetsCollapsed extends an existing table', () => {
    const previous = new Float64Array([0, 1, 2]);
    const appended = [360_000, 420_000];
    const result = appendSlotOffsetsCollapsed(previous, 120_000, appended, 180_000, 0.5);
    assert.equal(result.length, 5);
    assert.equal(result[0], 0);
    assert.equal(result[1], 1);
    assert.equal(result[2], 2);
    // Bar 3 is after a break (gap of 240_000 > 180_000)
    assert.equal(result[3], 3.5);
    assert.equal(result[4], 4.5);
});

// --- proportional mode -------------------------------------------------------

test('appendSlotOffsetsProportional sizes breaks by duration', () => {
    const times = [0, 60_000, 120_000, 300_000]; // gap of 180_000 = 3 intervals
    const result = appendSlotOffsetsProportional(
        null, Number.NEGATIVE_INFINITY, times, times, 180_000, 0.25, 60_000,
    );
    assert.equal(result.length, 4);
    assert.equal(result[0], 0);
    assert.equal(result[1], 1);
    assert.equal(result[2], 2);
    // Break slots = gap/interval - 1 = 3 - 1 = 2, but budget = 0.25 * 4 = 1
    // So it gets scaled down
    assert.ok(result[3] > 2, 'break should add slots');
    assert.ok(result[3] < 4, 'break should be capped');
});

// --- trimming ----------------------------------------------------------------

test('trimSlotOffsetsIncremental drops a prefix and rebases', () => {
    const offsets = new Float64Array([0, 1, 2, 3.5, 4.5]);
    const result = trimSlotOffsetsIncremental(offsets, 2);
    assert.equal(result.length, 3);
    assert.equal(result[0], 0);
    assert.equal(result[1], 1.5);
    assert.equal(result[2], 2.5);
});

test('trimSlotOffsetsIncremental with zero trim returns same table', () => {
    const offsets = new Float64Array([0, 1, 2]);
    const result = trimSlotOffsetsIncremental(offsets, 0);
    assert.equal(result, offsets);
});

test('trimSlotOffsetsIncremental rejects out-of-bounds trim', () => {
    const offsets = new Float64Array([0, 1, 2]);
    assert.throws(() => trimSlotOffsetsIncremental(offsets, -1), /within the offset table/);
    assert.throws(() => trimSlotOffsetsIncremental(offsets, 4), /within the offset table/);
    assert.throws(() => trimSlotOffsetsIncremental(offsets, 1.5), /within the offset table/);
});

// --- totalSlotsFast ----------------------------------------------------------

test('totalSlotsFast returns 0 for null', () => {
    assert.equal(totalSlotsFast(null), 0);
});

test('totalSlotsFast returns 0 for empty', () => {
    assert.equal(totalSlotsFast(new Float64Array(0)), 0);
});

test('totalSlotsFast returns last + 1', () => {
    assert.equal(totalSlotsFast(new Float64Array([0, 1, 2])), 3);
    assert.equal(totalSlotsFast(new Float64Array([0, 1.5, 3])), 4);
});

// --- slotOffsetAt ------------------------------------------------------------

test('slotOffsetAt returns index for null table', () => {
    assert.equal(slotOffsetAt(null, 0), 0);
    assert.equal(slotOffsetAt(null, 5), 5);
});

test('slotOffsetAt clamps to table bounds', () => {
    const offsets = new Float64Array([0, 1, 2]);
    assert.equal(slotOffsetAt(offsets, -1), -1);
    assert.equal(slotOffsetAt(offsets, 0), 0);
    assert.equal(slotOffsetAt(offsets, 1), 1);
    assert.equal(slotOffsetAt(offsets, 2), 2);
    assert.equal(slotOffsetAt(offsets, 3), 3);
    assert.equal(slotOffsetAt(offsets, 5), 5);
});

// --- incrementalSlotUpdate ----------------------------------------------------

test('incrementalSlotUpdate with collapsed mode', () => {
    const previous = new Float64Array([0, 1, 2]);
    const appended = [360_000, 420_000];
    const result = incrementalSlotUpdate(
        previous, 120_000, appended,
        'collapsed', 180_000, 0.5, 0.25, 60_000, 0,
    );
    assert.equal(result.length, 5);
    assert.equal(result[0], 0);
    assert.equal(result[3], 3.5);
});

test('incrementalSlotUpdate with trim', () => {
    const previous = new Float64Array([0, 1, 2]);
    const appended = [300_000, 360_000];
    const result = incrementalSlotUpdate(
        previous, 120_000, appended,
        'collapsed', 180_000, 0.5, 0.25, 60_000, 1,
    );
    assert.equal(result.length, 4);
    assert.equal(result[0], 0);
});

// --- proportional: length derived from the table, not a times array ------------

// A retention trim renumbers every break in a retained series. The production
// caller supplies a *post-trim* times array alongside a *pre-trim* table, so when
// the append took its length from that array it wrote pre-trim break indices into
// a table sized post-trim, and every session break in the series shifted left by
// the trim count on each append. These pin that the length comes from the table.

test('a proportional append sizes from the table, not from a times array', () => {
    const previous = new Float64Array([0, 1, 2, 3.5, 4.5]);
    // Deliberately the *post-trim* length, three entries short of the table plus the
    // append. The result must still describe six bars.
    const postTrimTimes = [0, 1, 2];
    const result = appendSlotOffsetsProportional(
        previous, 120_000, [300_000], postTrimTimes, 150_000, 0.25, 60_000,
    );
    assert.equal(result.length, 6, 'length follows previous + appended');
});

test('a trimmed proportional append leaves earlier breaks where they were', () => {
    // Four bars, with a break in front of bar 3. After a one-bar trim it must remain
    // a break, not vanish and not slide to the wrong bar.
    const previous = new Float64Array([0, 1, 2, 4]);
    const result = incrementalSlotUpdate(
        previous, 120_000, [180_000],
        'proportional', 150_000, 0.5, 0.25, 60_000, 1,
    );
    assert.equal(result.length, 4, 'four bars in, one appended, one trimmed, four out');
    // Rebased: the survivor that used to sit at offset 1 now sits at 0.
    assert.equal(result[0], 0);
    // A bar is one slot, plus the 1-slot break that used to sit in front of bar 3.
    assert.equal(result[2] - result[1], 2, 'the break survived the trim');
});

test('a proportional append reports the scale it applied', () => {
    const update = appendSlotOffsetsProportionalWithScale(
        null, Number.NEGATIVE_INFINITY, [0, 60_000, 120_000, 300_000],
        150_000, 0.25, 60_000,
    );
    // One bar plus a 2-slot break, budget 0.25 * 4 = 1 against 2 raw slots, so the
    // scale is 0.5 and the break is worth 1 slot: a 2-slot step.
    assert.ok(Math.abs(update.scale - 0.5) < 1e-12, `scale was ${update.scale}`);
    assert.ok(Math.abs((update.offsets[3] - update.offsets[2]) - 2) < 1e-9);
});

test('an under-budget proportional append reports a scale of 1', () => {
    const update = appendSlotOffsetsProportionalWithScale(
        null, Number.NEGATIVE_INFINITY, [0, 60_000, 120_000, 180_000, 240_000],
        150_000, 0.25, 60_000,
    );
    assert.equal(update.scale, 1);
});

test('repeated proportional appends recover break widths without compounding', () => {
    // The invariant a live feed depends on: a break in the table is `1 + raw *
    // scale` slots wide, so dividing the step back out by the scale the table was
    // built under must return the raw width it started as. If the append assumes a
    // scale of 1 instead of carrying the real one, it reads an already-capped width
    // as raw, caps it again, and the widths decay every append until the chart shows
    // no breaks at all.
    //
    // Two breaks of *different* raw widths, so the corruption is visible in their
    // ratio rather than hiding behind a shared total. A tight whitespace budget
    // keeps the cap binding for the whole run, so the recovery is exercised on every
    // append instead of only the first few.
    const interval = 60_000;
    const thresholdMs = 150_000;
    const ratio = 0.05;
    const seed = [0, 60_000, 300_000, 360_000, 900_000];
    // Raw widths, keyed by the bar each break sits in front of: bar 2 opens after a
    // 240s gap (3 slots) and bar 4 after a 540s gap (8 slots). Appending never shifts
    // an earlier index, so these keys are stable for the whole run.
    const expectedRaw = new Map([[2, 3], [4, 8]]);

    let update = incrementalSlotUpdateWithScale(
        null, Number.NEGATIVE_INFINITY, seed,
        'proportional', thresholdMs, 0.5, ratio, interval, 0, 1,
    );
    assert.ok(update.scale < 1, 'the cap binds on the seed, so recovery is exercised');
    let previousLastTime = seed[seed.length - 1];

    for (let round = 1; round <= 20; round++) {
        const next = incrementalSlotUpdateWithScale(
            update.offsets, previousLastTime, [previousLastTime + interval],
            'proportional', thresholdMs, 0.5, ratio, interval, 0, update.scale,
        );
        for (const [index, raw] of expectedRaw) {
            const step = next.offsets[index] - next.offsets[index - 1];
            const recovered = (step - 1) / next.scale;
            assert.ok(
                Math.abs(recovered - raw) < 1e-6,
                `append ${round}: break in front of bar ${index} recovered as `
                + `${recovered}, expected ${raw}`,
            );
        }
        update = next;
        previousLastTime += interval;
    }
});

test('a collapsed append reports a scale of 1 whatever the table was under', () => {
    // Collapsed breaks are a fixed width and are never scaled, so a table that
    // switches mode cannot carry a stale proportional factor into the next append.
    const update = incrementalSlotUpdateWithScale(
        new Float64Array([0, 1, 2]), 120_000, [180_000],
        'collapsed', 150_000, 0.5, 0.25, 60_000, 0, 0.3,
    );
    assert.equal(update.scale, 1);
    assert.equal(update.offsets.length, 4);
});
