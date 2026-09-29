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

// --- The visible-window cull -------------------------------------------------
//
// An overlay is reduced over the bars the plot covers rather than the whole
// retained series. The reduction therefore has to be the *same* reduction on a
// narrower range: same buckets, same order, same values. These tests derive the
// expectation from the buckets rather than from a second implementation, because a
// hand-written cull that re-derives the answer would agree with a wrong one.

const BARS = 512;
const bigTimes = Array.from({ length: BARS }, (_, i) => BASE + i * 60_000);

/** values[i] is a distinct, order-revealing number so a shift cannot hide. */
const ramp = (n) => Float32Array.from({ length: n }, (_, i) => i * 1.5 + 1);

/** Unwrap to a list of [x, value] pairs. */
function pairs(result) {
    const out = [];
    for (let i = 0; i < result.points.length; i += result.stride) {
        out.push([result.points[i], result.points[i + 1]]);
    }
    return out;
}

test('a culled reduction is a contiguous slice of the full reduction', () => {
    // The load-bearing property. Whatever the window, every emitted bucket must be
    // the same bucket the full reduction emitted, carrying the same value.
    for (const factor of [1, 2, 4, 8, 16]) {
        for (const [from, to] of [[0, BARS - 1], [100, 200], [0, 40], [BARS - 40, BARS - 1]]) {
            const values = ramp(BARS);
            const full = bucketOverlay(values, factor, BARS, 0, BARS - 1, null, 0);
            const culled = bucketOverlay(values, factor, BARS, 0, BARS - 1, null, 0, from, to);
            const fullPairs = pairs(full);
            const culledPairs = pairs(culled);

            assert.ok(culledPairs.length > 0, `factor ${factor}: window ${from}..${to} emitted nothing`);
            // Every culled point is present, in order, with the identical value.
            let cursor = 0;
            for (const point of culledPairs) {
                while (cursor < fullPairs.length && fullPairs[cursor][0] < point[0]) cursor++;
                assert.ok(cursor < fullPairs.length, `factor ${factor}: x ${point[0]} absent from full reduction`);
                assert.deepEqual(
                    fullPairs[cursor], point,
                    `factor ${factor} window ${from}..${to}: culled point ${JSON.stringify(point)} `
                    + `does not match full point ${JSON.stringify(fullPairs[cursor])}`,
                );
                cursor++;
            }
        }
    }
});

test('the cull keeps an overlay entering from off-screen', () => {
    // A window in the middle of the series must still draw the bar just left of it,
    // or the line starts in mid-air instead of reaching the plot edge.
    const values = ramp(BARS);
    const result = bucketOverlay(values, 1, BARS, 0, BARS - 1, null, 0, 200, 240);
    const xs = pairs(result).map((p) => p[0]);
    assert.equal(xs[0], 199, 'expected the window widened by one bar on the left');
    assert.ok(xs.includes(240), 'expected the window widened by one bar on the right');
});

test('the cull widens by a bucket, not a bar, when reduced', () => {
    const values = ramp(BARS);
    const result = bucketOverlay(values, 8, BARS, 0, BARS - 1, null, 0, 200, 240);
    const xs = pairs(result).map((p) => p[0]);
    // 200/8 = 25 exactly, 240/8 = 30 exactly, so the widened floor reaches bucket 24
    // and the ceiling bucket 30. A one-*bar* margin would have emitted neither.
    assert.ok(xs.includes(24), `expected bucket 24, got ${xs[0]}..${xs[xs.length - 1]}`);
    assert.ok(xs.includes(30), 'expected bucket 30');
});

test('a cull never resurrects a bar the indicator does not cover', () => {
    // A warm-up leaves the leading bars uncovered. The cull must be clamped to the
    // covered window, or a leading edge is drawn from zero -- the destructive case the
    // engine's own contract calls out.
    const values = ramp(BARS);
    const covered = bucketOverlay(values, 1, BARS, 100, BARS - 1, null, 0, 0, BARS - 1);
    const xs = pairs(covered).map((p) => p[0]);
    assert.equal(xs[0], 100, 'the first emitted bar is the first covered bar');
    // And with the window entirely inside the covered range, nothing shifts.
    const culled = bucketOverlay(values, 1, BARS, 100, BARS - 1, null, 0, 300, 340);
    const culledXs = pairs(culled).map((p) => p[0]);
    assert.equal(culledXs[0], 299);
    assert.ok(culledXs.every((x) => x >= 100), 'emitted an uncovered bar');
});

test('a window off the covered range emits nothing', () => {
    const values = ramp(BARS);
    const result = bucketOverlay(values, 1, BARS, 0, 100, null, 0, 400, 500);
    assert.equal(result.points.length, 0);
});

