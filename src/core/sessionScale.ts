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
    return { thresholdMs, mode, collapsedSlots, maxWhitespaceRatio };
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
    const raw: Array<{ index: number; gapMs: number }> = findSessionBreaks(times, resolved.thresholdMs);
    if (raw.length === 0) return [];

    const interval: number = modalInterval(times);
    const barCount: number = times.length;
    let slots: number[];

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
    if (total > budget && total > 0) {
        // Scaled rather than truncated: a break that is over budget is still a
        // break, and dropping the surplus would collapse some breaks to nothing
        // while leaving others at full width, which reads as data rather than as
        // a cap.
        const scale: number = budget / total;
        slots = slots.map((value): number => value * scale);
    }

    return raw.map((entry, order): SessionBreak => ({
        index: entry.index,
        gapMs: entry.gapMs,
        slots: Math.max(0, slots[order]),
    }));
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

/** Total slots the series occupies, bars and breaks together. */
export function totalSlots(offsets: Float64Array): number {
    if (offsets.length === 0) return 0;
    const last: number = offsets[offsets.length - 1];
    return last + 1;
}

/**
 * Bar containing a slot position.
 *
 * Binary search over the prefix sums, so it is O(log n) and holds at a million
 * bars. A slot before the first bar or after the last clamps to an end rather than
 * returning -1, because a pointer dragged past either edge of the chart still has
 * to resolve to the bar nearest it.
 */
export function indexAtSlot(offsets: Float64Array, slot: number): number {
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
 * Slot position of a bar's centre.
 *
 * Centres rather than left edges, because a bar's visual extent is its body and
 * body and wick are drawn from its centre, so a coordinate taken from a left edge
 * would be half a bar off everything drawn.
 */
export function slotAtIndex(offsets: Float64Array, index: number): number {
    if (offsets.length === 0) return 0;
    const clamped: number = Math.max(0, Math.min(offsets.length - 1, Math.trunc(index)));
    const next: number = clamped + 1 < offsets.length ? offsets[clamped + 1] : offsets[clamped] + 1;
    return (offsets[clamped] + next) / 2;
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
