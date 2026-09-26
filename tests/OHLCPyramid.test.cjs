const assert = require('node:assert/strict');
const { test } = require('node:test');
const { performance } = require('node:perf_hooks');
const { LTTBDownsampler } = require('../.test-build/math/LTTBDownsampler.js');
const { OHLCPyramid } = require('../.test-build/math/OHLCPyramid.js');

function makeCandle(index) {
    const open = 100 + Math.sin(index * 0.37) * 10;
    const close = open + ((index % 5) - 2) * 0.25;
    const high = Math.max(open, close) + ((index % 7) + 1) * 0.5;
    const low = Math.min(open, close) - ((index % 3) + 1) * 0.75;
    return [index, open, high, low, close, 0.7];
}

function makeSeries(count) {
    const candles = new Float32Array(count * 6);
    for (let index = 0; index < count; index++) {
        candles.set(makeCandle(index), index * 6);
    }
    return candles;
}

function assertPyramidMatches(pyramid, source) {
    const expected = LTTBDownsampler.buildOHLCPyramid(source);
    assert.equal(pyramid.candleCount, source.length / 6);
    assert.equal(pyramid.levelCount, expected.length);
    for (let levelIndex = 0; levelIndex < expected.length; levelIndex++) {
        const actualLevel = pyramid.getLevelData(levelIndex);
        assert.equal(pyramid.getLevelCount(levelIndex), expected[levelIndex].length / 6);
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
            const expandedSource = new Float32Array(source.length + 6);
            expandedSource.set(source);
            expandedSource.set(candle, source.length);
            pyramid.append(...candle);
            assertPyramidMatches(pyramid, expandedSource);
            source = expandedSource;
        }
    }
});

test('updating the final candle refreshes extrema through every ancestor level', () => {
    for (const count of [1, 3, 5, 9, 33, 65]) {
        const source = makeSeries(count);
        const pyramid = new OHLCPyramid();
        pyramid.reset(source);
        const replacement = [count - 1, 105, 500, -300, 104, 0.7];
        pyramid.updateLast(...replacement);
        source.set(replacement, (count - 1) * 6);
        assertPyramidMatches(pyramid, source);
    }
});

test('rejects invalid OHLC values and update on an empty pyramid', () => {
    const pyramid = new OHLCPyramid();
    assert.throws(() => pyramid.append(0, 10, 9, 8, 10, 0.7), /Invalid OHLC/);
    assert.throws(() => pyramid.updateLast(0, 10, 11, 9, 10, 0.7), /before data is set/);
});

test('front trimming rebases x indices and rebuilds every aggregate level', () => {
    for (const count of [1, 2, 3, 7, 9, 33, 65]) {
        for (let trimCount = 0; trimCount <= count; trimCount++) {
            const source = makeSeries(count);
            const pyramid = new OHLCPyramid();
            pyramid.reset(source);
            pyramid.trimStart(trimCount);

            const retained = source.slice(trimCount * 6);
            for (let index = 0; index < retained.length / 6; index++) {
                retained[index * 6] -= trimCount;
            }
            assertPyramidMatches(pyramid, retained);
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

test('one-million-candle pyramid preserves extrema and supports incremental updates', { timeout: 30000 }, (context) => {
    const count = 1_000_000;
    const source = new Float32Array(count * 6);
    let expectedHigh = Number.NEGATIVE_INFINITY;
    let expectedLow = Number.POSITIVE_INFINITY;
    for (let index = 0; index < count; index++) {
        const open = 100 + (index % 5);
        const close = open + (index % 3) - 1;
        const high = Math.max(open, close) + (index % 997);
        const low = Math.min(open, close) - (index % 503);
        source.set([index, open, high, low, close, 0.7], index * 6);
        expectedHigh = Math.max(expectedHigh, high);
        expectedLow = Math.min(expectedLow, low);
    }

    const pyramid = new OHLCPyramid();
    const buildStart = performance.now();
    pyramid.reset(source);
    const buildMilliseconds = performance.now() - buildStart;

    assert.equal(pyramid.candleCount, count);
    assert.equal(pyramid.getLevelCount(pyramid.levelCount - 1), 1);
    const root = pyramid.getLevelData(pyramid.levelCount - 1);
    assert.equal(root[1], source[1]);
    assert.equal(root[2], expectedHigh);
    assert.equal(root[3], expectedLow);
    assert.equal(root[4], source[source.length - 2]);

    const appendStart = performance.now();
    pyramid.append(count, 100, 2000, -500, 150, 0.7);
    pyramid.updateLast(count, 101, 2500, -750, 175, 0.7);
    const updateMilliseconds = performance.now() - appendStart;
    const updatedRoot = pyramid.getLevelData(pyramid.levelCount - 1);
    assert.equal(updatedRoot[2], 2500);
    assert.equal(updatedRoot[3], -750);
    assert.equal(pyramid.candleCount, count + 1);

    context.diagnostic(`1,000,000 candles: pyramid build ${buildMilliseconds.toFixed(1)} ms; append + update ${updateMilliseconds.toFixed(1)} ms`);
});
