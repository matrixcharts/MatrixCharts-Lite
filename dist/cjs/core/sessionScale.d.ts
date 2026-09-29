/** A gap in the data, between one bar and the next. */
export interface SessionBreak {
    /** Ordinal of the bar *after* the break. */
    index: number;
    /** Milliseconds between the two bars. */
    gapMs: number;
    /** The break's size in slot units, after capping. */
    slots: number;
}
export interface SessionBreakOptions {
    /**
     * Minimum gap, in milliseconds, that counts as a break. Absent means derived
     * from the data: a multiple of the modal bar interval.
     */
    thresholdMs?: number;
    /**
     * `collapsed` gives every break the same small width. `proportional` sizes each
     * break by its duration and then caps the total.
     */
    mode?: 'collapsed' | 'proportional';
    /**
     * Width of a collapsed break, in slot units, so it scales with zoom rather than
     * being a fixed number of pixels. Half a bar is enough to read as a break.
     */
    collapsedSlots?: number;
    /**
     * Ceiling on how much of the chart the breaks may occupy, as a fraction of the
     * bars' own width. Applies to `proportional`; `collapsed` is already small.
     *
     * Expressed in slots rather than pixels so it survives a resize, and so the
     * answer does not change when the chart is 800px wide instead of 1600.
     */
    maxWhitespaceRatio?: number;
}
export declare const DEFAULT_COLLAPSED_SLOTS = 0.5;
export declare const DEFAULT_MAX_WHITESPACE_RATIO = 0.25;
/**
 * The modal interval between bars, in milliseconds.
 *
 * Modal rather than mean, because one weekend does not make a chart of 1-minute
 * bars into a chart of 17-hour bars. A mean is the wrong statistic here in exactly
 * the case that matters most, which is the whole point of the feature.
 */
export declare function modalInterval(times: readonly number[]): number;
/**
 * Gaps large enough to be session breaks.
 *
 * A break is identified by its own size, not by a session calendar, because the
 * calendar is the part of this that would have to be per-exchange and per-holiday
 * and would be wrong the day a holiday moved. A gap of more than `factor` intervals
 * is a break under any calendar that matters, and a break under none of them is
 * still a gap worth marking.
 */
export declare function findSessionBreaks(times: readonly number[], thresholdMs: number): Array<{
    index: number;
    gapMs: number;
}>;
/** Resolved break policy, with the threshold derived when it was not given. */
export interface ResolvedSessionBreaks {
    thresholdMs: number;
    mode: 'collapsed' | 'proportional';
    collapsedSlots: number;
    maxWhitespaceRatio: number;
    /**
     * The modal bar interval the threshold was derived from, in ms.
     *
     * Carried so that sizing the breaks does not have to derive it again. It is not
     * the same as the threshold divided by anything — a caller who pinned
     * `thresholdMs` broke that relationship, and deriving the interval from the
     * threshold anyway would size their breaks against a number that has nothing to
     * do with their bars.
     */
    interval: number;
}
export declare function resolveSessionBreaks(times: readonly number[], options: SessionBreakOptions | undefined): ResolvedSessionBreaks;
/**
 * Sizes every break, capped so whitespace can never take over the chart.
 *
 * The cap is on the **total**, not per break, because the failure mode is
 * cumulative: thirty individually reasonable breaks are a chart of nothing. It is
 * expressed against the bars' own width so it means the same thing at any zoom.
 */
export declare function sizeSessionBreaks(times: readonly number[], resolved: ResolvedSessionBreaks): SessionBreak[];
/**
 * `sizeSessionBreaks`, reporting the budget scale that was applied.
 *
 * The scale has to travel with the breaks. A full rebuild and an incremental
 * append both cap total whitespace against the same budget, and an incremental
 * append recovers the widths of breaks already in the table by measuring the steps
 * between adjacent offsets — which are the *capped* widths. Without the factor, the
 * append reads an already-capped width as a raw one and caps it again, and the
 * gaps decay geometrically across successive appends until a proportional chart
 * shows no breaks at all. `sizeSessionBreaks` alone cannot report the factor, so a
 * caller that will later append incrementally needs this form.
 *
 * @returns The sized breaks, and the uniform scale applied to their widths.
 */
