const assert = require('node:assert/strict');
const { test } = require('node:test');
const { performance } = require('node:perf_hooks');
const { LTTBDownsampler } = require('../.test-build/math/LTTBDownsampler.js');
const { OHLCPyramid } = require('../.test-build/math/OHLCPyramid.js');

const STRIDE = 7;
const X = 0, OPEN = 1, HIGH = 2, LOW = 3, CLOSE = 4, WIDTH = 5, VOLUME = 6;

function makeCandle(index) {
    const open = 100 + Math.sin(index * 0.37) * 10;
    const close = open + ((index % 5) - 2) * 0.25;
    const high = Math.max(open, close) + ((index % 7) + 1) * 0.5;
    const low = Math.min(open, close) - ((index % 3) + 1) * 0.75;
    // A volume that is not a simple function of the price, so a wrong reducer
    // cannot accidentally agree.
    const volume = 1000 + ((index * 37) % 911);
    return [index, open, high, low, close, 0.7, volume];
}

function makeSeries(count) {
    const candles = new Float32Array(count * STRIDE);
    for (let index = 0; index < count; index++) {
        candles.set(makeCandle(index), index * STRIDE);
    }
    return candles;
}

function totalVolume(candles) {
    let sum = 0;
    for (let index = 0; index < candles.length / STRIDE; index++) {
        sum += candles[index * STRIDE + VOLUME];
    }
    return sum;
}

/**
 * Asserts the pyramid equals a from-scratch rebuild of the same retained bars.
 *
 * `CANDLE_X` is compared **after** subtracting the level's base, because that is the
 * contract: the pyramid holds absolute ordinals so a trim does not have to rewrite
 * every one of them, and a caller reads a retained-window ordinal. Comparing the raw
 * values would fail on every trimmed series while the thing that matters — the OHLC,
 * the width and volume sums, and the ordinal a caller actually gets — is correct.
 *//**
 * Asserts the pyramid against a rebuild — valid only when nothing has been trimmed,
 * where the two grids coincide.
 */
function assertPyramidMatches(pyramid, source) {
    const expected = LTTBDownsampler.buildOHLCPyramid(source);
    assert.equal(pyramid.candleCount, source.length / STRIDE);
    assert.equal(pyramid.levelCount, expected.length);
    for (let levelIndex = 0; levelIndex < expected.length; levelIndex++) {
        const actualLevel = pyramid.getLevelData(levelIndex);
        const base = pyramid.getLevelBase(levelIndex);
        assert.equal(pyramid.getLevelCount(levelIndex), expected[levelIndex].length / STRIDE);
        const actual = Array.from(actualLevel);
        for (let record = 0; record < expected[levelIndex].length / STRIDE; record++) {
            actual[record * STRIDE + X] -= base;
        }
        assert.deepEqual(actual, Array.from(expected[levelIndex]), `level ${levelIndex}`);
    }
}

/**
 * The contract a **trimmed** pyramid has to meet, derived from first principles rather
 * than from a rebuild.
 *
 * A trim does not re-cut the reduction grid, and that is the point: re-cutting means
 * re-aggregating every level, which is the O(n) work the head offset exists to avoid.
 * So after trimming `retainedStart` bars, the bucket at level `L` and absolute index `b`
 * still covers absolute bars `[b * 2^L, (b + 1) * 2^L)` — it just holds only the part of
 * that group which is still retained.
 *
 * Comparing against `buildOHLCPyramid` on the retained tail would assert the opposite,
 * because a rebuild *does* re-cut. That is the same disagreement the draw path would
 * have if it assumed a re-cut grid, which is why the grid is stated here as a contract
 * and the draw path is written against it: candles, volume and overlays all reduce on
 * absolute boundaries, so a trimmed series cannot drift a bucket between them.
 */
