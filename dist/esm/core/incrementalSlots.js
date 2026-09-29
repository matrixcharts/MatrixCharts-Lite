// src/core/incrementalSlots.ts
//
// Incremental slot table construction and retention trimming.
//
// The slot table is a prefix sum of bar widths plus break widths. A full rebuild
// is O(n) in the number of bars, which is fine for a data load but wasteful for
// a live feed that appends a few bars at a time. This module provides:
//
// 1. Incremental append: extend a slot table by appending new bars and their
//    breaks without rescanning the retained history.
// 2. Incremental trim: drop a prefix of bars and rebase the remaining offsets
//    in O(k) where k is the number of trimmed bars, not O(n).
// 3. Proportional break sizing with incremental updates: when a new break is
//    appended, only the new break's slots need computing; existing breaks keep
//    their sizes unless the total whitespace budget is exceeded.
//
// The key insight is that slot offsets are additive: each bar contributes 1 slot
// plus any break that precedes it. Appending bars only affects the tail of the
// table, and trimming only affects the head.
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
export function appendSlotOffsetsCollapsed(previous, prevLastTime, appendedTimes, thresholdMs, collapsedSlots) {
    const result = new Float64Array(previous ? previous.length + appendedTimes.length : appendedTimes.length);
    if (previous && previous.length > 0) {
        result.set(previous);
    }
    const hasPrevious = previous !== null && previous.length > 0;
    let cursor = hasPrevious
        ? previous[previous.length - 1] + 1
        : 0;
    let priorTime = hasPrevious ? prevLastTime : Number.NEGATIVE_INFINITY;
    for (let index = 0; index < appendedTimes.length; index++) {
        const time = appendedTimes[index];
        // Add break slots BEFORE the bar if there's a gap.
        // Skip the very first bar only when there's no previous table AND it's the first iteration
        // (no gap exists before the first bar in the series).
        const isFirstBarInSeries = !hasPrevious && index === 0;
        if (!isFirstBarInSeries && time - priorTime > thresholdMs) {
            cursor += collapsedSlots;
        }
        result[hasPrevious ? previous.length + index : index] = cursor;
        cursor += 1;
        priorTime = time;
    }
    return result;
}
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
export function appendSlotOffsetsProportional(previous, prevLastTime, appendedTimes, _unusedTimes, thresholdMs, maxWhitespaceRatio, interval) {
    return appendSlotOffsetsProportionalWithScale(previous, prevLastTime, appendedTimes, thresholdMs, maxWhitespaceRatio, interval, 1).offsets;
}
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
export function appendSlotOffsetsProportionalWithScale(previous, prevLastTime, appendedTimes, thresholdMs, maxWhitespaceRatio, interval, appliedScale = 1) {
    const prevLength = previous === null ? 0 : previous.length;
    const totalLength = prevLength + appendedTimes.length;
    const hasPrevious = prevLength > 0;
    // Break widths in **raw** slot units — before any budget scale — keyed by the bar
    // index the break sits in front of.
    const breakSlots = new Map();
    let totalBreakSlots = 0;
    if (hasPrevious) {
        const inverse = appliedScale > 0 ? 1 / appliedScale : 1;
        for (let i = 1; i < prevLength; i++) {
            const step = previous[i] - previous[i - 1];
            if (step > 1) {
                const raw = (step - 1) * inverse;
                breakSlots.set(i, raw);
                totalBreakSlots += raw;
            }
        }
    }
    // New breaks, sized in the same raw units so both can be summed against one
    // budget. `prevLastTime` is the only legitimate predecessor of the first
    // appended bar; reaching into a times array for it would mean reading a
    // post-trim index in pre-trim numbering.
    for (let i = 0; i < appendedTimes.length; i++) {
        const globalIndex = prevLength + i;
        // No bar precedes the first bar of a series, so no break sits in front of it.
        if (!hasPrevious && i === 0)
            continue;
        const priorTime = i === 0 ? prevLastTime : appendedTimes[i - 1];
        const gap = appendedTimes[i] - priorTime;
        if (!(gap > thresholdMs))
            continue;
        const raw = interval > 0 ? gap / interval - 1 : 0.5;
        breakSlots.set(globalIndex, raw);
        totalBreakSlots += raw;
    }
    // One scale for the whole table, from raw widths, reported back so the next
    // append can undo it.
    const budget = maxWhitespaceRatio * totalLength;
    const scale = totalBreakSlots > budget && totalBreakSlots > 0 && budget > 0
        ? budget / totalBreakSlots
        : 1;
    const result = new Float64Array(totalLength);
    let cursor = 0;
    for (let i = 0; i < totalLength; i++) {
        result[i] = cursor;
        // A break keyed at `k` sits in front of bar `k`, so it is consumed as the
        // walk steps from bar `k-1` to bar `k`.
        const breakAtNext = breakSlots.get(i + 1);
        cursor += 1 + (breakAtNext !== undefined ? breakAtNext * scale : 0);
    }
    return { offsets: result, scale };
}
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
export function trimSlotOffsetsIncremental(offsets, trimCount) {
    if (!Number.isInteger(trimCount) || trimCount < 0 || trimCount > offsets.length) {
        throw new Error('MatrixCharts: Slot trim count must be within the offset table.');
    }
    if (trimCount === 0)
        return offsets;
    if (trimCount === offsets.length)
        return new Float64Array(0);
    const result = new Float64Array(offsets.length - trimCount);
    const base = offsets[trimCount];
    for (let i = 0; i < result.length; i++) {
        result[i] = offsets[trimCount + i] - base;
    }
    return result;
}
/**
 * Computes the total number of slots (bars + breaks) from a slot table.
 *
 * O(1) — reads the last entry and adds 1.
 *
 * @param offsets  The slot offset table.
 * @returns Total slots.
 */
