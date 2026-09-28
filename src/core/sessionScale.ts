// src/core/sessionScale.ts
//
// Wall-clock X. The x coordinate stops being `offsetX + index * scaleX`.
//
// The design in one sentence: **every bar is given a width in slot units, and a bar
// after a session break is given extra slots.** The x transform is still affine in
// slots, so the shader, the vertex format and every existing series keep working —
// which is the same trick the log scale uses on the other axis, and for the same
// reason: the transform does not have to be affine in the unit the caller thinks in.
//
// Slots are the unit precisely because they are view-independent. Storing pixel
// widths would mean rebuilding the whole prefix sum on every zoom, and storing
// wall-clock deltas would mean it is a function of the viewport, so both put a
// per-bar loop in the middle of a pan. Slots change only when the data changes.
//
// Why collapsed rather than honest whitespace: a 17-hour session break next to
// 1-minute bars is about a thousand bars wide, and a weekend is thirty times the
// width of a screen. Drawn to scale it is not information, it is the absence of the
// chart. The break still exists and is still visible — the series is not drawn as
// if time were continuous — but it occupies half a bar instead of a thousand.

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

export const DEFAULT_COLLAPSED_SLOTS = 0.5;
export const DEFAULT_MAX_WHITESPACE_RATIO = 0.25;

function fail(message: string): never {
    throw new Error(`MatrixCharts: ${message}`);
}

/**
 * The modal interval between bars, in milliseconds.
 *
 * Modal rather than mean, because one weekend does not make a chart of 1-minute
 * bars into a chart of 17-hour bars. A mean is the wrong statistic here in exactly
 * the case that matters most, which is the whole point of the feature.
 */
export function modalInterval(times: readonly number[]): number {
    if (times.length < 2) return 0;
    const gaps: number[] = [];
    for (let index = 1; index < times.length; index++) {
        const gap: number = times[index] - times[index - 1];
        if (gap > 0) gaps.push(gap);
    }
    if (gaps.length === 0) return 0;
    gaps.sort((a, b): number => a - b);
    // The middle gap. With ties the lower of the two middles, which is the shorter
    // interval: a chart of mostly-1-minute bars with a few 2-minute bars should read
    // as 1-minute bars.
    return gaps[Math.floor((gaps.length - 1) / 2)];
}

/**
 * Gaps large enough to be session breaks.
 *
 * A break is identified by its own size, not by a session calendar, because the
 * calendar is the part of this that would have to be per-exchange and per-holiday
 * and would be wrong the day a holiday moved. A gap of more than `factor` intervals
 * is a break under any calendar that matters, and a break under none of them is
 * still a gap worth marking.
 */
export function findSessionBreaks(
    times: readonly number[],
    thresholdMs: number,
): Array<{ index: number; gapMs: number }> {
    const breaks: Array<{ index: number; gapMs: number }> = [];
    for (let index = 1; index < times.length; index++) {
        const gapMs: number = times[index] - times[index - 1];
        if (gapMs > thresholdMs) breaks.push({ index, gapMs });
    }
    return breaks;
}

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

export function resolveSessionBreaks(
    times: readonly number[],
    options: SessionBreakOptions | undefined,
): ResolvedSessionBreaks {
    const interval: number = modalInterval(times);
    const thresholdMs: number = options?.thresholdMs
        ?? (interval > 0 ? interval * 3 : 0);
    if (!(thresholdMs >= 0) || !Number.isFinite(thresholdMs)) {
        fail('timeScale.sessionBreaks.thresholdMs must be a non-negative, finite number of milliseconds.');
    }
    const collapsedSlots: number = options?.collapsedSlots ?? DEFAULT_COLLAPSED_SLOTS;
    if (!(collapsedSlots > 0) || !Number.isFinite(collapsedSlots)) {
        fail('timeScale.sessionBreaks.collapsedSlots must be a finite number greater than zero.');
    }
    const maxWhitespaceRatio: number = options?.maxWhitespaceRatio ?? DEFAULT_MAX_WHITESPACE_RATIO;
    if (!(maxWhitespaceRatio > 0) || !Number.isFinite(maxWhitespaceRatio)) {
        fail('timeScale.sessionBreaks.maxWhitespaceRatio must be a finite number greater than zero.');
    }
    const mode: 'collapsed' | 'proportional' = options?.mode ?? 'collapsed';
    if (mode !== 'collapsed' && mode !== 'proportional') {
        fail(`timeScale.sessionBreaks.mode is ${JSON.stringify(options?.mode)}; expected 'collapsed' or 'proportional'.`);
    }
    return { thresholdMs, mode, collapsedSlots, maxWhitespaceRatio, interval };
}