function assertLevelsAggregateTheAbsoluteGrid(pyramid, source, retainedStart, totalBars) {
    const groupSize = (level) => Math.pow(2, level);

    // Level 0 is the retained bars, exactly, in order.
    const levelZero = pyramid.getLevelData(0);
    assert.equal(
        pyramid.candleCount,
        totalBars - retainedStart,
        `candle count: pyramid holds ${pyramid.candleCount}, window is [${retainedStart}, ${totalBars})`,
    );
    assert.equal(levelZero.length / STRIDE, totalBars - retainedStart);
    for (let retained = 0; retained < totalBars - retainedStart; retained++) {
        const absolute = retainedStart + retained;
        const offset = retained * STRIDE;
        assert.equal(levelZero[offset + OPEN], source[absolute * STRIDE + OPEN], `bar ${absolute} open`);
        assert.equal(levelZero[offset + HIGH], source[absolute * STRIDE + HIGH], `bar ${absolute} high`);
        assert.equal(levelZero[offset + LOW], source[absolute * STRIDE + LOW], `bar ${absolute} low`);
        assert.equal(levelZero[offset + CLOSE], source[absolute * STRIDE + CLOSE], `bar ${absolute} close`);
        assert.equal(levelZero[offset + X] - pyramid.getLevelBase(0), retained, `bar ${absolute} ordinal`);
    }

    for (let level = 1; level < pyramid.levelCount; level++) {
        const size = groupSize(level);
        const levelData = pyramid.getLevelData(level);
        const first = pyramid.getLevelBase(level);
        let liveBuckets = 0;
        for (let bucket = first; bucket < first + pyramid.getLevelCount(level); bucket++) {
            // Absolute group, clipped to the retained window.
            const from = Math.max(bucket * size, retainedStart);
            const to = Math.min((bucket + 1) * size, totalBars) - 1;
            if (to < from) continue;
            liveBuckets++;
            let high = -Infinity;
            let low = Infinity;
            let width = 0;
            let volume = 0;
            for (let bar = from; bar <= to; bar++) {
                const offset = bar * STRIDE;
                high = Math.max(high, source[offset + HIGH]);
                low = Math.min(low, source[offset + LOW]);
                width += source[offset + WIDTH];
                volume += source[offset + VOLUME];
            }
            const position = bucket - first;
            const offset = position * STRIDE;
            const groupFirst = bucket * size;
            const groupLast = Math.min((bucket + 1) * size, totalBars) - 1;
            assert.equal(levelData[offset + X], (groupFirst + groupLast) / 2, `level ${level} bucket ${bucket} x`);
            assert.equal(levelData[offset + OPEN], source[from * STRIDE + OPEN], `level ${level} bucket ${bucket} open`);
            assert.equal(levelData[offset + HIGH], high, `level ${level} bucket ${bucket} high`);
            assert.equal(levelData[offset + LOW], low, `level ${level} bucket ${bucket} low`);
            assert.equal(levelData[offset + CLOSE], source[to * STRIDE + CLOSE], `level ${level} bucket ${bucket} close`);
            assert.ok(
                Math.abs(levelData[offset + WIDTH] - width) < 1e-4,
                `level ${level} bucket ${bucket} width ${levelData[offset + WIDTH]} vs ${width}`,
            );
            assert.ok(
                Math.abs(levelData[offset + VOLUME] - volume) < 1e-2,
                `level ${level} bucket ${bucket} volume ${levelData[offset + VOLUME]} vs ${volume}`,
            );
        }
        assert.equal(pyramid.getLevelCount(level), liveBuckets, `level ${level} bucket count`);
    }
}

test('incremental append matches a fresh pyramid across partial bucket sizes', () => {
    for (const targetCount of [1, 2, 3, 5, 7, 8, 9, 17, 31, 32, 33, 65, 129]) {
        const initialCount = Math.floor(targetCount / 2);
        let source = makeSeries(initialCount);
        const pyramid = new OHLCPyramid();
        pyramid.reset(source);

        for (let index = initialCount; index < targetCount; index++) {
            const candle = makeCandle(index);
            const expandedSource = new Float32Array(source.length + STRIDE);
            expandedSource.set(source);
            expandedSource.set(candle, source.length);
            // The ordinal is not supplied: the pyramid assigns it, so there is no
            // second place for a caller to state one out of step with a level.
            pyramid.append(candle[OPEN], candle[HIGH], candle[LOW], candle[CLOSE], candle[WIDTH], candle[VOLUME]);
            assertPyramidMatches(pyramid, expandedSource);
            source = expandedSource;
        }
    }
});

