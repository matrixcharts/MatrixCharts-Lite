/** Reduces an interleaved [x, y, x, y, ...] series with Largest-Triangle-Three-Buckets. */
export class LTTBDownsampler {
    /** Builds progressively coarser OHLC levels while preserving each bucket's extrema. */
    public static buildOHLCPyramid(candles: Float32Array): Float32Array[] {
        if (candles.length % 6 !== 0) {
            throw new Error('MatrixCharts: OHLC input must contain interleaved x/o/h/l/c/w values.');
        }

        const levels: Float32Array[] = [new Float32Array(candles)];
        let previous: Float32Array = levels[0];
        let previousCount: number = previous.length / 6;
        let groupSize: number = 2;
        const sourceCount: number = previousCount;

        while (previousCount > 1) {
            const currentCount: number = Math.ceil(previousCount / 2);
            const current: Float32Array = new Float32Array(currentCount * 6);
            const previousGroupSize: number = groupSize / 2;
            for (let bucket: number = 0; bucket < currentCount; bucket++) {
                const firstIndex: number = bucket * 2;
                const secondIndex: number = Math.min(firstIndex + 1, previousCount - 1);
                const firstOffset: number = firstIndex * 6;
                const secondOffset: number = secondIndex * 6;
                const outputOffset: number = bucket * 6;

                const firstSourceIndex: number = firstIndex * previousGroupSize;
                const lastSourceIndex: number = Math.min(
                    (secondIndex + 1) * previousGroupSize,
                    sourceCount,
                ) - 1;
                const groupedSourceCount: number = lastSourceIndex - firstSourceIndex + 1;
                current[outputOffset] = (firstSourceIndex + lastSourceIndex) / 2;
                current[outputOffset + 1] = previous[firstOffset + 1];
                current[outputOffset + 2] = Math.max(previous[firstOffset + 2], previous[secondOffset + 2]);
                current[outputOffset + 3] = Math.min(previous[firstOffset + 3], previous[secondOffset + 3]);
                current[outputOffset + 4] = previous[secondOffset + 4];
                current[outputOffset + 5] = groupedSourceCount * candles[5];
            }
            levels.push(current);
            previous = current;
            previousCount = currentCount;
            groupSize *= 2;
        }

        return levels;
    }

    public static downsample(points: Float32Array, targetPointCount: number): Float32Array {
        if (points.length % 2 !== 0) {
            throw new Error('MatrixCharts: LTTB input must contain interleaved x/y pairs.');
        }
        if (!Number.isInteger(targetPointCount) || targetPointCount < 2) {
            throw new Error('MatrixCharts: LTTB targetPointCount must be an integer greater than 1.');
        }

        const pointCount: number = points.length / 2;
        if (pointCount <= targetPointCount) {
            return new Float32Array(points);
        }

        const sampled: Float32Array = new Float32Array(targetPointCount * 2);
        let sampledIndex: number = 0;
        let selectedPointIndex: number = 0;

        sampled[sampledIndex++] = points[0];
        sampled[sampledIndex++] = points[1];

        const every: number = (pointCount - 2) / (targetPointCount - 2);

        for (let bucketIndex: number = 0; bucketIndex < targetPointCount - 2; bucketIndex++) {
            const nextBucketStart: number = Math.floor((bucketIndex + 1) * every) + 1;
            const nextBucketEnd: number = Math.min(
                Math.floor((bucketIndex + 2) * every) + 1,
                pointCount,
            );

            let averageX: number = 0;
            let averageY: number = 0;
            const averagePointCount: number = nextBucketEnd - nextBucketStart;
            if (averagePointCount > 0) {
                for (let pointIndex: number = nextBucketStart; pointIndex < nextBucketEnd; pointIndex++) {
                    averageX += points[pointIndex * 2];
                    averageY += points[pointIndex * 2 + 1];
                }
                averageX /= averagePointCount;
                averageY /= averagePointCount;
            } else {
                averageX = points[(pointCount - 1) * 2];
                averageY = points[(pointCount - 1) * 2 + 1];
            }

            const currentBucketStart: number = Math.floor(bucketIndex * every) + 1;
            const currentBucketEnd: number = Math.min(
                Math.floor((bucketIndex + 1) * every) + 1,
                pointCount - 1,
            );
            const previousX: number = points[selectedPointIndex * 2];
            const previousY: number = points[selectedPointIndex * 2 + 1];

            let maximumArea: number = -1;
            let selectedBucketPointIndex: number = currentBucketStart;
            for (let pointIndex: number = currentBucketStart; pointIndex < currentBucketEnd; pointIndex++) {
                const pointX: number = points[pointIndex * 2];
                const pointY: number = points[pointIndex * 2 + 1];
                const area: number = Math.abs(
                    (previousX - averageX) * (pointY - previousY) -
                    (previousX - pointX) * (averageY - previousY),
                );

                if (area > maximumArea) {
                    maximumArea = area;
                    selectedBucketPointIndex = pointIndex;
                }
            }

            selectedPointIndex = selectedBucketPointIndex;
            sampled[sampledIndex++] = points[selectedPointIndex * 2];
            sampled[sampledIndex++] = points[selectedPointIndex * 2 + 1];
        }

        const lastPointIndex: number = pointCount - 1;
        sampled[sampledIndex++] = points[lastPointIndex * 2];
        sampled[sampledIndex] = points[lastPointIndex * 2 + 1];

        return sampled;
    }

    /** 
     * Aggregates an interleaved [x, open, high, low, close, width] series.
     * Unlike LTTB (which drops points), this fuses buckets into larger timeframe candles
     * to perfectly preserve all extreme highs and lows.
     */
    public static downsampleOHLC(candles: Float32Array, targetCandleCount: number): Float32Array {
        if (candles.length % 6 !== 0) {
            throw new Error('MatrixCharts: OHLC input must contain interleaved x/o/h/l/c/w values.');
        }

        const candleCount: number = candles.length / 6;
        if (candleCount <= targetCandleCount) {
            return new Float32Array(candles);
        }

        const sampled: Float32Array = new Float32Array(targetCandleCount * 6);
        const bucketSize: number = candleCount / targetCandleCount;

        for (let i = 0; i < targetCandleCount; i++) {
            const startIndex: number = Math.floor(i * bucketSize);
            const endIndex: number = Math.min(Math.floor((i + 1) * bucketSize) - 1, candleCount - 1);

            let maxHigh: number = Number.NEGATIVE_INFINITY;
            let minLow: number = Number.POSITIVE_INFINITY;

            for (let j = startIndex; j <= endIndex; j++) {
                const high = candles[j * 6 + 2];
                const low = candles[j * 6 + 3];
                if (high > maxHigh) maxHigh = high;
                if (low < minLow) minLow = low;
            }

            const outIndex: number = i * 6;
            const startInputIndex: number = startIndex * 6;
            const endInputIndex: number = endIndex * 6;

            sampled[outIndex] = candles[startInputIndex];
            sampled[outIndex + 1] = candles[startInputIndex + 1];
            sampled[outIndex + 2] = maxHigh;
            sampled[outIndex + 3] = minLow;
            sampled[outIndex + 4] = candles[endInputIndex + 4];
            sampled[outIndex + 5] = candles[startInputIndex + 5] * (endIndex - startIndex + 1); 
        }

        return sampled;
    }
}