export declare function sizeSessionBreaksWithScale(times: readonly number[], resolved: ResolvedSessionBreaks): {
    breaks: SessionBreak[];
    scale: number;
};
/**
 * Cumulative slot offset of every bar, so a coordinate is a lookup rather than a
 * sum.
 *
 * `offsets[i]` is the slot position of bar `i`'s left edge. The array is rebuilt
 * only when the data changes, never when the view does, which is what keeps a pan
 * or a zoom free of any per-bar work.
 */
export declare function computeSlotOffsets(times: readonly number[], breaks: readonly SessionBreak[]): Float64Array;
/**
 * `computeSlotOffsets` and `trimSlotOffsetsIncremental` in
 * `incrementalSlots.ts` are the only implementations of appending to and trimming
 * a slot table. Two near-duplicates used to live here as well:
 *
 * `appendCollapsedSlotOffsets` was a second collapsed append, and it was wrong. On
 * a fresh table it set `priorTime` to negative infinity, so the very first bar's
 * gap was `+Infinity` — over any threshold — and a continuous series got a
 * phantom half-slot break before bar 0. The equivalent in `incrementalSlots` has
 * an explicit first-bar guard; this one did not.
 *
 * `trimSlotOffsets` was a second trim, byte-for-byte in behaviour.
 *
 * Both were imported into `Chart` and called by nothing, and neither was tested.
 * A duplicate with a latent defect and no test is worse than no function at all:
 * it is the one a later author wires up, and it fails on a gapped series at the
 * left edge where nothing is looking. `incrementalSlots` owns both operations.
 */
/** Total slots the series occupies, bars and breaks together. */
export declare function totalSlots(offsets: Float64Array): number;
export { appendSlotOffsetsCollapsed, appendSlotOffsetsProportional, appendSlotOffsetsProportionalWithScale, trimSlotOffsetsIncremental, totalSlotsFast, slotOffsetAt, incrementalSlotUpdate, incrementalSlotUpdateWithScale, type SlotTableUpdate, } from './incrementalSlots.js';
/**
 * Bar containing a slot position.
 *
 * Binary search over the prefix sums, so it is O(log n) and holds at a million
 * bars. A slot before the first bar or after the last clamps to an end rather than
 * returning -1, because a pointer dragged past either edge of the chart still has
 * to resolve to the bar nearest it.
 *
 * A null `offsets` means the series has no breaks, and is the identity: slot `s` is
 * bar `s`. Deliberately *not* rounded, because that would take the sub-bar precision
 * away from the callers that need it — `nearestCandleIndex` rounds a slot to the
 * nearest bar, and folding that into this lookup would round twice and pick the
 * wrong bar whenever the cursor sat just past a boundary. The callers that want a
 * whole bar round here, where they say which way.
 */
export declare function indexAtSlot(offsets: Float64Array | null, slot: number): number;
/**
 * Inclusive `[start, end]` bar runs covering `[fromIndex, toIndex]`, split at every
 * session break inside it.
 *
 * Bars are adjacent in slot space except across a break, where a bar is more than one
 * slot after its predecessor, so a run ends wherever the slot step exceeds one. With
 * no table there is one run, which is the whole of the behaviour that shipped before
 * decorations could span a break.
 *
 * Zero-width runs are dropped and the result is clamped to the series, so a caller
 * can hand over whatever index range it holds without pre-validating it.
 */
export declare function contiguousRuns(offsets: Float64Array | null, fromIndex: number, toIndex: number, count: number): Array<[number, number]>;
/**
 * How many bars have their left edge strictly before `slot`.
 *
 * A separate question from `indexAtSlot`, and the two have different answers at a
 * boundary. A bar whose left edge sits exactly on the plot's right edge is not
 * visible, so it must not be counted — which is what makes this a count rather than
 * `indexAtSlot(...) + 1`. Over an unbroken series the two agree except on exact
 * integers, and on exact integers the count is the right one: a plot ending at slot
 * 80 shows bars 0 to 79.
 *
 * The comparison is exact rather than epsilon-guarded, and can be: every value in a
 * slot table is a sum of 1s and halves, so the boundary cases are representable and
 * an epsilon here would only turn a correct answer into a wrong one near it.
 */
