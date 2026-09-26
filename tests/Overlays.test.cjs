// Pure tests for src/core/overlays.ts. No DOM, no canvas: the alignment and
// rejection rules are what stop a line being drawn in the wrong place, and they
// are worth pinning down without a browser.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { bucketOverlay, resolveOverlays } = require('../.test-build/core/overlays.js');
const { OHLCPyramid } = require('../.test-build/math/OHLCPyramid.js');

const CANDLE_STRIDE = 7;
const CANDLE_X = 0;

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
    // whose last ordinal is 5, which is bucket 2 covering 4 and 5.
    const bucketed = bucketPoints(values, 2, 16, 5, 15);
    const xs = [];
    for (let i = 0; i < bucketed.length / 2; i++) xs.push(bucketed[i * 2]);
    assert.deepEqual(xs, [4.5, 6.5, 8.5, 10.5, 12.5, 14.5]);
});

test('an overlay that covers nothing buckets to nothing', () => {
    const resolved = resolveOverlays([{ id: 'x', points: [] }], times, color);
    assert.equal(resolved[0].firstIndex, -1);
    assert.equal(bucketPoints(resolved[0].values, 1, times.length, -1, -1).length, 0);
});

test('bucketing lands on exactly the same x as the candle pyramid', () => {
    // The pyramid's rule is x = (firstSourceIndex + lastSourceIndex) / 2 for a
    // group of 2^k. Reproducing it here is what keeps an overlay from drifting.
    const values = Float32Array.from({ length: 16 }, (_, i) => i);
    const full = bucketPoints(values, 1, 16);
    assert.equal(full.length, 32);
    for (let i = 0; i < 16; i++) {
        assert.equal(full[i * 2], i, `x at factor 1, index ${i}`);
        assert.equal(full[i * 2 + 1], i);
    }

    const half = bucketPoints(values, 2, 16);
    assert.equal(half.length / 2, 8);
    assert.deepEqual(Array.from({ length: 8 }, (_, b) => half[b * 2]), [0.5, 2.5, 4.5, 6.5, 8.5, 10.5, 12.5, 14.5]);
    // A bucket takes the last value in its group.
    assert.deepEqual(Array.from({ length: 8 }, (_, b) => half[b * 2 + 1]), [1, 3, 5, 7, 9, 11, 13, 15]);

    const quarter = bucketPoints(values, 4, 16);
    assert.deepEqual(Array.from({ length: 4 }, (_, b) => quarter[b * 2]), [1.5, 5.5, 9.5, 13.5]);
    assert.deepEqual(Array.from({ length: 4 }, (_, b) => quarter[b * 2 + 1]), [3, 7, 11, 15]);
});

test('bucketing handles a group size that does not divide the series', () => {
    // 10 candles at factor 4 gives groups of 4, 4 and 2; the last x must still be
    // the midpoint of its own partial group, not a padded one.
    const values = Float32Array.from({ length: 10 }, (_, i) => i);
    const bucketed = bucketPoints(values, 4, 10);
    assert.equal(bucketed.length / 2, 3);
    assert.deepEqual(Array.from({ length: 3 }, (_, b) => bucketed[b * 2]), [1.5, 5.5, 8.5]);
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
    assert.deepEqual(Array.from(reduced.points.slice(0, 2)), [0.5, 1]);
    assert.deepEqual(Array.from(reduced.points.slice(2, 6)), [0, 1, 0, 1]);
});

test('overlay x equals candle x at every level of a real pyramid', () => {
    // The property that matters is that an overlay and the candles it belongs to
    // share a coordinate at every level, not merely that they are close. Checking
    // it against the pyramid's own x values states that directly, and unlike a
    // pixel sample it covers the aggregated levels too — where drift would
    // actually appear — without depending on a zoom threshold.
    //
    // Counts that are not a power of two are included on purpose: a trailing
    // partial group is where the two x formulas most easily disagree.
    for (const count of [16, 17, 33, 100, 257]) {
        const candles = new Float32Array(count * CANDLE_STRIDE);
        for (let index = 0; index < count; index++) {
            const at = index * CANDLE_STRIDE;
            candles[at + CANDLE_X] = index;
            candles[at + 1] = 100;
            candles[at + 4] = 101;
        }
        const pyramid = new OHLCPyramid();
        pyramid.reset(candles);

        const values = Float32Array.from({ length: count }, (_, i) => 100 + i);
        for (let levelIndex = 0; levelIndex < pyramid.levelCount; levelIndex++) {
            const factor = Math.pow(2, levelIndex);
            const level = pyramid.getLevelData(levelIndex);
            const levelCount = level.length / CANDLE_STRIDE;
            const bucketed = bucketPoints(values, factor, count, 0, count - 1);
            assert.equal(bucketed.length / 2, levelCount,
                `count ${count} level ${levelIndex}: overlay and candles disagree on point count`);
            for (let point = 0; point < levelCount; point++) {
                assert.equal(bucketed[point * 2], level[point * CANDLE_STRIDE + CANDLE_X],
                    `count ${count} level ${levelIndex} point ${point}: x drifted`);
            }
        }
    }
});

test('overlay x still matches after a partial level at a covered suffix', () => {
    // A warm-up means the leading buckets are dropped, so the overlay is offset
    // from the level's start. The surviving points must still sit exactly on the
    // candles they share buckets with.
    const count = 100;
    const warmup = 37;
    const candles = new Float32Array(count * CANDLE_STRIDE);
    for (let index = 0; index < count; index++) {
        candles[index * CANDLE_STRIDE + CANDLE_X] = index;
        candles[index * CANDLE_STRIDE + 1] = 100;
        candles[index * CANDLE_STRIDE + 4] = 101;
    }
    const pyramid = new OHLCPyramid();
    pyramid.reset(candles);
    const values = Float32Array.from({ length: count }, (_, i) => 100 + i);

    for (let levelIndex = 0; levelIndex < pyramid.levelCount; levelIndex++) {
        const factor = Math.pow(2, levelIndex);
        const level = pyramid.getLevelData(levelIndex);
        const levelCount = level.length / CANDLE_STRIDE;
        const bucketed = bucketPoints(values, factor, count, warmup, count - 1);
        // Every emitted overlay point must match the candle at that same x.
        for (let point = 0; point < bucketed.length / 2; point++) {
            const x = bucketed[point * 2];
            let matched = false;
            for (let candle = 0; candle < levelCount; candle++) {
                if (level[candle * CANDLE_STRIDE + CANDLE_X] !== x) continue;
                matched = true;
                break;
            }
            assert.ok(matched, `level ${levelIndex}: overlay x ${x} matches no candle at that level`);
        }
        // The first emitted point is the first bucket whose last ordinal is covered.
        assert.ok(bucketed.length / 2 > 0, `level ${levelIndex}: nothing emitted`);
    }
});
