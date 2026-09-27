// Pure tests for src/core/overlays.ts. No DOM, no canvas: the alignment and
// rejection rules are what stop a line being drawn in the wrong place, and they
// are worth pinning down without a browser.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { bucketOverlay, resolveOverlays } = require('../.test-build/core/overlays.js');
const {
    bucketCentreSlot,
    computeSlotOffsets,
    resolveSessionBreaks,
    sizeSessionBreaks,
    slotAtIndex,
} = require('../.test-build/core/sessionScale.js');

const BASE = Date.UTC(2025, 0, 1);
const times = Array.from({ length: 16 }, (_, i) => BASE + i * 60_000);
const color = () => [1, 0, 0, 1];
const points = (values, from = 0) => values.map((value, i) => ({ time: times[from + i], value }));

/** bucketOverlay, unwrapped to just the point array, for stride-2 call sites. */
function bucketPoints(...args) {
    const result = bucketOverlay(...args);
    assert.equal(result.stride, 2, 'expected a uniform-colour overlay');
    return result.points;
}

const throws = (fn, pattern) => {
    assert.throws(fn, pattern);
};

test('values are aligned to candle ordinals, not to their own index', () => {
    // Supplied from candle 4 onward: ordinals 0..3 must be untouched, and the
    // first supplied value must land on ordinal 4.
    const resolved = resolveOverlays([{ id: 'ema', points: points([1, 2, 3], 4) }], times, color);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].values.length, times.length);
    assert.deepEqual(Array.from(resolved[0].values), [0, 0, 0, 0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('a timestamp between candles is rejected rather than snapped', () => {
    // The whole point: a line drawn half a bar out of place is worse than one
    // that refuses to draw.
    throws(
        () => resolveOverlays([{ id: 'ema', points: [{ time: BASE + 30_000, value: 1 }] }], times, color),
        /no candle at/,
    );
});

test('non-monotonic, non-finite, and duplicate timestamps are rejected', () => {
    throws(
        () => resolveOverlays([{ id: 'x', points: [{ time: times[2], value: 1 }, { time: times[1], value: 2 }] }], times, color),
        /strictly increase/,
    );
    throws(
        () => resolveOverlays([{ id: 'x', points: [{ time: times[1], value: 1 }, { time: times[1], value: 2 }] }], times, color),
        /strictly increase/,
    );
    throws(
        () => resolveOverlays([{ id: 'x', points: [{ time: times[1], value: Number.NaN }] }], times, color),
        /finite time and value/,
    );
    throws(
        () => resolveOverlays([{ id: 'x', points: [{ time: Number.POSITIVE_INFINITY, value: 1 }] }], times, color),
        /finite time and value/,
    );
});

test('ids must be present and unique', () => {
    throws(() => resolveOverlays([{ id: '', points: points([1]) }], times, color), /non-empty string id/);
    throws(() => resolveOverlays([{ id: '   ', points: points([1]) }], times, color), /non-empty string id/);
    throws(
        () => resolveOverlays([
            { id: 'a', points: points([1]) },
            { id: 'a', points: points([2], 1) },
        ], times, color),
        /used more than once/,
    );
});

test('an empty overlay is kept but not visible', () => {
    // An indicator that has not produced a value yet is a normal state, not a
    // malformed series, so it must not throw.
    const resolved = resolveOverlays([{ id: 'ema', points: [] }], times, color);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].visible, false);
});

test('visible:false is honoured and a colour resolver is applied', () => {
    const resolved = resolveOverlays(
        [{ id: 'a', points: points([1, 2]), visible: false }],
        times,
        () => [0, 0, 1, 0.5],
    );
    assert.equal(resolved[0].visible, false);
    assert.deepEqual(resolved[0].color, [0, 0, 1, 0.5]);
});

test('a rejected overlay leaves nothing half-applied', () => {
    // The whole set is resolved before any of it is accepted, so a bad entry
    // cannot leave a good one behind.
    throws(
        () => resolveOverlays([
            { id: 'good', points: points([1, 2]) },
            { id: 'bad', points: [{ time: BASE + 30_000, value: 1 }] },
        ], times, color),
        /no candle at/,
    );
});