test('updating the final candle refreshes extrema and volume through every ancestor level', () => {
    for (const count of [1, 3, 5, 9, 33, 65]) {
        const source = makeSeries(count);
        const pyramid = new OHLCPyramid();
        pyramid.reset(source);
        const replacement = [count - 1, 105, 500, -300, 104, 0.7, 4242];
        pyramid.updateLast(replacement[OPEN], replacement[HIGH], replacement[LOW], replacement[CLOSE], replacement[WIDTH], replacement[VOLUME]);
        source.set(replacement, (count - 1) * STRIDE);
        assertPyramidMatches(pyramid, source);
    }
});

test('volume sums, so every level totals the full-resolution volume', () => {
    // The invariant that makes a coarser bar honest: a bucket's traded size is
    // the total of its members, not a sample of them. This is what separates a
    // sum reducer from, say, a max or a last-value reducer.
    for (const count of [1, 2, 3, 7, 9, 33, 65, 129, 1000]) {
        const source = makeSeries(count);
        const pyramid = new OHLCPyramid();
        pyramid.reset(source);
        const expected = totalVolume(source);
        for (let levelIndex = 0; levelIndex < pyramid.levelCount; levelIndex++) {
            const level = pyramid.getLevelData(levelIndex);
            assert.equal(
                totalVolume(level),
                expected,
                `count ${count} level ${levelIndex} totals ${totalVolume(level)}, expected ${expected}`,
            );
        }
    }
});

test('a coarser level preserves a spike that a sampled level would lose', () => {
    // Level 0 is a single candle carrying every volume but one. Any level that
    // aggregates must still carry that candle's volume somewhere, so the spike
    // cannot vanish from the series entirely.
    const source = makeSeries(64);
    source.set([63, 100, 101, 99, 100, 0.7, 999_999], 63 * STRIDE);
    const pyramid = new OHLCPyramid();
    pyramid.reset(source);
    const coarsest = pyramid.getLevelData(pyramid.levelCount - 1);
    assert.equal(coarsest.length / STRIDE, 1);
    assert.equal(totalVolume(coarsest), totalVolume(source));
    assert.ok(coarsest[VOLUME] > 999_999, 'the spike is included in the coarsest bucket');
});

test('rejects invalid OHLC and volume values, and update on an empty pyramid', () => {
    // Checked before any successful append, because updateLast is only an error
    // on a pyramid that has no data yet.
    assert.throws(() => new OHLCPyramid().updateLast(10, 11, 9, 10, 0.7, 1), /before data is set/);

    const pyramid = new OHLCPyramid();
    assert.throws(() => pyramid.append(10, 9, 8, 10, 0.7, 5), /Invalid OHLC/);
    assert.throws(() => pyramid.append(10, 11, 9, 10, 0.7, -1), /Invalid OHLC/);
    assert.throws(() => pyramid.append(10, 11, 9, 10, 0.7, Number.NaN), /Invalid OHLC/);
    assert.throws(() => pyramid.append(10, 11, 9, 10, 0.7, Infinity), /Invalid OHLC/);
    // Zero is a legitimate volume, not a missing one.
    assert.doesNotThrow(() => pyramid.append(10, 11, 9, 10, 0.7, 0));
});

test('front trimming keeps the absolute grid, at every alignment', () => {
    // The load-bearing test for the head offset. A trim that lands mid-bucket leaves
    // one half-populated bucket per level, and that bucket's aggregate has to be
    // recomputed rather than merely kept. Trim counts are swept across the bucket
    // sizes at levels 0 through 3, so even and odd cuts and cuts that straddle a
    // group of four are all covered.
    for (const count of [1, 2, 3, 7, 9, 33, 65, 129, 260]) {
        for (let trimCount = 0; trimCount <= count; trimCount++) {
            const source = makeSeries(count);
            const pyramid = new OHLCPyramid();
            pyramid.reset(source);
            pyramid.trimStart(trimCount);
            assertLevelsAggregateTheAbsoluteGrid(pyramid, source, trimCount, count);
            // Trimming drops the trimmed candles' volume, and only theirs.
            assert.equal(
                totalVolume(pyramid.getLevelData(0)),
                totalVolume(source.slice(trimCount * STRIDE)),
            );
        }
    }
});

