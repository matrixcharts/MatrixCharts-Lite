import { LTTBDownsampler } from './LTTBDownsampler.js';
import {
    CANDLE_CLOSE,
    CANDLE_HIGH,
    CANDLE_LOW,
    CANDLE_OPEN,
    CANDLE_STRIDE,
    CANDLE_VOLUME,
    CANDLE_WIDTH,
    CANDLE_X,
} from './candleLayout.js';

/**
 * Fraction of a level's capacity that may be dead prefix before it is compacted away.
 *
 * Compaction is a `copyWithin` of the live region to the front of the array. Done on
 * every trim it would be O(n) per trim, which is the thing this class exists to
 * avoid. Done rarely it is O(n) every so often, which is the standard amortised
 * trade: half means a trim of a quarter of the series triggers one memmove, so the
 * cost per trimmed bar is constant no matter what the retention limit is.
 *
 * Half rather than a smaller fraction because `copyWithin` is a native memmove and
 * the alternative — a smaller threshold, so more frequent, smaller moves — trades a
 * cheap large move for an expensive small one.
 */
const COMPACT_WASTE_RATIO = 0.5;

/**
 * A multi-resolution OHLC pyramid with an O(1) amortised prefix trim.
 *
 * The pyramid is a mipmap of the candle series: level 0 is every bar, level 1 fuses
 * bars in pairs, level 2 fuses those, and so on. The draw path picks a level by pixel
 * density, so a zoomed-out chart reads a level where each bucket is at least three
 * pixels wide.
 *
 * ## Why the head offset exists
 *
 * `trimStart` used to allocate a fresh array for the retained bars, shift the tail
 * into it, subtract the trim count from every x, and then rebuild every level from
 * scratch. That is four O(n) passes and two O(n) allocations, on every append batch
 * that arrives while the series is at its retention cap — which, on a live feed, is
 * every batch. Measured at the 1,000,000-candle default: **34.9 ms**, twice the 60 Hz
 * frame budget, for a trim of 500 bars.
 *
 * None of that work is necessary. A trimmed prefix changes exactly one aggregate per
 * level: the single bucket that straddles the cut. Every other bucket's inputs are
 * untouched, so its aggregate is still correct. So a trim advances a logical start
 * per level, recomputes that one straddling bucket bottom-up, and leaves everything
 * else alone. That is O(levels) — O(log n) — with no allocation.
 *
 * ## Coordinates
 *
 * `CANDLE_X` holds an **absolute** source-bar ordinal, which only ever increases for
 * the life of the series. It is not rebased on a trim, because rebasing is the O(n)
 * pass this class avoids. A caller reading it subtracts `getLevelBase(0)` to get an
 * ordinal relative to the retained window, which is the numbering the rest of the
 * chart works in.
 *
 * The pyramid stamps x itself rather than accepting it. Two sources of truth for a
 * coordinate that every level has to agree on is how a trim ends up shifting the
 * candles by a bar.
 */