/**
 * Sizes every break, capped so whitespace can never take over the chart.
 *
 * The cap is on the **total**, not per break, because the failure mode is
 * cumulative: thirty individually reasonable breaks are a chart of nothing. It is
 * expressed against the bars' own width so it means the same thing at any zoom.
 */
export function sizeSessionBreaks(
    times: readonly number[],
    resolved: ResolvedSessionBreaks,
): SessionBreak[] {
    return sizeSessionBreaksWithScale(times, resolved).breaks;
}

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
export function sizeSessionBreaksWithScale(
    times: readonly number[],
    resolved: ResolvedSessionBreaks,
): { breaks: SessionBreak[]; scale: number } {
    const raw: Array<{ index: number; gapMs: number }> = findSessionBreaks(times, resolved.thresholdMs);
    if (raw.length === 0) return { breaks: [], scale: 1 };

    const barCount: number = times.length;
    let slots: number[];
    // Taken from `resolved`, which already holds it.
    //
    // `resolveSessionBreaks` derives the modal interval to get a default threshold,
    // and this function used to derive it a second time to size the breaks. That is
    // two O(n log n) sorts of the whole retained series for one number, on every
    // rebuild — and the two could disagree, because a caller who pinned
    // `thresholdMs` was still getting this second, independently derived interval.
    // A shared field makes the disagreement impossible rather than unlikely.
    const interval: number = resolved.interval;

    if (resolved.mode === 'collapsed') {
        slots = raw.map((): number => resolved.collapsedSlots);
    } else {
        // How many bars' worth of time each gap represents. Without an interval
        // there is no scale to express a gap in, so every break collapses.
        slots = interval > 0
            ? raw.map((entry): number => entry.gapMs / interval - 1)
            : raw.map((): number => resolved.collapsedSlots);
    }

    const total: number = slots.reduce((sum, value) => sum + value, 0);
    const budget: number = resolved.maxWhitespaceRatio * barCount;
    let scale = 1;
    if (total > budget && total > 0) {
        // Scaled rather than truncated: a break that is over budget is still a
        // break, and dropping the surplus would collapse some breaks to nothing
        // while leaving others at full width, which reads as data rather than as
        // a cap.
        scale = budget / total;
        slots = slots.map((value): number => value * scale);
    }

    return {
        breaks: raw.map((entry, order): SessionBreak => ({
            index: entry.index,
            gapMs: entry.gapMs,
            slots: Math.max(0, slots[order]),
        })),
        scale,
    };
}

/**
 * Cumulative slot offset of every bar, so a coordinate is a lookup rather than a
 * sum.
 *
 * `offsets[i]` is the slot position of bar `i`'s left edge. The array is rebuilt
 * only when the data changes, never when the view does, which is what keeps a pan
 * or a zoom free of any per-bar work.
 */
export function computeSlotOffsets(
    times: readonly number[],
    breaks: readonly SessionBreak[],
): Float64Array {
    const count: number = times.length;
    const offsets: Float64Array = new Float64Array(count);
    if (count === 0) return offsets;

    const extra: Map<number, number> = new Map<number, number>();
    for (const entry of breaks) extra.set(entry.index, entry.slots);

    let cursor: number = 0;
    for (let index = 0; index < count; index++) {
        offsets[index] = cursor;
        // Every bar is one slot, plus whatever break precedes the next one.
        cursor += 1 + (index + 1 < count ? (extra.get(index + 1) ?? 0) : 0);
    }
    return offsets;
}

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
export function totalSlots(offsets: Float64Array): number {
    if (offsets.length === 0) return 0;
    const last: number = offsets[offsets.length - 1];
    return last + 1;
}