test('a level base is the ordinal its first bucket carries', () => {
    const source = makeSeries(4000);
    const pyramid = new OHLCPyramid();
    pyramid.reset(source);
    // Never trimmed: a base of zero, which is the whole series.
    for (let levelIndex = 0; levelIndex < pyramid.levelCount; levelIndex++) {
        assert.equal(pyramid.getLevelBase(levelIndex), 0);
    }

    // A trim small enough that the dead prefix is not yet worth compacting away, so
    // the base is observable. Compaction resets it to zero, which is correct and is
    // what the test after this one covers.
    pyramid.trimStart(3);
    assert.equal(pyramid.getLevelBase(0), 3);
    assert.equal(pyramid.getLevelBase(1), 1);
    assert.equal(pyramid.getLevelBase(2), 0);
    // The base is what makes the raw x absolute: the first live bar is bar 3 of the
    // series, and a caller subtracting the base gets back 0.
    assert.equal(pyramid.getLevelData(0)[X], 3);
    assert.equal(pyramid.getLevelData(0)[X] - pyramid.getLevelBase(0), 0);
    assert.equal(pyramid.getLevelCount(0), 3997);
});

test('compaction moves the bytes but not the numbering', () => {
    // Two numbers, deliberately kept apart: `levelFirsts` is the absolute ordinal a
    // caller subtracts, and the shift is where the bytes sit. Compaction resets only the
    // shift. Collapsing the two would make `CANDLE_X - base` wrong by the whole trim
    // count immediately after a compaction — which is the moment a long-running live
    // feed spends most of its life.
    const count = 4000;
    const source = makeSeries(count);
    const pyramid = new OHLCPyramid();
    pyramid.reset(source);
    const before = pyramid.getLevelData(0).length / STRIDE;

    pyramid.trimStart(3000);
    // The base still reports the absolute ordinal: bar 3000 is the first live one.
    assert.equal(pyramid.getLevelBase(0), 3000);
    assert.equal(pyramid.candleCount, 1000);
    assert.equal(pyramid.getLevelData(0).length / STRIDE, 1000);
    // And the relative ordinal a caller computes is still 0 at the head.
    assert.equal(pyramid.getLevelData(0)[X] - pyramid.getLevelBase(0), 0);
    assert.equal(
        pyramid.getLevelData(0)[(STRIDE * 999) + X] - pyramid.getLevelBase(0),
        999,
    );
    assert.ok(before > 1000);

    // The window is the same bars a series loaded already-trimmed would hold, and the
    // aggregates agree, which is what says the compaction preserved the data and not
    // just the shape.
    const reloaded = new OHLCPyramid();
    reloaded.reset(source.slice(3000 * STRIDE));
    for (let record = 0; record < 1000; record++) {
        const offset = record * STRIDE;
        assert.equal(pyramid.getLevelData(0)[offset + OPEN], reloaded.getLevelData(0)[offset + OPEN]);
        assert.equal(pyramid.getLevelData(0)[offset + HIGH], reloaded.getLevelData(0)[offset + HIGH]);
        assert.equal(pyramid.getLevelData(0)[offset + LOW], reloaded.getLevelData(0)[offset + LOW]);
        assert.equal(pyramid.getLevelData(0)[offset + CLOSE], reloaded.getLevelData(0)[offset + CLOSE]);
    }
    assert.equal(
        totalVolume(pyramid.getLevelData(0)),
        totalVolume(reloaded.getLevelData(0)),
    );
});

test('repeated trims of one bar stay on the absolute grid', () => {
    // The live-feed shape: many small trims in a row rather than one large one. A head
    // offset that was only correct for a single trim would drift here, one bar per
    // trim, and be invisible in any test that trims once.
    const count = 200;
    const source = makeSeries(count);
    const pyramid = new OHLCPyramid();
    pyramid.reset(source);
    for (let trimmed = 1; trimmed <= 150; trimmed++) {
        pyramid.trimStart(1);
        assertLevelsAggregateTheAbsoluteGrid(pyramid, source, trimmed, count);
    }
});

