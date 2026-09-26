const { performance } = require('node:perf_hooks');
const { OHLCPyramid } = require('../.test-build/math/OHLCPyramid.js');

const initialCount = Number(process.argv[2] ?? 100_000);
const appendedCount = Number(process.argv[3] ?? 100_000);
const batchSize = Number(process.argv[4] ?? 1_000);
const retainedLimit = Number(process.argv[5] ?? initialCount);
if (![initialCount, appendedCount, batchSize, retainedLimit].every(Number.isSafeInteger) || initialCount < 1 || appendedCount < 1 || batchSize < 1 || retainedLimit < 1) {
    throw new Error('Usage: node benchmarks/sustained-feed.cjs [initialCount] [appendedCount] [batchSize] [retainedLimit]');
}

function candleValues(index) {
    const open = 100 + Math.sin(index * 0.013) * 8;
    const close = open + Math.sin(index * 0.11) * 1.25;
    return [index, open, Math.max(open, close) + (index % 9) * 0.1, Math.min(open, close) - (index % 7) * 0.1, close, 0.7];
}

const source = new Float32Array(initialCount * 6);
for (let index = 0; index < initialCount; index++) source.set(candleValues(index), index * 6);
const pyramid = new OHLCPyramid();
const buildStart = performance.now();
pyramid.reset(source);
const buildMilliseconds = performance.now() - buildStart;

const batchDurations = [];
const streamStart = performance.now();
for (let batchStart = 0; batchStart < appendedCount; batchStart += batchSize) {
    const currentBatchCount = Math.min(batchSize, appendedCount - batchStart);
    const batchStartTime = performance.now();
    for (let offset = 0; offset < currentBatchCount; offset++) {
        const index = initialCount + batchStart + offset;
        const values = candleValues(index);
        pyramid.append(...values);
        pyramid.updateLast(...values);
    }
    const overflow = Math.max(0, pyramid.candleCount - retainedLimit);
    if (overflow > 0) pyramid.trimStart(overflow);
    batchDurations.push(performance.now() - batchStartTime);
}
const streamMilliseconds = performance.now() - streamStart;
batchDurations.sort((left, right) => left - right);
const percentile95 = batchDurations[Math.min(batchDurations.length - 1, Math.floor(batchDurations.length * 0.95))];
const memory = process.memoryUsage();
const output = {
    initialCandles: initialCount,
    appendedCandles: appendedCount,
    finalCandles: pyramid.candleCount,
    retainedLimit,
    pyramidLevels: pyramid.levelCount,
    initialBuildMs: Number(buildMilliseconds.toFixed(2)),
    streamMs: Number(streamMilliseconds.toFixed(2)),
    candlesPerSecond: Math.round(appendedCount / (streamMilliseconds / 1000)),
    operationsPerSecond: Math.round((appendedCount * 2) / (streamMilliseconds / 1000)),
    batchSize,
    batchP95Ms: Number(percentile95.toFixed(2)),
    rssMiB: Number((memory.rss / 1024 / 1024).toFixed(1)),
    heapUsedMiB: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
    arrayBuffersMiB: Number((memory.arrayBuffers / 1024 / 1024).toFixed(1)),
};
console.log(JSON.stringify(output, null, 2));