test('an indicator that starts late begins late, not from zero', () => {
    // A 21-period EMA emits nothing until it has enough history, so it covers a
    // suffix of the series. Drawing the uncovered leading bars as zero would draw
    // a line from price zero up to the first real value.
    const resolved = resolveOverlays([{ id: 'ema', points: points([50, 51, 52], 5) }], times, color);
    assert.equal(resolved[0].firstIndex, 5);
    assert.equal(resolved[0].lastIndex, 7);

    const full = bucketPoints(resolved[0].values, 1, times.length, resolved[0].firstIndex, resolved[0].lastIndex);
    assert.equal(full.length / 2, 3);
    assert.deepEqual(Array.from({ length: 3 }, (_, i) => full[i * 2]), [5, 6, 7]);
    assert.deepEqual(Array.from({ length: 3 }, (_, i) => full[i * 2 + 1]), [50, 51, 52]);

    // A trailing gap is dropped the same way.
    const trailing = bucketPoints(resolved[0].values, 1, times.length, 5, 6);
    assert.equal(trailing.length / 2, 2);
});

test('bucketing skips leading buckets until the indicator has a value', () => {
    const values = Float32Array.from({ length: 16 }, (_, i) => i);
    // Covered from ordinal 5 only. At factor 2 the first emitted bucket is the one
    // whose last ordinal is 5, which is bucket 2 covering 4 and 5. The x is the
    // bucket's index, which is what the candles' own slice is keyed by.
    const bucketed = bucketPoints(values, 2, 16, 5, 15);
    const xs = [];
    for (let i = 0; i < bucketed.length / 2; i++) xs.push(bucketed[i * 2]);
    assert.deepEqual(xs, [2, 3, 4, 5, 6, 7]);
});

test('an overlay that covers nothing buckets to nothing', () => {
    const resolved = resolveOverlays([{ id: 'x', points: [] }], times, color);
    assert.equal(resolved[0].firstIndex, -1);
    assert.equal(bucketPoints(resolved[0].values, 1, times.length, -1, -1).length, 0);
});

test('bucketing emits the bucket index, and the candles convert it the same way', () => {
    // Bucketing is index arithmetic and stops there. What the renderer is handed is a
    // bucket number, and the position comes from `bucketCentreSlot` — one conversion
    // shared with the candles, so the two cannot land on different pixels. These
    // expectations are the bucket numbers, not positions: with a null slot table the
    // conversion is the identity and the two agree, which is the case that has to hold
    // before the interesting one does.
    const values = Float32Array.from({ length: 16 }, (_, i) => i);
    const full = bucketPoints(values, 1, 16);
    assert.equal(full.length, 32);
    for (let i = 0; i < 16; i++) {
        assert.equal(full[i * 2], i, `x at factor 1, index ${i}`);
        assert.equal(full[i * 2 + 1], i);
    }

    const half = bucketPoints(values, 2, 16);
    assert.equal(half.length / 2, 8);
    assert.deepEqual(Array.from({ length: 8 }, (_, b) => half[b * 2]), [0, 1, 2, 3, 4, 5, 6, 7]);
    // A bucket takes the last value in its group.
    assert.deepEqual(Array.from({ length: 8 }, (_, b) => half[b * 2 + 1]), [1, 3, 5, 7, 9, 11, 13, 15]);

    const quarter = bucketPoints(values, 4, 16);
    assert.deepEqual(Array.from({ length: 4 }, (_, b) => quarter[b * 2]), [0, 1, 2, 3]);
    assert.deepEqual(Array.from({ length: 4 }, (_, b) => quarter[b * 2 + 1]), [3, 7, 11, 15]);
});

test('bucketing handles a group size that does not divide the series', () => {
    // 10 candles at factor 4 gives groups of 4, 4 and 2; the last bucket must still be
    // keyed to itself rather than to a padded one.
    const values = Float32Array.from({ length: 10 }, (_, i) => i);
    const bucketed = bucketPoints(values, 4, 10);
    assert.equal(bucketed.length / 2, 3);
    assert.deepEqual(Array.from({ length: 3 }, (_, b) => bucketed[b * 2]), [0, 1, 2]);
    assert.deepEqual(Array.from({ length: 3 }, (_, b) => bucketed[b * 2 + 1]), [3, 7, 9]);
});