export function totalSlotsFast(offsets) {
    if (!offsets || offsets.length === 0)
        return 0;
    return offsets[offsets.length - 1] + 1;
}
/**
 * Finds the slot offset for a specific bar index, handling incremental tables.
 *
 * O(1) — direct array lookup with bounds checking.
 *
 * @param offsets  The slot offset table.
 * @param index    The bar index.
 * @returns The slot offset for that bar.
 */
export function slotOffsetAt(offsets, index) {
    if (!offsets || offsets.length === 0)
        return index;
    if (index < 0)
        return offsets[0] + index;
    if (index >= offsets.length) {
        // Extrapolate: one slot per bar past the end
        return offsets[offsets.length - 1] + 1 + (index - offsets.length);
    }
    return offsets[index];
}
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
export function incrementalSlotUpdate(previous, prevLastTime, appendedTimes, mode, thresholdMs, collapsedSlots, maxWhitespaceRatio, interval, trimCount = 0, appliedScale = 1) {
    let result;
    if (mode === 'collapsed') {
        result = appendSlotOffsetsCollapsed(previous, prevLastTime, appendedTimes, thresholdMs, collapsedSlots);
    }
    else {
        result = appendSlotOffsetsProportionalWithScale(previous, prevLastTime, appendedTimes, thresholdMs, maxWhitespaceRatio, interval, appliedScale).offsets;
    }
    if (trimCount > 0) {
        result = trimSlotOffsetsIncremental(result, trimCount);
    }
    return result;
}
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
export function incrementalSlotUpdateWithScale(previous, prevLastTime, appendedTimes, mode, thresholdMs, collapsedSlots, maxWhitespaceRatio, interval, trimCount = 0, appliedScale = 1) {
    if (mode === 'collapsed') {
        const offsets = trimCount > 0
            ? trimSlotOffsetsIncremental(appendSlotOffsetsCollapsed(previous, prevLastTime, appendedTimes, thresholdMs, collapsedSlots), trimCount)
            : appendSlotOffsetsCollapsed(previous, prevLastTime, appendedTimes, thresholdMs, collapsedSlots);
        // Collapsed breaks are a fixed width and are never scaled, so the scale a
        // collapsed table was built under is 1 by definition. Carrying the previous
        // value forward would be harmless here and wrong the moment a chart
        // switches modes.
        return { offsets, scale: 1 };
    }
    const update = appendSlotOffsetsProportionalWithScale(previous, prevLastTime, appendedTimes, thresholdMs, maxWhitespaceRatio, interval, appliedScale);
    if (trimCount > 0) {
        return { offsets: trimSlotOffsetsIncremental(update.offsets, trimCount), scale: update.scale };
    }
    return update;
}
