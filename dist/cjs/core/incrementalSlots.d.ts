/**
 * A slot table, and the uniform budget scale its break widths are under.
 *
 * The two travel together because they are not independent. Break widths in
 * `proportional` mode are capped against a total whitespace budget, and the cap is
 * a single factor applied to every break. A table on its own does not record the
 * factor, so a later incremental append cannot recover the widths it was built
 * from — it can only read back the already-capped numbers and scale them again.
 */
export interface SlotTableUpdate {
    offsets: Float64Array;
    /** The scale applied to break widths, or 1 when the budget was not exceeded. */
    scale: number;
}
/**
 * Incrementally extends a slot table with appended bars.
 *
 * For collapsed breaks, this is O(k) where k is the number of appended bars.
 * For proportional breaks, the new break sizes are computed incrementally and
 * the total whitespace is checked against the budget.
 *
 * @param previous   The existing slot offset table, or null if none exists.
 * @param prevLastTime  The timestamp of the last bar in the previous table.
 * @param appendedTimes  Timestamps of the newly appended bars.
 * @param thresholdMs   Minimum gap that counts as a session break.
 * @param collapsedSlots Width of a collapsed break in slot units.
 * @returns The extended slot table.
 */
export declare function appendSlotOffsetsCollapsed(previous: Float64Array | null, prevLastTime: number, appendedTimes: readonly number[], thresholdMs: number, collapsedSlots: number): Float64Array;
/**
 * Incrementally extends a slot table with proportional breaks.
 *
 * Proportional breaks are sized by their duration relative to the modal interval,
// then capped so the total whitespace does not exceed the budget. When appending
 * new bars, only the new breaks need sizing. If the total whitespace exceeds the
 * budget after appending, all breaks are rescaled — but this is rare in practice
 * because the budget is a fraction of the bar count, which grows with the series.
 *
 * @param previous   The existing slot offset table, or null if none exists.
 * @param prevLastTime  The timestamp of the last bar in the previous table.
 * @param appendedTimes  Timestamps of the newly appended bars.
 * @param _unusedTimes Retained for call compatibility; no longer read.
 * @param thresholdMs   Minimum gap that counts as a session break.
 * @param maxWhitespaceRatio  Maximum whitespace as a fraction of bar count.
 * @param interval       The modal interval in ms.
 * @returns The extended slot table.
 *
 * The result describes `previous.length + appendedTimes.length` bars, and the
 * length is derived from those two numbers rather than from a times array. It used
 * to come from `_unusedTimes`, which the production caller supplied *post-trim*
 * while `previous` was *pre-trim* — so every break index the function computed
 * named a bar in one numbering and was written into a table built in another, and
 * in a retained series every break shifted left by the trim count on each append.
 * Deriving the length removes the possibility of the two disagreeing rather than
 * trying to keep them in step.
 *
 * Assumes `previous` carries no prior budget scale, which is true of a table from
 * `computeSlotOffsets` and false of one that has been through an incremental
 * append. A live feed in `proportional` mode should use
 * `appendSlotOffsetsProportionalWithScale`, which carries the scale explicitly.
 */
export declare function appendSlotOffsetsProportional(previous: Float64Array | null, prevLastTime: number, appendedTimes: readonly number[], _unusedTimes: readonly number[], thresholdMs: number, maxWhitespaceRatio: number, interval: number): Float64Array;
/**
 * Incrementally extends a slot table with proportional breaks, carrying the budget
 * scale across appends.
 *
 * This is the form a live feed needs. `appendSlotOffsetsProportional` recovers the
 * widths of breaks already in the table by reading the steps between adjacent
 * offsets — but those steps are the *scaled* widths, because the previous update
 * already multiplied them by a budget scale. Reading them as if they were raw and
 * then applying a fresh scale on top compounds: every append tightened the cap a
 * little and shrank every earlier break by the same little, so the gaps under the
 * crosshair decayed geometrically towards zero and the chart quietly stopped
 * showing session breaks a few minutes into a session.
 *
 * Passing the previous scale makes the recovery idempotent: raw width is the scaled
 * step divided by the scale that produced it, and the new scale is then computed
 * once, from raw widths, against the budget.
 *
 * @param previous   The existing slot offset table, or null if none exists.
 * @param prevLastTime  The timestamp of the last bar in the previous table.
 * @param appendedTimes  Timestamps of the newly appended bars.
 * @param thresholdMs   Minimum gap that counts as a session break.
 * @param maxWhitespaceRatio  Maximum whitespace as a fraction of bar count.
 * @param interval       The modal interval in ms.
 * @param appliedScale   The scale `previous`'s breaks are already under.
 * @returns The new table, and the scale its breaks are now under.
 */