test('an empty series buckets to nothing rather than throwing', () => {
    assert.equal(bucketPoints(new Float32Array(0), 1, 0).length, 0);
    assert.equal(bucketPoints(new Float32Array(0), 8, 0).length, 0);
});

test('an overlay in one colour carries no per-point colour array', () => {
    // Paying four floats per ordinal for a uniform colour would be waste.
    const resolved = resolveOverlays([{ id: 'a', points: points([1, 2]) }], times, color);
    assert.equal(resolved[0].pointColors, null);
});

test('a point colour is parsed and carried per ordinal', () => {
    // ReplayStudio's IndicatorPoint declares an optional per-point colour and its
    // MACD and volume indicators use it, so the field is honoured rather than
    // declared-and-ignored.
    const seen = [];
    const resolved = resolveOverlays(
        [{ id: 'macd', points: [
            { time: times[0], value: 1, color: '#10b981' },
            { time: times[1], value: 2, color: '#ef4444' },
        ] }],
        times,
        color,
        (spec, cssColor) => {
            seen.push([spec.id, cssColor]);
            return cssColor === '#10b981' ? [0, 1, 0, 1] : [1, 0, 0, 1];
        },
    );
    assert.deepEqual(seen, [['macd', '#10b981'], ['macd', '#ef4444']]);
    const colors = resolved[0].pointColors;
    assert.notEqual(colors, null);
    assert.equal(colors.length, times.length * 4);
    assert.deepEqual(Array.from(colors.slice(0, 4)), [0, 1, 0, 1]);
    assert.deepEqual(Array.from(colors.slice(4, 8)), [1, 0, 0, 1]);
    // Ordinals with no point colour stay zero and are never emitted anyway.
    assert.deepEqual(Array.from(colors.slice(8, 12)), [0, 0, 0, 0]);
});

test('per-point colours ride the buckets, and widen the stride to 6', () => {
    const values = Float32Array.from({ length: 4 }, (_, i) => i);
    const colors = Float32Array.from([
        0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1,
    ]);
    const uniform = bucketOverlay(values, 1, 4);
    assert.equal(uniform.stride, 2);
    assert.equal(uniform.points.length, 8);

    const perPoint = bucketOverlay(values, 1, 4, 0, 3, colors);
    assert.equal(perPoint.stride, 6);
    assert.equal(perPoint.points.length, 4 * 6);
    // x and value are unchanged; only the colour payload is added.
    for (let i = 0; i < 4; i++) {
        assert.equal(perPoint.points[i * 6], uniform.points[i * 2]);
        assert.equal(perPoint.points[i * 6 + 1], uniform.points[i * 2 + 1]);
    }
    assert.deepEqual(Array.from(perPoint.points.slice(2, 6)), [0, 0, 1, 1]);
    assert.deepEqual(Array.from(perPoint.points.slice(20, 24)), [1, 1, 0, 1]);

    // At an aggregated level the colour comes from the bucket's last ordinal,
    // which is the point whose value the bucket took.
    const reduced = bucketOverlay(values, 2, 4, 0, 3, colors);
    assert.equal(reduced.stride, 6);
    assert.equal(reduced.points.length, 2 * 6);
    assert.deepEqual(Array.from(reduced.points.slice(0, 2)), [0, 1]);
    assert.deepEqual(Array.from(reduced.points.slice(2, 6)), [0, 1, 0, 1]);
});

