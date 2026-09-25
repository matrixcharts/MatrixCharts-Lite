/** Reduces an interleaved [x, y, x, y, ...] series with Largest-Triangle-Three-Buckets. */
export class LTTBDownsampler {
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
}