export declare function barsBeforeSlot(offsets: Float64Array | null, slot: number): number;
/**
 * The number of bars before a slot, extrapolated past either end of the series.
 *
 * `barsBeforeSlot` clamps, which is right for "which bars are on screen" and wrong for
 * "where does this slot sit on the axis". The two answers diverge outside the data, and
 * they diverge *asymmetrically*: with no breaks the clamped version is
 * `Math.ceil(slot)` and extrapolates by accident, while with breaks the slot lookup finds
 * a containing bar, clamps it to an end, and stops. A chart with an overnight break would
 * therefore have got labels in its empty space and a chart without would not — the
 * difference being whether the instrument trades overnight, which is exactly the kind of
 * thing that looks like a data bug and is a code branch.
 *
 * Outside the series the index axis continues at one bar per slot, which is the only
 * continuation matching how the bars inside it are spaced.
 */
export declare function barsBeforeSlotExtended(offsets: Float64Array | null, slot: number, count: number): number;
/**
 * Slot position of a bar's centre.
 *
 * Half a slot past the bar's own left edge — and *only* half a slot, which is the whole
 * content of this function. A bar is one slot wide whatever follows it, so its centre is
 * `offsets[i] + 0.5` and nothing else.
 *
 * The obvious-looking alternative, the midpoint between this bar's left edge and the
 * next one's, is wrong exactly when a break follows. That midpoint is a bar plus half
 * the break, so the last bar of a session is drawn half a gap into the whitespace rather
 * than at the end of its own session, and it is wrong by a different amount for every
 * bar in the series depending on what comes next. On an unbroken series the two agree,
 * which is why it survived: it was correct for every chart anyone could see.
 */
export declare function slotAtIndex(offsets: Float64Array | null, index: number): number;
/**
 * Slot position of an aggregation bucket's centre.
 *
 * The pyramid aggregates in **ordinal** space — the only space a bucket has meaning in,
 * because a bucket is a run of bars rather than a run of pixels — and this is where a
 * run of bars becomes a position. It is the single conversion, shared by the candles
 * and the overlays, because the two are read against each other: an overlay is
 * understood as annotating the candle beneath it, and two conversions of the same
 * question is how a moving average ends up half a bar from the price it annotates.
 *
 * The centre is the mean of the bucket's **first and last bar centres**, not the centre
 * of the bar at the bucket's middle ordinal. Those differ whenever a session break falls
 * inside the bucket, and they differ by roughly the width of the break: a bucket
 * straddling an overnight would be drawn at the last bar before the gap, which is to say
 * drawn somewhere the data is not. Averaging the endpoints puts a bucket that spans a
 * break in the middle of what it spans, which is the honest place for it.
 *
 * A bucket of one is that bar, and a series with no breaks makes this the identity, so
 * neither of those cases changes.
 *
 * `barBase` is the absolute ordinal of the first retained bar, and `bucketIndex` is
 * **absolute**. The pyramid's buckets are cut on absolute boundaries and are not
 * re-cut when history is trimmed, because re-cutting is an O(n) re-aggregation of
 * every level and the trim is on the append path. So a bucket's bars, in absolute
 * terms, are `[bucketIndex * factor, (bucketIndex + 1) * factor)`, and only the part
 * of that which is still retained has a position.
 *
 * With `barBase` at 0 — a series that has never been trimmed, which is every chart at
 * load — this reduces exactly to the untrimmed formula. That matters: the whole
 * coordinate layer is exercised by tests and charts that never trim, and a change here
 * must be a no-op for them.
 */
export declare function bucketCentreSlot(offsets: Float64Array | null, bucketIndex: number, factor: number, sourceCount: number, barBase?: number): number;
/**
 * Ordinal of the bar nearest a wall-clock timestamp.
 *
 * Separate from `nearestCandleIndexByTime`, which snaps to the nearest *ordinal*.
 * With a break in the series those disagree, and this one is the honest answer for
 * a caller who has a timestamp: a time inside a session break belongs to the bar
 * on whichever side is nearer, not to whatever ordinal happens to sit there.
 */
export declare function indexAtTime(times: readonly number[], time: number): number;
