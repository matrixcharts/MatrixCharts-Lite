import { LTTBDownsampler } from './LTTBDownsampler';

export class OHLCPyramid {
    private levels: Float32Array[] = [];
    private levelCounts: number[] = [];
    private sourceCandleCount: number = 0;

    constructor() {
        this.reset(new Float32Array(0));
    }

    public get candleCount(): number {
        return this.sourceCandleCount;
    }

    public get levelCount(): number {
        return this.levels.length;
    }

    public reset(candles: Float32Array): void {
        this.levels = LTTBDownsampler.buildOHLCPyramid(candles);
        this.levelCounts = this.levels.map((level: Float32Array): number => level.length / 6);
        this.sourceCandleCount = candles.length / 6;
    }

    public getLevelCount(levelIndex: number): number {
        return this.levelCounts[levelIndex] ?? 0;
    }

    public getLevelData(levelIndex: number): Float32Array {
        const level: Float32Array | undefined = this.levels[levelIndex];
        if (!level) return new Float32Array(0);
        return level.subarray(0, this.levelCounts[levelIndex] * 6);
    }

    public append(
        x: number,
        open: number,
        high: number,
        low: number,
        close: number,
        width: number,
    ): void {
        this.validateValues(x, open, high, low, close, width);

        const newIndex: number = this.sourceCandleCount;
        this.ensureCapacity(0, newIndex + 1);
        this.writeCandle(this.levels[0], newIndex * 6, x, open, high, low, close, width);
        this.sourceCandleCount++;
        this.levelCounts[0] = this.sourceCandleCount;
        this.recomputeAncestors(newIndex);
    }

    public updateLast(
        x: number,
        open: number,
        high: number,
        low: number,
        close: number,
        width: number,
    ): void {
        if (this.sourceCandleCount === 0) {
            throw new Error('MatrixCharts: Cannot update the last candle before data is set.');
        }
        this.validateValues(x, open, high, low, close, width);

        const lastIndex: number = this.sourceCandleCount - 1;
        this.writeCandle(this.levels[0], lastIndex * 6, x, open, high, low, close, width);
        this.recomputeAncestors(lastIndex);
    }

    public trimStart(candleCount: number): void {
        if (!Number.isInteger(candleCount) || candleCount < 0 || candleCount > this.sourceCandleCount) {
            throw new Error('MatrixCharts: Trim count must be an integer within the pyramid candle count.');
        }
        if (candleCount === 0) return;

        const retainedCount: number = this.sourceCandleCount - candleCount;
        const retained: Float32Array = new Float32Array(retainedCount * 6);
        if (retainedCount > 0) {
            retained.set(this.levels[0].subarray(candleCount * 6, this.sourceCandleCount * 6));
            for (let index: number = 0; index < retainedCount; index++) {
                retained[index * 6] -= candleCount;
            }
        }
        this.reset(retained);
    }

    private recomputeAncestors(sourceIndex: number): void {
        if (this.sourceCandleCount <= 1) return;

        let childIndex: number = sourceIndex;
        let levelIndex: number = 1;

        while (true) {
            const childCount: number = this.levelCounts[levelIndex - 1];
            const parentIndex: number = Math.floor(childIndex / 2);
            const parentCount: number = Math.ceil(childCount / 2);
            this.ensureCapacity(levelIndex, parentCount);
            this.levelCounts[levelIndex] = parentCount;
            this.recomputeBucket(levelIndex, parentIndex);

            if (parentCount <= 1) return;
            childIndex = parentIndex;
            levelIndex++;
        }
    }

    private recomputeBucket(levelIndex: number, bucketIndex: number): void {
        const children: Float32Array = this.levels[levelIndex - 1];
        const childCount: number = this.levelCounts[levelIndex - 1];
        const firstChildIndex: number = bucketIndex * 2;
        const secondChildIndex: number = Math.min(firstChildIndex + 1, childCount - 1);
        const firstOffset: number = firstChildIndex * 6;
        const secondOffset: number = secondChildIndex * 6;
        const outputOffset: number = bucketIndex * 6;
        const groupSize: number = Math.pow(2, levelIndex);
        const firstSourceIndex: number = bucketIndex * groupSize;
        const lastSourceIndex: number = Math.min(
            firstSourceIndex + groupSize,
            this.sourceCandleCount,
        ) - 1;

        this.writeCandle(
            this.levels[levelIndex],
            outputOffset,
            (firstSourceIndex + lastSourceIndex) / 2,
            children[firstOffset + 1],
            Math.max(children[firstOffset + 2], children[secondOffset + 2]),
            Math.min(children[firstOffset + 3], children[secondOffset + 3]),
            children[secondOffset + 4],
            children[firstOffset + 5] + (secondChildIndex === firstChildIndex ? 0 : children[secondOffset + 5]),
        );
    }

    private ensureCapacity(levelIndex: number, requiredCount: number): void {
        while (this.levels.length <= levelIndex) {
            this.levels.push(new Float32Array(0));
            this.levelCounts.push(0);
        }

        const current: Float32Array = this.levels[levelIndex];
        const currentCapacity: number = current.length / 6;
        if (currentCapacity >= requiredCount) return;

        const nextCapacity: number = Math.max(requiredCount, Math.max(16, currentCapacity * 2));
        const expanded: Float32Array = new Float32Array(nextCapacity * 6);
        expanded.set(current);
        this.levels[levelIndex] = expanded;
    }

    private writeCandle(
        target: Float32Array,
        offset: number,
        x: number,
        open: number,
        high: number,
        low: number,
        close: number,
        width: number,
    ): void {
        target[offset] = x;
        target[offset + 1] = open;
        target[offset + 2] = high;
        target[offset + 3] = low;
        target[offset + 4] = close;
        target[offset + 5] = width;
    }

    private validateValues(
        x: number,
        open: number,
        high: number,
        low: number,
        close: number,
        width: number,
    ): void {
        if (
            ![x, open, high, low, close, width].every(Number.isFinite) ||
            width <= 0 ||
            high < Math.max(open, close) ||
            low > Math.min(open, close) ||
            high < low
        ) {
            throw new Error('MatrixCharts: Invalid OHLC candle values.');
        }
    }
}
