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
export declare class OHLCPyramid {
    private levels;
    private levelCounts;
    /**
     * Absolute index of each level's live window: the source-bar ordinal for level 0,
     * the bucket ordinal for the levels above.
     *
     * Never reset. Compaction moves the live window to the front of the buffer but does
     * not renumber anything, so this stays put for the life of the series. It is what a
     * caller subtracts from a `CANDLE_X` to get a retained-window ordinal.
     */
    private levelFirsts;
    /**
     * Array position of each level's live window.
     *
     * Distinct from `levelFirsts`, and the distinction is the whole point: `levelFirsts`
     * is a number the caller can see, `levelShift` is where the bytes happen to sit. A
     * trim advances both by the same amount, but compaction resets only this one, so
     * `levelFirst` cannot be derived from the array and must be tracked. Conflating them
     * is what would make `CANDLE_X - base` wrong immediately after a compaction.
     */
    private levelShifts;
    private sourceCandleCount;
    /**
     * Absolute count of source bars, i.e. `levelFirsts[0] + levelCounts[0]`.
     *
     * Equal to the number of bars ever appended, and unchanged by a trim — which is
     * why a level's last bucket can resolve its group's end against it and get the
     * pre-trim extent, as it must: the bucket still describes a group that began
     * before the window.
     */
    private absoluteSourceCount;
    constructor();
    get candleCount(): number;
    get levelCount(): number;
    reset(candles: Float32Array): void;
    getLevelCount(levelIndex: number): number;
    /**
     * Absolute source-bar ordinal that array position zero of `levelIndex` describes.
     *
     * A caller converting a `CANDLE_X` it read from this level into a retained-window
     * ordinal subtracts this. Zero until the first trim, which is why the common case
     * of a series that has never been trimmed needs no adjustment.
     */
    getLevelBase(levelIndex: number): number;
    /**
     * The live buckets of a level, as a **view** — no copy.
     *
     * The window is addressed by array position, not by absolute index, so it is where
     * the bytes are rather than what they are numbered. `subarray` over it is O(1) and
     * allocates nothing, so reading a level stays free however much has been trimmed.
     */
    getLevelData(levelIndex: number): Float32Array;
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
    append(open: number, high: number, low: number, close: number, width: number, volume: number): void;
    /**
     * Rewrites the most recent bar, for a candle still forming.
     *
     * Takes the same arguments as `append` and no ordinal, because it addresses the
     * last bar by position rather than naming it.
     */
    updateLast(open: number, high: number, low: number, close: number, width: number, volume: number): void;
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
    trimStart(candleCount: number): void;
    /**
     * Moves the live window to the front of each buffer, if enough has been trimmed
     * off the front to be worth the memmove.
     *
     * The absolute `levelFirsts` are deliberately untouched. They are what a caller
     * subtracts to get a retained-window ordinal, and renumbering them to match the new
     * array position would make every `CANDLE_X` wrong by the trim count.
     */
    private compactIfWasteful;
    /** Recomputes every level's bucket that contains `absoluteSourceIndex`. */
    private recomputeAncestors;
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
    private recomputeBucket;
    /**
     * Stamps a sequential ordinal into every record's x.
     *
     * The pyramid owns its ordinals, so a caller handing it a buffer of candles does
     * not have to know them — and cannot get them wrong.
     */
    private withOrdinals;
    private ensureCapacity;
    private writeCandle;
    private validateValues;
}