// Re-exported from `incrementalSlots`, which owns every mutation of the table. The
// re-export is a convenience for the pure functions here that need to read it, not
// a second home: there is one implementation of each, and these are the same
// bindings rather than wrappers.
export {
    appendSlotOffsetsCollapsed,
    appendSlotOffsetsProportional,
    appendSlotOffsetsProportionalWithScale,
    trimSlotOffsetsIncremental,
    totalSlotsFast,
    slotOffsetAt,
    incrementalSlotUpdate,
    incrementalSlotUpdateWithScale,
    type SlotTableUpdate,
} from './incrementalSlots.js';

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
export function indexAtSlot(offsets: Float64Array | null, slot: number): number {
    if (offsets === null) return slot;
    const count: number = offsets.length;
    if (count === 0) return -1;
    if (slot <= offsets[0]) return 0;
    if (slot >= offsets[count - 1]) return count - 1;
    let low = 0;
    let high = count - 1;
    while (low < high) {
        const middle = (low + high + 1) >>> 1;
        if (offsets[middle] <= slot) low = middle;
        else high = middle - 1;
    }
    return low;
}

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
export function contiguousRuns(
    offsets: Float64Array | null,
    fromIndex: number,
    toIndex: number,
    count: number,
): Array<[number, number]> {
    const first: number = Math.max(0, Math.min(count - 1, Math.trunc(fromIndex)));
    const last: number = Math.max(0, Math.min(count - 1, Math.trunc(toIndex)));
    if (count <= 0 || first > last) return [];

    const runs: Array<[number, number]> = [];
    let start: number = first;
    for (let index = first; index < last; index++) {
        const step: number = offsets === null ? 1 : offsets[index + 1] - offsets[index];
        // Greater than one, not merely greater than zero. A collapsed break is half a
        // bar, so the step across it is 1.5, and treating that as contiguous is what
        // would leave a zone painted over the gap it is supposed to respect.
        if (step > 1) {
            runs.push([start, index]);
            start = index + 1;
        }
    }
    runs.push([start, last]);
    return runs;
}

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
export function barsBeforeSlot(offsets: Float64Array | null, slot: number): number {
    if (offsets === null) return Math.ceil(slot);
    const count: number = offsets.length;
    if (count === 0) return 0;
    // The largest bar whose left edge is strictly before the slot. `indexAtSlot`
    // answers for `<=`, so when the two land on the same bar it is sitting exactly on
    // the edge and the answer is that bar's own index rather than the next one.
    const containing: number = indexAtSlot(offsets, slot);
    return offsets[containing] < slot ? containing + 1 : containing;
}

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
export function barsBeforeSlotExtended(
    offsets: Float64Array | null,
    slot: number,
    count: number,
): number {
    // Nothing to extrapolate against, and the unclamped formula is already the answer.
    if (offsets === null || count <= 0) return Math.ceil(slot);
    const extent: number = totalSlots(offsets);
    if (slot >= extent) return count + Math.ceil(slot - extent);
    if (slot <= 0) return Math.ceil(slot);
    return barsBeforeSlot(offsets, slot);
}

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
export function slotAtIndex(offsets: Float64Array | null, index: number): number {
    if (offsets === null) return index;
    if (offsets.length === 0) return 0;
    const clamped: number = Math.max(0, Math.min(offsets.length - 1, Math.trunc(index)));
    return offsets[clamped] + 0.5;
}

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
export function bucketCentreSlot(
    offsets: Float64Array | null,
    bucketIndex: number,
    factor: number,
    sourceCount: number,
    barBase: number = 0,
): number {
    if (!(factor > 1)) return slotAtIndex(offsets, bucketIndex - barBase);
    const bucket: number = Math.trunc(bucketIndex);
    // Retained-window ordinals of the bars this bucket actually holds. Both ends are
    // clipped against the window rather than against the series, so a bucket that
    // straddles the trim is placed at the centre of what is left of it instead of at
    // the centre of a group that is no longer wholly on screen.
    const first: number = Math.max(0, bucket * factor - barBase);
    const last: number = Math.min((bucket + 1) * factor - barBase, sourceCount) - 1;
    if (last <= first) return slotAtIndex(offsets, first);
    return (slotAtIndex(offsets, first) + slotAtIndex(offsets, last)) / 2;
}

/**
 * Ordinal of the bar nearest a wall-clock timestamp.
 *
 * Separate from `nearestCandleIndexByTime`, which snaps to the nearest *ordinal*.
 * With a break in the series those disagree, and this one is the honest answer for
 * a caller who has a timestamp: a time inside a session break belongs to the bar
 * on whichever side is nearer, not to whatever ordinal happens to sit there.
 */
export function indexAtTime(times: readonly number[], time: number): number {
    const count: number = times.length;
    if (count === 0) return -1;
    if (time <= times[0]) return 0;
    if (time >= times[count - 1]) return count - 1;
    let low = 0;
    let high = count - 1;
    while (low < high) {
        const middle = (low + high + 1) >>> 1;
        if (times[middle] <= time) low = middle;
        else high = middle - 1;
    }
    // Inside the gap after `low`, or inside `low` itself.
    if (low + 1 < count) {
        const span: number = times[low + 1] - times[low];
        if (span > 0 && time - times[low] > span / 2) return low + 1;
    }
    return low;
}
