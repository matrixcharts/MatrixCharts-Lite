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

function assertPyramidMatches(pyramid, source) {
    const expected = LTTBDownsampler.buildOHLCPyramid(source);
    assert.equal(pyramid.candleCount, source.length / STRIDE);
    assert.equal(pyramid.levelCount, expected.length);
    for (let levelIndex = 0; levelIndex < expected.length; levelIndex++) {
        const actualLevel = pyramid.getLevelData(levelIndex);
        assert.equal(pyramid.getLevelCount(levelIndex), expected[levelIndex].length / STRIDE);
        assert.deepEqual(Array.from(actualLevel), Array.from(expected[levelIndex]));
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
            pyramid.append(...candle);
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
        pyramid.updateLast(...replacement);
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
    assert.throws(() => new OHLCPyramid().updateLast(0, 10, 11, 9, 10, 0.7, 1), /before data is set/);

    const pyramid = new OHLCPyramid();
    assert.throws(() => pyramid.append(0, 10, 9, 8, 10, 0.7, 5), /Invalid OHLC/);
    assert.throws(() => pyramid.append(0, 10, 11, 9, 10, 0.7, -1), /Invalid OHLC/);
    assert.throws(() => pyramid.append(0, 10, 11, 9, 10, 0.7, Number.NaN), /Invalid OHLC/);
    assert.throws(() => pyramid.append(0, 10, 11, 9, 10, 0.7, Infinity), /Invalid OHLC/);
    // Zero is a legitimate volume, not a missing one.
    assert.doesNotThrow(() => pyramid.append(0, 10, 11, 9, 10, 0.7, 0));
});

test('front trimming rebases x indices and rebuilds every aggregate level', () => {
    for (const count of [1, 2, 3, 7, 9, 33, 65]) {
        for (let trimCount = 0; trimCount <= count; trimCount++) {
            const source = makeSeries(count);
            const pyramid = new OHLCPyramid();
            pyramid.reset(source);
            pyramid.trimStart(trimCount);

            const retained = source.slice(trimCount * STRIDE);
            for (let index = 0; index < retained.length / STRIDE; index++) {
                retained[index * STRIDE + X] -= trimCount;
            }
            assertPyramidMatches(pyramid, retained);
            // Trimming drops the trimmed candles' volume, and only theirs.
            assert.equal(totalVolume(pyramid.getLevelData(0)), totalVolume(retained));
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
    pyramid.append(count, 100, 2000, -500, 150, 0.7, 777);
    pyramid.updateLast(count, 101, 2500, -750, 175, 0.7, 888);
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
