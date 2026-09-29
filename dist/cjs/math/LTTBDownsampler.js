"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LTTBDownsampler = void 0;
const candleLayout_js_1 = require("./candleLayout.js");
/** Reduces an interleaved [x, y, x, y, ...] series with Largest-Triangle-Three-Buckets. */
class LTTBDownsampler {
    /** Builds progressively coarser OHLC levels while preserving each bucket's extrema. */
    static buildOHLCPyramid(candles) {
        if (candles.length % candleLayout_js_1.CANDLE_STRIDE !== 0) {
            throw new Error('MatrixCharts: OHLC input must contain interleaved x/o/h/l/c/w values.');
        }
        const levels = [new Float32Array(candles)];
        let previous = levels[0];
        let previousCount = previous.length / candleLayout_js_1.CANDLE_STRIDE;
        let groupSize = 2;
        const sourceCount = previousCount;
        while (previousCount > 1) {
            const currentCount = Math.ceil(previousCount / 2);
            const current = new Float32Array(currentCount * candleLayout_js_1.CANDLE_STRIDE);
            const previousGroupSize = groupSize / 2;
            for (let bucket = 0; bucket < currentCount; bucket++) {
                const firstIndex = bucket * 2;
                const secondIndex = Math.min(firstIndex + 1, previousCount - 1);
                const firstOffset = firstIndex * candleLayout_js_1.CANDLE_STRIDE;
                const secondOffset = secondIndex * candleLayout_js_1.CANDLE_STRIDE;
                const outputOffset = bucket * candleLayout_js_1.CANDLE_STRIDE;
                const firstSourceIndex = firstIndex * previousGroupSize;
                const lastSourceIndex = Math.min((secondIndex + 1) * previousGroupSize, sourceCount) - 1;
                current[outputOffset + candleLayout_js_1.CANDLE_X] = (firstSourceIndex + lastSourceIndex) / 2;
                current[outputOffset + candleLayout_js_1.CANDLE_OPEN] = previous[firstOffset + candleLayout_js_1.CANDLE_OPEN];
                current[outputOffset + candleLayout_js_1.CANDLE_HIGH] = Math.max(previous[firstOffset + candleLayout_js_1.CANDLE_HIGH], previous[secondOffset + candleLayout_js_1.CANDLE_HIGH]);
                current[outputOffset + candleLayout_js_1.CANDLE_LOW] = Math.min(previous[firstOffset + candleLayout_js_1.CANDLE_LOW], previous[secondOffset + candleLayout_js_1.CANDLE_LOW]);
                current[outputOffset + candleLayout_js_1.CANDLE_CLOSE] = previous[secondOffset + candleLayout_js_1.CANDLE_CLOSE];
                current[outputOffset + candleLayout_js_1.CANDLE_WIDTH] = previous[firstOffset + candleLayout_js_1.CANDLE_WIDTH] +
                    (secondIndex === firstIndex ? 0 : previous[secondOffset + candleLayout_js_1.CANDLE_WIDTH]);
                // Volume accumulates like width: a coarser bar covers more trades,
                // so summing is what keeps the total across every level equal to the
                // total at full resolution.
                current[outputOffset + candleLayout_js_1.CANDLE_VOLUME] = previous[firstOffset + candleLayout_js_1.CANDLE_VOLUME] +
                    (secondIndex === firstIndex ? 0 : previous[secondOffset + candleLayout_js_1.CANDLE_VOLUME]);
            }
            levels.push(current);
            previous = current;
            previousCount = currentCount;
            groupSize *= 2;
        }
        return levels;
    }
    static downsample(points, targetPointCount) {
        if (points.length % 2 !== 0) {
            throw new Error('MatrixCharts: LTTB input must contain interleaved x/y pairs.');
        }
        if (!Number.isInteger(targetPointCount) || targetPointCount < 2) {
            throw new Error('MatrixCharts: LTTB targetPointCount must be an integer greater than 1.');
        }
        const pointCount = points.length / 2;
        if (pointCount <= targetPointCount) {
            return new Float32Array(points);
        }
        const sampled = new Float32Array(targetPointCount * 2);
        let sampledIndex = 0;
        let selectedPointIndex = 0;
        sampled[sampledIndex++] = points[0];
        sampled[sampledIndex++] = points[1];
        const every = (pointCount - 2) / (targetPointCount - 2);
        for (let bucketIndex = 0; bucketIndex < targetPointCount - 2; bucketIndex++) {
            const nextBucketStart = Math.floor((bucketIndex + 1) * every) + 1;
            const nextBucketEnd = Math.min(Math.floor((bucketIndex + 2) * every) + 1, pointCount);
            let averageX = 0;
            let averageY = 0;
            const averagePointCount = nextBucketEnd - nextBucketStart;
            if (averagePointCount > 0) {
                for (let pointIndex = nextBucketStart; pointIndex < nextBucketEnd; pointIndex++) {
                    averageX += points[pointIndex * 2];
                    averageY += points[pointIndex * 2 + 1];
                }
                averageX /= averagePointCount;
                averageY /= averagePointCount;
            }
            else {
                averageX = points[(pointCount - 1) * 2];
                averageY = points[(pointCount - 1) * 2 + 1];
            }
            const currentBucketStart = Math.floor(bucketIndex * every) + 1;
            const currentBucketEnd = Math.min(Math.floor((bucketIndex + 1) * every) + 1, pointCount - 1);
            const previousX = points[selectedPointIndex * 2];
            const previousY = points[selectedPointIndex * 2 + 1];
            let maximumArea = -1;
            let selectedBucketPointIndex = currentBucketStart;
            for (let pointIndex = currentBucketStart; pointIndex < currentBucketEnd; pointIndex++) {
                const pointX = points[pointIndex * 2];
                const pointY = points[pointIndex * 2 + 1];
                const area = Math.abs((previousX - averageX) * (pointY - previousY) -
                    (previousX - pointX) * (averageY - previousY));
                if (area > maximumArea) {
                    maximumArea = area;
                    selectedBucketPointIndex = pointIndex;
                }
            }
            selectedPointIndex = selectedBucketPointIndex;
            sampled[sampledIndex++] = points[selectedPointIndex * 2];
            sampled[sampledIndex++] = points[selectedPointIndex * 2 + 1];
        }
        const lastPointIndex = pointCount - 1;
        sampled[sampledIndex++] = points[lastPointIndex * 2];
        sampled[sampledIndex] = points[lastPointIndex * 2 + 1];
        return sampled;
    }
    /**
     * Aggregates an interleaved [x, open, high, low, close, width, volume]
     * series to a target candle count. Unlike LTTB (which drops points), this
     * fuses buckets into larger timeframe candles to perfectly preserve all
     * extreme highs and lows.
     *
     * Unused by any production path. The pyramid's own multi-resolution levels
     * serve every zoom, so this single-target variant has no caller; it is kept
     * only if a future caller needs an arbitrary candle count rather than a
     * power-of-two level.
     */
    static downsampleOHLC(candles, targetCandleCount) {
        if (candles.length % candleLayout_js_1.CANDLE_STRIDE !== 0) {
            throw new Error('MatrixCharts: OHLC input must contain interleaved x/o/h/l/c/w values.');
        }
        const candleCount = candles.length / candleLayout_js_1.CANDLE_STRIDE;
        if (candleCount <= targetCandleCount) {
            return new Float32Array(candles);
        }
        const sampled = new Float32Array(targetCandleCount * candleLayout_js_1.CANDLE_STRIDE);
        const bucketSize = candleCount / targetCandleCount;
        for (let i = 0; i < targetCandleCount; i++) {
            const startIndex = Math.floor(i * bucketSize);
            const endIndex = Math.min(Math.floor((i + 1) * bucketSize) - 1, candleCount - 1);
            let maxHigh = Number.NEGATIVE_INFINITY;
            let minLow = Number.POSITIVE_INFINITY;
            for (let j = startIndex; j <= endIndex; j++) {
                const high = candles[j * candleLayout_js_1.CANDLE_STRIDE + candleLayout_js_1.CANDLE_HIGH];
                const low = candles[j * candleLayout_js_1.CANDLE_STRIDE + candleLayout_js_1.CANDLE_LOW];
                if (high > maxHigh)
                    maxHigh = high;
                if (low < minLow)
                    minLow = low;
            }
            const outIndex = i * candleLayout_js_1.CANDLE_STRIDE;
            const startInputIndex = startIndex * candleLayout_js_1.CANDLE_STRIDE;
            const endInputIndex = endIndex * candleLayout_js_1.CANDLE_STRIDE;
            sampled[outIndex + candleLayout_js_1.CANDLE_X] = candles[startInputIndex + candleLayout_js_1.CANDLE_X];
            sampled[outIndex + candleLayout_js_1.CANDLE_OPEN] = candles[startInputIndex + candleLayout_js_1.CANDLE_OPEN];
            sampled[outIndex + candleLayout_js_1.CANDLE_HIGH] = maxHigh;
            sampled[outIndex + candleLayout_js_1.CANDLE_LOW] = minLow;
            sampled[outIndex + candleLayout_js_1.CANDLE_CLOSE] = candles[endInputIndex + candleLayout_js_1.CANDLE_CLOSE];
            sampled[outIndex + candleLayout_js_1.CANDLE_WIDTH] = candles[startInputIndex + candleLayout_js_1.CANDLE_WIDTH]
                * (endIndex - startIndex + 1);
            let bucketVolume = 0;
            for (let j = startIndex; j <= endIndex; j++) {
                bucketVolume += candles[j * candleLayout_js_1.CANDLE_STRIDE + candleLayout_js_1.CANDLE_VOLUME];
            }
            sampled[outIndex + candleLayout_js_1.CANDLE_VOLUME] = bucketVolume;
        }
        return sampled;
    }
}
exports.LTTBDownsampler = LTTBDownsampler;