test('overlay and candles reduce to one bucket per bucket, at every level', () => {
    // The pairing is the property: bucket N of the overlay is bucket N of the candle
    // level, and both read their position from the same conversion. Checking the
    // pairing rather than two independently-computed x values is the point — the bug
    // this replaced was two formulas that agreed only while no session break existed,
    // and any test comparing them to each other would have kept passing on the data
    // that hides it.
    //
    // Counts that are not a power of two are included on purpose: a trailing partial
    // group is where the two most easily disagree.
    for (const count of [16, 17, 33, 100, 257]) {
        const values = Float32Array.from({ length: count }, (_, i) => 100 + i);
        for (const factor of [1, 2, 4, 8, 16]) {
            const bucketCount = Math.ceil(count / factor);
            const bucketed = bucketPoints(values, factor, count, 0, count - 1);
            assert.equal(bucketed.length / 2, bucketCount,
                `count ${count} factor ${factor}: wrong point count`);
            for (let bucket = 0; bucket < bucketCount; bucket++) {
                assert.equal(bucketed[bucket * 2], bucket,
                    `count ${count} factor ${factor} bucket ${bucket}: x is not the bucket index`);
                // The value is the bucket's last ordinal, so the two reduce over the same
                // bars even though neither holds the other's coordinates.
                const last = Math.min(bucket * factor + factor, count) - 1;
                assert.equal(bucketed[bucket * 2 + 1], 100 + last,
                    `count ${count} factor ${factor} bucket ${bucket}: wrong value`);
            }
        }
    }
});

test('an overlay and a bucket of candles get the same slot, breaks and all', () => {
    // The invariant the shipped bug violated, stated where it is now decided. Both sides
    // call `bucketCentreSlot` with the same bucket index, so this is close to a
    // tautology — which is the intended shape. A bucket that straddles a break is the
    // case that earns it: its position is the middle of what it spans, not the bar at
    // its middle ordinal, and the two differ by most of the width of the gap.
    //
    // Fifty bars to a session, not forty, because a power-of-two session length puts
    // every break exactly on a bucket boundary at these factors and the interesting
    // bucket never exists.
    const times = [];
    let cursor = Date.UTC(2025, 0, 6, 14, 30);
    for (let session = 0; session < 3; session++) {
        for (let i = 0; i < 50; i++) times.push(cursor + i * 60_000);
        cursor += 50 * 60_000 + 17 * 60 * 60_000;
    }
    const resolved = resolveSessionBreaks(times, { mode: 'proportional' });
    const slots = computeSlotOffsets(times, sizeSessionBreaks(times, resolved));
    const count = times.length;
    const values = Float32Array.from({ length: count }, (_, i) => 100 + i);
    const breakAt = times.findIndex((time, i) => i > 0 && time - times[i - 1] > 3 * 60_000);

    for (const factor of [1, 2, 4, 8]) {
        const bucketed = bucketPoints(values, factor, count, 0, count - 1);
        for (let bucket = 0; bucket < bucketed.length / 2; bucket++) {
            assert.equal(
                bucketCentreSlot(slots, bucketed[bucket * 2], factor, count),
                bucketCentreSlot(slots, bucket, factor, count),
                `factor ${factor} bucket ${bucket}: overlay and candle disagree`,
            );
        }
    }

    // The centre is the middle of the bars the bucket spans, which is only different
    // from the middle *ordinal* when a break falls inside the bucket. Find that bucket
    // rather than trusting a hand-picked one, so the fixture cannot quietly stop
    // containing it.
    const straddling = [];
    for (const factor of [2, 4, 8]) {
        for (let bucket = 0; bucket * factor < count; bucket++) {
            const first = bucket * factor;
            if (breakAt > first && breakAt <= first + factor - 1) straddling.push({ bucket, factor });
        }
    }
    assert.ok(straddling.length > 0, 'the fixture has no bucket spanning a break, so this proves nothing');
    for (const { bucket, factor } of straddling) {
        const first = bucket * factor;
        const last = Math.min(first + factor, count) - 1;
        const centre = bucketCentreSlot(slots, bucket, factor, count);
        assert.equal(centre, (slotAtIndex(slots, first) + slotAtIndex(slots, last)) / 2,
            `factor ${factor} bucket ${bucket}: not the middle of what it spans`);
        assert.ok(
            Math.abs(centre - slotAtIndex(slots, (first + last) / 2)) > 1,
            `factor ${factor} bucket ${bucket}: the middle ordinal would have been good enough`,
        );
    }
});