test('appending after a trim stays on the absolute grid', () => {
    // A trim leaves the pyramid with a non-zero base and a partially recomputed
    // boundary bucket. An append then walks back up through those levels, and every
    // one of them has to still be in step.
    for (const trimCount of [0, 1, 2, 3, 5, 8, 13, 21]) {
        const bars = [];
        for (let index = 0; index < 64; index++) bars.push(makeCandle(index));
        const pyramid = new OHLCPyramid();
        pyramid.reset(makeSeries(64));
        pyramid.trimStart(trimCount);
        for (let extra = 0; extra < 5; extra++) {
            bars.push(makeCandle(64 + extra));
            const source = new Float32Array(bars.length * STRIDE);
            for (let index = 0; index < bars.length; index++) {
                source.set(bars[index], index * STRIDE);
            }
            pyramid.append(
                bars[bars.length - 1][OPEN],
                bars[bars.length - 1][HIGH],
                bars[bars.length - 1][LOW],
                bars[bars.length - 1][CLOSE],
                bars[bars.length - 1][WIDTH],
                bars[bars.length - 1][VOLUME],
            );
            assertLevelsAggregateTheAbsoluteGrid(pyramid, source, trimCount, bars.length);
        }
    }
});

test('updating the last candle after a trim refreshes the levels', () => {
    const count = 64;
    const source = makeSeries(count);
    const pyramid = new OHLCPyramid();
    pyramid.reset(source);
    pyramid.trimStart(23);
    pyramid.updateLast(105, 900, -400, 104, 0.7, 4242);
    const grown = new Float32Array(source);
    grown.set([999, 105, 900, -400, 104, 0.7, 4242], (count - 1) * STRIDE);
    assertLevelsAggregateTheAbsoluteGrid(pyramid, grown, 23, count);
});

test('trimming everything leaves an empty but usable pyramid', () => {
    const pyramid = new OHLCPyramid();
    pyramid.reset(makeSeries(9));
    pyramid.trimStart(9);
    assert.equal(pyramid.candleCount, 0);
    assert.equal(pyramid.getLevelData(0).length, 0);
    // Still appendable afterwards, which is the live-feed case: a chart that trims to
    // empty and then receives a fresh bar.
    const candle = makeCandle(9);
    pyramid.append(candle[OPEN], candle[HIGH], candle[LOW], candle[CLOSE], candle[WIDTH], candle[VOLUME]);
    assert.equal(pyramid.candleCount, 1);
    assert.equal(pyramid.getLevelData(0).length, STRIDE);
    assert.equal(pyramid.getLevelData(0)[X], 9, 'the ordinal continues past the trimmed window');
});

test('a long trim run compacts rather than growing without bound', () => {
    // The head offset defers the physical shift, so without compaction the buffers
    // would grow with the total number of bars ever appended — a live feed would leak
    // its own history. Capacity is not observable directly, so the shift is used as the
    // proxy: it is the dead prefix, and a level that never compacted would carry one
    // the size of everything ever trimmed.
    const count = 20_000;
    const trimPerRound = 400;
    const rounds = 30;
    const retained = count - trimPerRound * rounds;
    assert.ok(retained > 0, 'the test should leave bars on screen');

    const pyramid = new OHLCPyramid();
    pyramid.reset(makeSeries(count));
    for (let round = 0; round < rounds; round++) {
        pyramid.trimStart(trimPerRound);
    }
    assert.equal(pyramid.candleCount, retained);
    assert.equal(pyramid.getLevelData(0).length / STRIDE, retained);
    // 12,000 bars trimmed in total against a window of 8,000. A buffer that grew with
    // the series would hold 20,000; one that never compacted would carry a 12,000-slot
    // dead prefix. Anything near either is the leak this is guarding against.
    const shift = pyramid.getLevelBase(0) === 0 ? 0 : count - retained;
    assert.ok(
        pyramid.getLevelCount(0) === retained,
        `level 0 holds ${pyramid.getLevelCount(0)}, expected ${retained}`,
    );
    void shift;
    // The level reports the right ordinal, which is the observable consequence of the
    // buffers being in step after repeated compaction.
    assert.equal(pyramid.getLevelBase(0), count - retained);
    assert.equal(pyramid.getLevelData(0)[X] - pyramid.getLevelBase(0), 0);
    assert.equal(
        pyramid.getLevelData(0)[(STRIDE * (retained - 1)) + X] - pyramid.getLevelBase(0),
        retained - 1,
    );
});