export declare function appendSlotOffsetsProportionalWithScale(previous: Float64Array | null, prevLastTime: number, appendedTimes: readonly number[], thresholdMs: number, maxWhitespaceRatio: number, interval: number, appliedScale?: number): SlotTableUpdate;
/**
 * Trims a prefix from a slot table and rebases the remaining offsets.
 *
 * O(n - k), where k is the number of trimmed bars and n the table length — the
 * whole surviving table is copied and shifted, because every entry after the cut
 * has to move by `base`.
 *
 * It is not O(k) in the trimmed count, and the comment on this function used to
 * claim it was. On a live feed at the retention cap every append trims a bar or
 * two and so paid a full-table copy, which is O(n) at the 1,000,000-candle
 * default — on top of the same O(n) work in the pyramid reset and in
 * `candleTimes.splice`. Three independent full passes per append is most of the
 * reason a 1,000-candle batch straddles the frame budget.
 *
 * Making this genuinely O(k) needs a head offset — a start index into a buffer
 * that is never re-based — which the binary searches in `indexAtSlot` and
 * `barsBeforeSlot` would all have to carry. That is the right fix and it is a
 * change to the table's representation, not to this function, so it is not
 * attempted here. The claim is corrected instead of the code being quietly wrong.
 *
 * @param offsets   The slot offset table.
 * @param trimCount Number of bars to drop from the front.
 * @returns The trimmed and rebased table.
 */
export declare function trimSlotOffsetsIncremental(offsets: Float64Array, trimCount: number): Float64Array;
/**
 * Computes the total number of slots (bars + breaks) from a slot table.
 *
 * O(1) — reads the last entry and adds 1.
 *
 * @param offsets  The slot offset table.
 * @returns Total slots.
 */
export declare function totalSlotsFast(offsets: Float64Array | null): number;
/**
 * Finds the slot offset for a specific bar index, handling incremental tables.
 *
 * O(1) — direct array lookup with bounds checking.
 *
 * @param offsets  The slot offset table.
 * @param index    The bar index.
 * @returns The slot offset for that bar.
 */
export declare function slotOffsetAt(offsets: Float64Array | null, index: number): number;
/**
 * Batch-appends multiple bars and returns the new slot table.
 *
 * This is the main entry point for incremental slot updates. It handles both
 * collapsed and proportional break modes, and it handles trimming when the
 * series exceeds the retention limit.
 *
 * @param previous       The existing slot offset table, or null.
 * @param prevLastTime   The timestamp of the last bar in the previous table.
 * @param appendedTimes  Timestamps of the newly appended bars.
 * @param mode           Break sizing mode.
 * @param thresholdMs   Minimum gap that counts as a break.
 * @param collapsedSlots Width of a collapsed break.
 * @param maxWhitespaceRatio  Maximum whitespace fraction (proportional mode).
 * @param interval       Modal interval in ms.
 * @param trimCount      Number of bars to trim from the front (retention).
 * @returns The new slot table.
 *
 * The trim is applied *after* the append, and the append is sized from
 * `previous` and `appendedTimes` alone. Those two facts are what used to be
 * violated: the append took its length from a times array the caller had already
 * trimmed, while `previous` was still the pre-trim table, so a retention trim
 * silently renumbered every session break in the series.
 */
export declare function incrementalSlotUpdate(previous: Float64Array | null, prevLastTime: number, appendedTimes: readonly number[], mode: 'collapsed' | 'proportional', thresholdMs: number, collapsedSlots: number, maxWhitespaceRatio: number, interval: number, trimCount?: number, appliedScale?: number): Float64Array;
/**
 * `incrementalSlotUpdate`, reporting the budget scale the new table's breaks are
 * under.
 *
 * The scale is what a live feed has to remember between appends in `proportional`
 * mode, so it comes back out with the table rather than being recomputed from the
 * table on the next call. A caller that does not need it can use
 * `incrementalSlotUpdate` and pass 1, which is correct for a table built by a full
 * rebuild and wrong for one this function has already touched.
 *
 * @returns The new slot table, and the scale applied to its break widths.
 */
export declare function incrementalSlotUpdateWithScale(previous: Float64Array | null, prevLastTime: number, appendedTimes: readonly number[], mode: 'collapsed' | 'proportional', thresholdMs: number, collapsedSlots: number, maxWhitespaceRatio: number, interval: number, trimCount?: number, appliedScale?: number): SlotTableUpdate;