export class OHLCPyramid {
    private levels: Float32Array[] = [];
    private levelCounts: number[] = [];
    /**
     * Absolute index of each level's live window: the source-bar ordinal for level 0,
     * the bucket ordinal for the levels above.
     *
     * Never reset. Compaction moves the live window to the front of the buffer but does
     * not renumber anything, so this stays put for the life of the series. It is what a
     * caller subtracts from a `CANDLE_X` to get a retained-window ordinal.
     */
    private levelFirsts: number[] = [];
    /**
     * Array position of each level's live window.
     *
     * Distinct from `levelFirsts`, and the distinction is the whole point: `levelFirsts`
     * is a number the caller can see, `levelShift` is where the bytes happen to sit. A
     * trim advances both by the same amount, but compaction resets only this one, so
     * `levelFirst` cannot be derived from the array and must be tracked. Conflating them
     * is what would make `CANDLE_X - base` wrong immediately after a compaction.
     */
    private levelShifts: number[] = [];
    private sourceCandleCount: number = 0;
    /**
     * Absolute count of source bars, i.e. `levelFirsts[0] + levelCounts[0]`.
     *
     * Equal to the number of bars ever appended, and unchanged by a trim — which is
     * why a level's last bucket can resolve its group's end against it and get the
     * pre-trim extent, as it must: the bucket still describes a group that began
     * before the window.
     */
    private absoluteSourceCount: number = 0;

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
        if (candles.length % CANDLE_STRIDE !== 0) {
            throw new Error('MatrixCharts: OHLC input must contain interleaved x/o/h/l/c/w values.');
        }
        const stamped: Float32Array = this.withOrdinals(candles);
        this.levels = LTTBDownsampler.buildOHLCPyramid(stamped);
        this.levelCounts = this.levels.map((level: Float32Array): number => level.length / CANDLE_STRIDE);
        this.levelFirsts = this.levelCounts.map((): number => 0);
        this.levelShifts = this.levelCounts.map((): number => 0);
        this.sourceCandleCount = candles.length / CANDLE_STRIDE;
        this.absoluteSourceCount = this.sourceCandleCount;
    }

    public getLevelCount(levelIndex: number): number {
        return this.levelCounts[levelIndex] ?? 0;
    }

    /**
     * Absolute source-bar ordinal that array position zero of `levelIndex` describes.
     *
     * A caller converting a `CANDLE_X` it read from this level into a retained-window
     * ordinal subtracts this. Zero until the first trim, which is why the common case
     * of a series that has never been trimmed needs no adjustment.
     */
    public getLevelBase(levelIndex: number): number {
        return this.levelFirsts[levelIndex] ?? 0;
    }

    /**
     * The live buckets of a level, as a **view** — no copy.
     *
     * The window is addressed by array position, not by absolute index, so it is where
     * the bytes are rather than what they are numbered. `subarray` over it is O(1) and
     * allocates nothing, so reading a level stays free however much has been trimmed.
     */
    public getLevelData(levelIndex: number): Float32Array {
        const level: Float32Array | undefined = this.levels[levelIndex];
        const count: number = this.levelCounts[levelIndex] ?? 0;
        if (!level || count === 0) return new Float32Array(0);
        // From the shift, not from zero. The two are the same until the first
        // compaction; afterwards the buffer's leading entries are bars that were
        // trimmed off, and handing those back would report the wrong window as the
        // retained one — a volume total short by exactly the trimmed bars, and an
        // `append` that lands on a candle nobody can see.
        const shift: number = this.levelShifts[levelIndex] ?? 0;
        return level.subarray(shift * CANDLE_STRIDE, (shift + count) * CANDLE_STRIDE);
    }

    /**
     * Appends one bar. The ordinal is assigned here, not supplied.
     *
     * @param open   Open price.
     * @param high   High price.
     * @param low    Low price.
     * @param close  Close price.
     * @param width  Body width weight.
     * @param volume Volume, summed down the pyramid.
     */
    public append(
        open: number,
        high: number,
        low: number,
        close: number,
        width: number,
        volume: number,
    ): void {
        this.validateValues(open, high, low, close, width, volume);

        const count: number = this.levelCounts[0];
        // The requirement is a **buffer position**, not a live count. On a trimmed level
        // those differ by the shift, and asking for the count grows the buffer to
        // accommodate a write that lands past its end — a silently dropped append,
        // because a `Float32Array` write out of range is a no-op rather than a throw.
        this.ensureCapacity(0, this.levelShifts[0] + count + 1);
        // Re-read after growing: `ensureCapacity` moves the live window to the front
        // when it reallocates, which moves this write. Reading the shift before the call
        // is how an append lands three records past the end and is silently dropped.
        const position: number = this.levelShifts[0] + count;
        const absoluteIndex: number = this.levelFirsts[0] + count;
        this.writeCandle(
            this.levels[0],
            position * CANDLE_STRIDE,
            absoluteIndex,
            open, high, low, close, width, volume,
        );
        this.levelCounts[0] = count + 1;
        this.sourceCandleCount++;
        this.absoluteSourceCount = absoluteIndex + 1;
        this.recomputeAncestors(absoluteIndex);
    }

    /**
     * Rewrites the most recent bar, for a candle still forming.
     *
     * Takes the same arguments as `append` and no ordinal, because it addresses the
     * last bar by position rather than naming it.
     */
    public updateLast(
        open: number,
        high: number,
        low: number,
        close: number,
        width: number,
        volume: number,
    ): void {
        if (this.sourceCandleCount === 0) {
            throw new Error('MatrixCharts: Cannot update the last candle before data is set.');
        }
        this.validateValues(open, high, low, close, width, volume);

        const last: number = this.levelCounts[0] - 1;
        const absoluteIndex: number = this.levelFirsts[0] + last;
        this.writeCandle(
            this.levels[0],
            (this.levelShifts[0] + last) * CANDLE_STRIDE,
            absoluteIndex,
            open, high, low, close, width, volume,
        );
        this.recomputeAncestors(absoluteIndex);
    }

    /**
     * Drops `candleCount` bars from the front of the retained window.
     *
     * O(levels) plus an amortised `copyWithin`, with no allocation in the common case.
     * The one substantive piece of work is recomputing the bucket that straddles the
     * cut, once per level, bottom-up, because that is the only aggregate whose inputs
     * the trim changed.
     *
     * @param candleCount Bars to drop. Must not exceed the retained count.
     */
    public trimStart(candleCount: number): void {
        if (!Number.isInteger(candleCount) || candleCount < 0 || candleCount > this.sourceCandleCount) {
            throw new Error('MatrixCharts: Trim count must be an integer within the pyramid candle count.');
        }
        if (candleCount === 0) return;

        this.sourceCandleCount -= candleCount;

        // Level 0 has no aggregate to fix: a bar is a bar. It only needs its window
        // moved, which the first index expresses.
        this.levelFirsts[0] += candleCount;
        this.levelShifts[0] += candleCount;
        this.levelCounts[0] -= candleCount;

        // Every level's live buckets are derived from the retained window rather than
        // by subtracting the buckets that left. Subtraction leaves a level holding
        // buckets that contain no retained bar at all — which happens the moment the
        // series is trimmed to empty — and a level is then advertising buckets it can
        // never fill.
        const barFirst: number = this.levelFirsts[0];
        const barCount: number = this.levelCounts[0];
        for (let levelIndex: number = 1; levelIndex < this.levels.length; levelIndex++) {
            const size: number = Math.pow(2, levelIndex);
            const previousFirst: number = this.levelFirsts[levelIndex];
            const previousCount: number = this.levelCounts[levelIndex];
            const previousEnd: number = previousFirst + previousCount;
            const newFirst: number = Math.floor(barFirst / size);
            const newCount: number = barCount === 0
                ? 0
                : Math.floor((barFirst + barCount - 1) / size) - newFirst + 1;

            // Two cases, and the difference is the whole complexity argument.
            //
            // The new window still overlaps what the level holds: advance the shift by
            // the buckets that left, so the live window keeps pointing at the same
            // bytes, and recompute only the straddling bucket. O(1).
            //
            // It no longer overlaps — the trim is larger than this level's group size,
            // which is exactly what happens to the top few levels of a series trimmed in
            // bulk. Then the level holds nothing worth keeping, and it is rebuilt from
            // the level below, which was already handled. That costs O(newCount), and a
            // level only needs it when the trim exceeds its group size, so summing over
            // the levels that do gives O(trim size) — the size of the trim, not the size
            // of the series. Which is the property the whole head offset is for.
            // The invariant every index here obeys: the array position of absolute bucket
            // `b` is `shift + (b - first)`. So advancing `first` by `d` and holding the
            // bytes still means advancing `shift` by the same `d` — the window's start
            // moves forward through the buffer, it does not move back.
            const overlaps: boolean = newFirst < previousEnd && newCount > 0;
            if (overlaps) {
                this.levelShifts[levelIndex] += newFirst - previousFirst;
            } else {
                this.levelShifts[levelIndex] = 0;
            }
            this.levelFirsts[levelIndex] = newFirst;
            this.levelCounts[levelIndex] = newCount;

            if (newCount === 0) continue;
            if (overlaps) {
                this.recomputeBucket(levelIndex, newFirst);
                continue;
            }
            this.ensureCapacity(levelIndex, newCount);
            for (let bucket: number = newFirst; bucket < newFirst + newCount; bucket++) {
                this.recomputeBucket(levelIndex, bucket);
            }
        }

        // Levels that a trim emptied are dropped rather than left advertised at zero.
        // A caller looping over `levelCount` — the draw path does, when it picks a level
        // by pixel density — would otherwise iterate levels that can only ever return
        // an empty buffer, and `levelCount` would stop describing a pyramid that could
        // be rebuilt from what is left. Level 0 always stays, even when empty: a
        // pyramid with no level 0 has nothing to append into.
        while (this.levels.length > 1 && this.levelCounts[this.levels.length - 1] === 0) {
            this.levels.pop();
            this.levelCounts.pop();
            this.levelFirsts.pop();
            this.levelShifts.pop();
        }

        this.compactIfWasteful();
    }

    /**
     * Moves the live window to the front of each buffer, if enough has been trimmed
     * off the front to be worth the memmove.
     *
     * The absolute `levelFirsts` are deliberately untouched. They are what a caller
     * subtracts to get a retained-window ordinal, and renumbering them to match the new
     * array position would make every `CANDLE_X` wrong by the trim count.
     */
    private compactIfWasteful(): void {
        for (let levelIndex: number = 0; levelIndex < this.levels.length; levelIndex++) {
            const shift: number = this.levelShifts[levelIndex];
            const count: number = this.levelCounts[levelIndex];
            if (shift === 0) continue;
            // Dead prefix against live extent, so a level holding two live buckets and
            // a million trimmed ones still compacts, and one that is mostly live does
            // not thrash.
            if (shift <= count * COMPACT_WASTE_RATIO) continue;
            this.levels[levelIndex].copyWithin(
                0,
                shift * CANDLE_STRIDE,
                (shift + count) * CANDLE_STRIDE,
            );
            this.levelShifts[levelIndex] = 0;
        }
    }

    /** Recomputes every level's bucket that contains `absoluteSourceIndex`. */
    private recomputeAncestors(absoluteSourceIndex: number): void {
        // One bar is not two bars. A fresh build of a one-candle series has a single
        // level, and appending to one must not conjure a second: `levelCount` is
        // asserted against a rebuild, and the draw path picks a level by pixel
        // density, so a phantom level would be a real difference in what is drawn.
        if (this.sourceCandleCount <= 1) return;

        let childIndex: number = absoluteSourceIndex;
        let levelIndex: number = 1;

        // Bounded by the levels rather than by the log of the count: a level can
        // already exist from an earlier, longer series, and the walk has to reach
        // whichever of them hold the appended bar.
        while (true) {
            const childCount: number = this.levelCounts[levelIndex - 1];
            const parentCount: number = Math.ceil(childCount / 2);
            const absoluteBucket: number = Math.floor(childIndex / 2);
            // Materialise the level before reading its window. A level that did not
            // exist a moment ago has no `levelFirsts` entry, and reading one as
            // `undefined` makes every arithmetic step NaN — which then sizes a
            // `Float32Array` to length zero and leaves the level permanently empty
            // while the pyramid reports that it has it.
            this.ensureCapacity(levelIndex, 0);
            const offset: number = absoluteBucket - this.levelFirsts[levelIndex];
            // A bucket before this level's live window was trimmed away. Appending at
            // the tail cannot reach one, so this is a guard on the invariant rather
            // than a branch that runs.
            if (offset < 0) return;
            // A buffer position, for the same reason as in `append`: on a shifted level
            // it is the position, not the offset within the window, that has to fit.
            this.ensureCapacity(levelIndex, this.levelShifts[levelIndex] + offset + 1);
            if (offset >= this.levelCounts[levelIndex]) {
                this.levelCounts[levelIndex] = offset + 1;
            }
            this.recomputeBucket(levelIndex, absoluteBucket);
            if (parentCount <= 1) return;
            childIndex = absoluteBucket;
            levelIndex++;
        }
    }

    /**
     * Writes one bucket at `levelIndex` from its two children.
     *
     * `absoluteBucket` is the bucket's index in the whole series, not its position in
     * the level's buffer — the difference is what makes a trim O(1) instead of a
     * rewrite, since the buffer position is derived rather than stored per bucket.
     *
     * The child positions are clamped rather than assumed. After a trim that lands
     * mid-bucket, the straddling bucket's first child is already gone, and the only
     * live child is the second. Clamping the first down to the window start yields
     * exactly that child, and pairing it with itself stops the width and volume sums
     * double-counting it.
     */
    private recomputeBucket(levelIndex: number, absoluteBucket: number): void {
        const position: number = absoluteBucket - this.levelFirsts[levelIndex];
        if (position < 0) return;

        const childCount: number = this.levelCounts[levelIndex - 1];
        if (childCount === 0) return;

        const children: Float32Array = this.levels[levelIndex - 1];
        const childFirst: number = this.levelFirsts[levelIndex - 1];
        const childShift: number = this.levelShifts[levelIndex - 1];

        let firstChild: number = absoluteBucket * 2 - childFirst;
        let secondChild: number = firstChild + 1;
        if (firstChild < 0) {
            // The cut fell inside this bucket: only the second child survives.
            firstChild = 0;
            secondChild = 0;
        } else if (firstChild >= childCount) {
            firstChild = childCount - 1;
            secondChild = firstChild;
        } else if (secondChild >= childCount) {
            secondChild = childCount - 1;
        }
        const paired: boolean = secondChild !== firstChild;

        const firstOffset: number = (childShift + firstChild) * CANDLE_STRIDE;
        const secondOffset: number = (childShift + secondChild) * CANDLE_STRIDE;
        const outputOffset: number = (this.levelShifts[levelIndex] + position) * CANDLE_STRIDE;
        const groupSize: number = Math.pow(2, levelIndex);
        const firstSourceIndex: number = absoluteBucket * groupSize;
        const lastSourceIndex: number = Math.min(
            firstSourceIndex + groupSize,
            this.absoluteSourceCount,
        ) - 1;

        // A bucket fuses two children: the group's open and close come from the
        // outer edges, high and low are the extremes, and width and volume
        // accumulate. An odd tail can pair a candle with itself, which neither sum may
        // double-count.
        this.writeCandle(
            this.levels[levelIndex],
            outputOffset,
            (firstSourceIndex + lastSourceIndex) / 2,
            children[firstOffset + CANDLE_OPEN],
            Math.max(children[firstOffset + CANDLE_HIGH], children[secondOffset + CANDLE_HIGH]),
            Math.min(children[firstOffset + CANDLE_LOW], children[secondOffset + CANDLE_LOW]),
            children[secondOffset + CANDLE_CLOSE],
            children[firstOffset + CANDLE_WIDTH]
                + (paired ? children[secondOffset + CANDLE_WIDTH] : 0),
            children[firstOffset + CANDLE_VOLUME]
                + (paired ? children[secondOffset + CANDLE_VOLUME] : 0),
        );
    }

    /**
     * Stamps a sequential ordinal into every record's x.
     *
     * The pyramid owns its ordinals, so a caller handing it a buffer of candles does
     * not have to know them — and cannot get them wrong.
     */
    private withOrdinals(candles: Float32Array): Float32Array {
        const out: Float32Array = new Float32Array(candles);
        for (let offset: number = 0; offset < out.length; offset += CANDLE_STRIDE) {
            out[offset + CANDLE_X] = offset / CANDLE_STRIDE;
        }
        return out;
    }

    private ensureCapacity(levelIndex: number, requiredCount: number): void {
        while (this.levels.length <= levelIndex) {
            this.levels.push(new Float32Array(0));
            this.levelCounts.push(0);
            // A level created above a trimmed one starts where its first child does,
            // which is half the child's first index. Inheriting the child's index
            // instead would place the new level's first bucket a whole group too late,
            // and every aggregate written into it would be one group out of step.
            const childFirst: number = this.levelFirsts[this.levelFirsts.length - 1] ?? 0;
            this.levelFirsts.push(Math.floor(childFirst / 2));
            this.levelShifts.push(0);
        }

        const current: Float32Array = this.levels[levelIndex];
        const currentCapacity: number = current.length / CANDLE_STRIDE;
        if (currentCapacity >= requiredCount) return;

        const nextCapacity: number = Math.max(requiredCount, Math.max(16, currentCapacity * 2));
        const expanded: Float32Array = new Float32Array(nextCapacity * CANDLE_STRIDE);
        // Only the live window is carried over, and it lands at the front. Copying the
        // whole buffer would drag a dead prefix along and re-inflate the level on every
        // doubling; keeping the shift would carry the dead prefix forward instead.
        const shift: number = this.levelShifts[levelIndex];
        const count: number = this.levelCounts[levelIndex];
        if (count > 0) {
            expanded.set(current.subarray(shift * CANDLE_STRIDE, (shift + count) * CANDLE_STRIDE));
        }
        this.levels[levelIndex] = expanded;
        this.levelShifts[levelIndex] = 0;
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
        volume: number,
    ): void {
        target[offset + CANDLE_X] = x;
        target[offset + CANDLE_OPEN] = open;
        target[offset + CANDLE_HIGH] = high;
        target[offset + CANDLE_LOW] = low;
        target[offset + CANDLE_CLOSE] = close;
        target[offset + CANDLE_WIDTH] = width;
        target[offset + CANDLE_VOLUME] = volume;
    }

    private validateValues(
        open: number,
        high: number,
        low: number,
        close: number,
        width: number,
        volume: number,
    ): void {
        if (
            ![open, high, low, close, width, volume].every(Number.isFinite) ||
            width <= 0 ||
            volume < 0 ||
            high < Math.max(open, close) ||
            low > Math.min(open, close) ||
            high < low
        ) {
            throw new Error('MatrixCharts: Invalid OHLC candle values.');
        }
    }
}