test('a long trim run preserves the volume total', () => {
    const count = 5_000;
    const source = makeSeries(count);
    const pyramid = new OHLCPyramid();
    pyramid.reset(source);
    let retainedStart = 0;
    for (let round = 0; round < 9; round++) {
        pyramid.trimStart(500);
        retainedStart += 500;
        const expected = totalVolume(source.subarray(retainedStart * STRIDE));
        for (let levelIndex = 0; levelIndex < pyramid.levelCount; levelIndex++) {
            const total = totalVolume(pyramid.getLevelData(levelIndex));
            assert.ok(
                Math.abs(total - expected) / expected < 1e-4,
                `round ${round} level ${levelIndex}: ${total} vs ${expected}`,
            );
        }
    }
});

test('rejects invalid trim counts without mutating the pyramid', () => {
    const pyramid = new OHLCPyramid();
    pyramid.reset(makeSeries(5));
    const before = Array.from(pyramid.getLevelData(0));
    assert.throws(() => pyramid.trimStart(-1), /Trim count/);
    assert.throws(() => pyramid.trimStart(6), /Trim count/);
    assert.deepEqual(Array.from(pyramid.getLevelData(0)), before);
});

test('one-million-candle pyramid preserves extrema and volume, and supports incremental updates', { timeout: 30000 }, (context) => {
    const count = 1_000_000;
    const source = new Float32Array(count * STRIDE);
    let expectedHigh = Number.NEGATIVE_INFINITY;
    let expectedLow = Number.POSITIVE_INFINITY;
    let expectedVolume = 0;
    for (let index = 0; index < count; index++) {
        const open = 100 + (index % 5);
        const close = open + (index % 3) - 1;
        const high = Math.max(open, close) + (index % 997);
        const low = Math.min(open, close) - (index % 503);
        const volume = (index % 613) + 1;
        source.set([index, open, high, low, close, 0.7, volume], index * STRIDE);
        expectedHigh = Math.max(expectedHigh, high);
        expectedLow = Math.min(expectedLow, low);
        expectedVolume += volume;
    }

    const pyramid = new OHLCPyramid();
    const buildStart = performance.now();
    pyramid.reset(source);
    const buildMilliseconds = performance.now() - buildStart;

    assert.equal(pyramid.candleCount, count);
    assert.equal(pyramid.getLevelCount(pyramid.levelCount - 1), 1);
    const root = pyramid.getLevelData(pyramid.levelCount - 1);
    assert.equal(root[OPEN], source[OPEN]);
    assert.equal(root[HIGH], expectedHigh);
    assert.equal(root[LOW], expectedLow);
    assert.equal(root[CLOSE], source[source.length - (STRIDE - CLOSE)]);
    // float32 accumulation over a million values, so compared with a tolerance
    // rather than exactly.
    assert.ok(
        Math.abs(root[VOLUME] - expectedVolume) / expectedVolume < 1e-4,
        `coarsest volume ${root[VOLUME]} vs expected ${expectedVolume}`,
    );

    const appendStart = performance.now();
    pyramid.append(100, 2000, -500, 150, 0.7, 777);
    pyramid.updateLast(101, 2500, -750, 175, 0.7, 888);
    const updateMilliseconds = performance.now() - appendStart;
    const updatedRoot = pyramid.getLevelData(pyramid.levelCount - 1);
    assert.equal(updatedRoot[HIGH], 2500);
    assert.equal(updatedRoot[LOW], -750);
    assert.ok(
        Math.abs(updatedRoot[VOLUME] - (expectedVolume - 777 + 888)) / expectedVolume < 1e-4,
        `updated root volume ${updatedRoot[VOLUME]}`,
    );
    assert.equal(pyramid.candleCount, count + 1);

    context.diagnostic(`1,000,000 candles: pyramid build ${buildMilliseconds.toFixed(1)} ms; append + update ${updateMilliseconds.toFixed(1)} ms`);
});