test('the cull preserves per-point colour and its stride', () => {
    const values = ramp(BARS);
    const colors = new Float32Array(BARS * 4);
    for (let i = 0; i < BARS; i++) {
        colors[i * 4] = i / BARS;
        colors[i * 4 + 3] = 1;
    }
    const full = bucketOverlay(values, 1, BARS, 0, BARS - 1, colors, 0);
    const culled = bucketOverlay(values, 1, BARS, 0, BARS - 1, colors, 0, 100, 140);
    assert.equal(culled.stride, 6);
    // 100..140 widens by one bar to 99..141.
    assert.equal(culled.points[0], 99);
    // Colour travels with the value it was recorded against, not with the position.
    const ordinal = culled.points[0];
    assert.equal(culled.points[2], colors[ordinal * 4]);
    assert.deepEqual(
        Array.from(culled.points), Array.from(full.points).slice(99 * 6, 142 * 6),
    );
});

test('the cull allocates from the window, not the series', () => {
    // The reason the cull exists. Sizing the buffer from `sourceCount` allocates a
    // full-length buffer per overlay per frame, which is the O(history) cost the
    // window removes on the write side but reintroduces on the allocation side.
    const values = ramp(BARS);
    const result = bucketOverlay(values, 1, BARS, 0, BARS - 1, null, 0, 100, 140);
    // 100..140 widens by one bar at each end to 99..141, which is 43 bars.
    assert.equal(
        result.points.length, 43 * 2,
        'expected the buffer sized to the emitted window, not to 512 bars',
    );
    assert.ok(
        result.points.length < BARS * 2 / 4,
        'the buffer is still sized to a large fraction of the series',
    );
});

test('a trimmed series still buckets on the absolute grid', () => {
    // barBase is what stops a cull from putting a moving average a whole bucket away
    // from the price it annotates. Derived from the absolute grid rather than compared
    // against a rebuild, because a rebuild re-cuts and would assert the opposite.
    const BASE_ORD = 1000; // 1000 bars trimmed before the retained window
    const values = ramp(BARS);
    const result = bucketOverlay(values, 4, BARS, 0, BARS - 1, null, BASE_ORD, 200, 240);
    const xs = pairs(result).map((p) => p[0]);

    // x is an **absolute bucket index**, so the unit is a bucket of 4, not a bar.
    // Retained ordinal 200 is absolute bar 1200, which is bucket 300.
    assert.ok(xs.includes(300), `expected absolute bucket 300, got ${xs[0]}..${xs[xs.length - 1]}`);
    // 200 widened by a bucket to 196, i.e. absolute 1196, i.e. bucket 299.
    assert.equal(xs[0], 299, 'expected the bucket holding the widened window start');
    for (const x of xs) {
        // x is a bucket index, so its group is absolute bars [x*4, (x+1)*4). The grid
        // is cut on absolute boundaries: a bucket is aligned iff x*4 is, which every
        // integer x satisfies. The assertion that matters is that the group's absolute
        // bars lie inside the retained window — a retained-relative x would put bucket
        // 196 at absolute bar 784, which is 216 bars before the data starts.
        const firstAbsoluteBar = x * 4;
        assert.ok(
            firstAbsoluteBar >= BASE_ORD,
            `emitted bucket ${x} starts at absolute bar ${firstAbsoluteBar}, before the retained base ${BASE_ORD}`,
        );
        assert.ok(
            firstAbsoluteBar >= BASE_ORD + 196 && firstAbsoluteBar <= BASE_ORD + 244,
            `emitted bucket ${x} covers absolute bar ${firstAbsoluteBar}, outside the widened window`,
        );
    }
    // And every bucket advances by one, with no gap and no repeat.
    for (let i = 1; i < xs.length; i++) {
        assert.equal(xs[i], xs[i - 1] + 1, 'buckets are not contiguous');
    }
});

test('OverlaySpec supports type: line, histogram, band, area and baseline', () => {
    const resolved = resolveOverlays([
        { id: 'macd_hist', type: 'histogram', baseline: 0, points: points([1, -2, 3], 0) },
        { id: 'bollinger_cloud', type: 'band', points: points([10, 11, 12], 0), points2: points([8, 9, 10], 0), fillColor: 'rgba(0, 100, 255, 0.2)' },
        { id: 'rsi_area', type: 'area', baseline: 30, points: points([40, 50, 60], 0) },
    ], times, color);

    assert.equal(resolved.length, 3);
    assert.equal(resolved[0].type, 'histogram');
    assert.equal(resolved[0].baseline, 0);

    assert.equal(resolved[1].type, 'band');
    assert.ok(resolved[1].values2 !== null);
    assert.equal(resolved[1].values2[0], 8);
    assert.equal(resolved[1].values2[1], 9);
    assert.equal(resolved[1].values2[2], 10);
    assert.ok(resolved[1].fillColor !== null);

    assert.equal(resolved[2].type, 'area');
    assert.equal(resolved[2].baseline, 30);
});

test('OverlaySpec rejects invalid type string', () => {
    throws(
        () => resolveOverlays([{ id: 'bad', type: 'scatter', points: points([1], 0) }], times, color),
        /unknown type/,
    );
});
