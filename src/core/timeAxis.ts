// src/core/timeAxis.ts
//
// Which candles the time axis labels, and the bar spacing between them.
//
// The design in one sentence: **ticks are chosen in bar-index space and never in slot
// space.** That is the whole fix, and it is worth saying why the two cannot be mixed.
//
// Stepping in slots looks like the obvious way to draw an axis on a series that has
// session breaks, and it is what this did. It is wrong, because a slot is a *position*
// and a tick is a *label*: a slot that lands inside a break belongs to no bar, and the
// only way to turn it into a coordinate is to snap it to the bar on one side. Every
// slot in that break then resolves to the same bar, so the second one produces the same
// x as the first, and a loop that stops when x stops advancing — which is the only exit
// that terminates when the slot lookup clamps at the end of the series — stops at the
// *first* break. The axis is drawn for the first session and never again. The same
// truncation hit the vertical grid lines, which share the step.
//
// Choosing bars instead removes the failure rather than guarding against it. A bar index
// is a bar; there is no in-between state to snap, so the sequence is monotonic by
// construction and the exit condition is simply "past the last visible bar".
//
// Two things are then decided separately, because they are separate questions:
//
// - **How many bars per label** is a pixel-budget question, answered from the plot
//   width. This is what keeps labels evenly spaced, and it is the reason density does
//   not change when a weekend is on screen: the breaks are collapsed to about half a
//   bar, so a weekend costs the space of half a bar, not of two days.
// - **Which bar the first label sits on** is a wall-clock question, answered by
//   aligning to the nearest step boundary so labels read as 10:00 rather than 10:07.
//   Alignment only moves the phase. It can never change the spacing, because the phase
//   is snapped once and the step is counted in bars from there.

import { barsBeforeSlotExtended, modalInterval, slotAtIndex } from './sessionScale.js';
import { slotForIndex } from './coordinates.js';

/**
 * Smallest gap between two time labels, in CSS pixels.
 *
 * The same target the loop used before it moved here. A label is roughly 60-70px of
 * text at 11px, so 96 leaves a visible gap rather than two labels nearly touching.
 */
export const DEFAULT_MIN_LABEL_PX = 96;

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Rungs of the alignment ladder, ascending, in milliseconds.
 *
 * Deliberately not a 1/2/5 ladder: those are for magnitudes, and time is a calendar
 * rather than a number. Nobody labels a chart 03:00, 06:00, 09:00 because three is a
 * power of ten, and a 7-day rung is here because "one week" is a thing a trader reads
 * off an axis in a way that "168 hours" is not.
 *
 * Past a week the rungs stop being durations and become *nominal*: a 30-day rung is
 * there so a daily chart can space its labels a month apart, not to place one on the
 * 1st. Only the bar count is taken from them — `round(rung / interval)` — and the label
 * is then snapped to a real bar, so a "monthly" label on a daily series is every 30
 * *trading* days rather than a calendar date the market was shut on. That is the
 * deliberate trade: true month boundaries need a trading calendar, which is per-exchange
 * and per-holiday and would be wrong the day a holiday moved, and a label every 30 bars
 * that is always a real candle is worth more than a label on the 1st that sometimes has
 * to be invented. Without these rungs a daily chart has nothing coarser than a week to
 * choose from, and puts 129 labels in a plot that has room for ten.
 */
const TICK_LADDER: readonly number[] = [
    SECOND_MS,
    5 * SECOND_MS,
    15 * SECOND_MS,
    30 * SECOND_MS,
    MINUTE_MS,
    2 * MINUTE_MS,
    5 * MINUTE_MS,
    10 * MINUTE_MS,
    15 * MINUTE_MS,
    30 * MINUTE_MS,
    HOUR_MS,
    2 * HOUR_MS,
    4 * HOUR_MS,
    6 * HOUR_MS,
    12 * HOUR_MS,
    DAY_MS,
    7 * DAY_MS,
    14 * DAY_MS,
    30 * DAY_MS,
    91 * DAY_MS,
    182 * DAY_MS,
    365 * DAY_MS,
];

/** One label on the time axis. */
export interface TimeAxisTick {
    /**
     * Ordinal of the candle this label belongs to, clamped to the series.
     *
     * Out of series it names no candle — see `slot` and `time`, which are what a label
     * is actually drawn from. Kept because a caller reading the tick list wants the
     * ordinal where there is one, and clamping rather than going negative keeps every
     * reader's index arithmetic in range.
     */
    index: number;
    /**
     * That candle's own timestamp, so a caller need not look it up to format it.
     *
     * Extrapolated from the nearest real candle by the series' own bar interval when
     * the tick is out of series, so it keeps advancing instead of repeating the last
     * candle's time across the empty space.
     */
    time: number;
    /**
     * Where the label belongs, in **slot** space, and what both the grid line and the
     * text are drawn from.
     *
     * Additive, and the reason an axis can describe a region with no candles. A slot
     * rather than an index because "index 340" names no position once the series has
     * 300 candles and a break in it — the distance from bar 300 to bar 301 is not a
     * number of bars. Inside the series this is exactly what `indexToCoordinate` would
     * have returned for `index`, so existing charts are unaffected; it is carried
     * explicitly because the alternative was to ask `indexToCoordinate` for a position,
     * and that clamps the index to the slot table, which is what collapsed every
     * out-of-series tick onto the newest candle.
     */
    slot: number;
}

/** How much of a timestamp a time-axis label spells out. */
export type TimeAxisDetail = 'minute' | 'day' | 'month';

/**
 * The detail a visible span calls for.
 *
 * A function of the span alone so the axis and anything else labelling the same span
 * cannot pick different levels, and so the choice is testable without a renderer.
 */
export function timeAxisDetail(firstTime: number, lastTime: number): TimeAxisDetail {
    const span: number = Math.abs(lastTime - firstTime);
    if (!Number.isFinite(span)) return 'minute';
    if (span < 2 * DAY_MS) return 'minute';
    if (span < 365 * DAY_MS) return 'day';
    return 'month';
}

/** One drawn label on the time axis. */
export interface TimeAxisLabel {
    /** Slot this label belongs on, carried from the tick so the two cannot disagree. */
    slot: number;
    /** The text to draw. Narrower than the full form whenever `major` is false. */
    text: string;
    /**
     * Whether this label carries the coarse part of the timestamp — the date on a
     * minute-level axis, the month on a day-level one, the year on a month-level one.
     *
     * Every label used to carry it, so a five-minute chart read
     * `Sep 1, 09:35 AM  Sep 1, 09:40 AM  Sep 1, 09:45 AM` and, being far too wide for
     * the space between labels, overlapped itself into an unreadable row of clipped
     * half-dates. Only a label that changes the coarse part needs to say it; the ones
     * between it are unambiguous beside it, and a reader scanning left to right gets the
     * date from the label that introduced it.
     */
    major: boolean;
}

export interface TimeAxisLabelsInput {
    /** Ticks from `timeAxisTicks`, in order. */
    ticks: readonly TimeAxisTick[];
    /** BCP 47 locale, as `options.locale`. */
    locale: string;
    /** IANA time zone, as `options.timeZone`. */
    timeZone: string;
    /** How much of a timestamp to spell out. */
    detail: TimeAxisDetail;
}

/**
 * The labels for a tick list, each already chosen in its full or short form.
 *
 * The first label is always full, whatever else is true of it, so a view that opens on
 * the middle of a day still says what day it is. After that a label is full only where
 * the coarse part changes. Nothing is dropped here — a caller still gets one label per
 * tick, in order — because deciding which of them would *collide* needs text widths, and
 * a width is a renderer fact.
 *
 * The group key is read through `Intl` in the configured time zone rather than by
 * dividing epoch milliseconds, because "the same day" is a calendar question in the
 * reader's zone and not an arithmetic one: 23:00 and 01:00 either side of a UTC midnight
 * are the same day in London and different days in New York.
 */
export function timeAxisLabels(input: TimeAxisLabelsInput): TimeAxisLabel[] {
    const { ticks, locale, timeZone, detail } = input;
    if (ticks.length === 0) return [];
    const full: Intl.DateTimeFormat = new Intl.DateTimeFormat(locale, fullDetailOptions(detail, timeZone));
    const short: Intl.DateTimeFormat = new Intl.DateTimeFormat(locale, shortDetailOptions(detail, timeZone));
    const group: Intl.DateTimeFormat = new Intl.DateTimeFormat(locale, groupOptions(detail, timeZone));

    const labels: TimeAxisLabel[] = [];
    let previousGroup: string | null = null;
    for (const tick of ticks) {
        const date: Date = new Date(tick.time);
        const key: string = group.format(date);
        const major: boolean = previousGroup === null || key !== previousGroup;
        labels.push({ slot: tick.slot, text: (major ? full : short).format(date), major });
        previousGroup = key;
    }
    return labels;
}

function fullDetailOptions(detail: TimeAxisDetail, timeZone: string): Intl.DateTimeFormatOptions {
    if (detail === 'minute') {
        return { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone };
    }
    if (detail === 'day') return { month: 'short', day: '2-digit', timeZone };
    return { year: 'numeric', month: 'short', timeZone };
}

function shortDetailOptions(detail: TimeAxisDetail, timeZone: string): Intl.DateTimeFormatOptions {
    // The short form drops exactly the part a neighbouring major label already carries.
    if (detail === 'minute') return { hour: '2-digit', minute: '2-digit', timeZone };
    if (detail === 'day') return { day: '2-digit', timeZone };
    return { month: 'short', timeZone };
}

function groupOptions(detail: TimeAxisDetail, timeZone: string): Intl.DateTimeFormatOptions {
    // The unit the short form drops, so a label is major exactly when dropping its date
    // would have lost information.
    if (detail === 'minute') return { year: 'numeric', month: '2-digit', day: '2-digit', timeZone };
    if (detail === 'day') return { year: 'numeric', month: '2-digit', timeZone };
    return { year: 'numeric', timeZone };
}

export interface TimeAxisTicksInput {
    /** Retained candle timestamps, ascending. */
    times: readonly number[];
    /** Cumulative slot offsets, or null when the series has no breaks. */
    slots: Float64Array | null;
    /** Slot at the plot's left edge. */
    fromSlot: number;
    /** Slot at the plot's right edge. */
    toSlot: number;
    /** CSS pixels the labels are spread across. */
    widthPx: number;
    /** Smallest CSS pixel gap between two labels. */
    minLabelPx?: number;
    /**
     * The modal bar interval in ms, if the caller already knows it.
     *
     * `timeAxisTicks` runs on every rendered frame, and it needs this to pick a
     * step from the calendar ladder. Left to itself it derived the interval by
     * building an `(n-1)`-element array of every gap in the retained series and
     * sorting it — an O(n log n) sort of a million boxed doubles, on every pan,
     * zoom, append, resize, and crosshair frame, at the default retention of
     * 1,000,000 candles.
     *
     * The value only changes when the timestamps do, so a caller that owns the
     * timestamps should own the interval too and pass it down. Omit it and the
     * derivation still runs, which is correct and slow; that is the trade, and it
     * is the right one for a pure function called from a test.
     */
    interval?: number;
}

/**
 * The visible tick sequence for the time axis, ascending, possibly empty.
 *
 * Empty only when there is no data. There is deliberately no case where the window
 * holds bars and the answer comes back empty: the alignment phase is dropped rather
 * than allowed to starve the axis, because an axis with one label or none is a worse
 * failure than labels that are a few minutes off the hour.
 */
export function timeAxisTicks(input: TimeAxisTicksInput): TimeAxisTick[] {
    const times: readonly number[] = input.times;
    const slots: Float64Array | null = input.slots;
    const count: number = times.length;
    if (count === 0) return [];

    const minLabelPx: number = Number.isFinite(input.minLabelPx as number) && (input.minLabelPx as number) > 0
        ? (input.minLabelPx as number)
        : DEFAULT_MIN_LABEL_PX;
    const widthPx: number = Number.isFinite(input.widthPx) && input.widthPx > 0 ? input.widthPx : 0;

    // Bars, from bars. `barsBeforeSlot` rather than `indexAtSlot` because a bar whose
    // left edge is exactly on the right edge is not visible, and the pixel budget
    // below is only right if the window is the set of bars actually on screen.
    //
    // The window is the **slot** range on screen, and it is deliberately not clamped to
    // the series. Clamping is what stopped the axis at the newest candle: a window
    // running fifty slots past the last bar produced exactly the same ticks as one
    // stopping at it, so the empty space a caller had deliberately parked the view in
    // had no labels and no grid lines, and the horizontal lines that come from the price
    // scale ran the full width regardless. The cells never closed out there. An index
    // outside the series is a position on the same axis, so it is stepped through like
    // any other and its time extrapolated.
    const first: number = barsBeforeSlotExtended(slots, input.fromSlot, count);
    const last: number = barsBeforeSlotExtended(slots, input.toSlot, count);
    if (last < first) return [];

    const barsVisible: number = last - first + 1;
    // At least one label, so a plot too narrow for the target spacing still labels the
    // bars it is showing rather than going blank.
    const budget: number = Math.max(1, Math.floor(widthPx / minLabelPx));

    // The caller's value when it has one. `?? ` rather than a truthiness test,
    // because an interval of 0 is a real answer — a series whose bars all share a
    // timestamp — and it has to suppress the ladder rather than fall through to a
    // derivation that would produce the same 0 anyway.
    const interval: number = input.interval !== undefined && Number.isFinite(input.interval)
        ? input.interval
        : modalInterval(times);
    // Without an interval there is no duration to align to, so the ladder cannot be
    // consulted and the step is whatever the pixel budget asks for. A one-bar or
    // all-identical-times series lands here.
    const step: TickStep = interval > 0
        ? chooseTickStep(barsVisible, interval, budget)
        : { bars: Math.max(1, Math.ceil(barsVisible / budget)), ms: 0 };
    //
    // The *phase* comes from the part of the window that overlaps real candles, because
    // alignment is a wall-clock question and a wall clock needs real timestamps. The
    // *start* comes from the window itself, stepped to the same congruence class as the
    // anchor. Keeping the two apart is what lets a window reach past either end of the
    // data and still come out on round times: anchoring on the overlap and looping from
    // there would emit a label for every bar between the anchor and the window edge —
    // hundreds of off-screen ones for a window scrolled into the empty space — and
    // anchoring on the window directly would have nothing to align to.
    const overlapFirst: number = Math.max(0, Math.min(count - 1, first));
    const overlapLast: number = Math.max(0, Math.min(count - 1, last));
    const hasOverlap: boolean = overlapLast >= overlapFirst;
    const anchor: number = pickAnchor(
        times,
        hasOverlap ? overlapFirst : 0,
        hasOverlap ? overlapLast : count - 1,
        step.ms,
        step.bars,
    );
    // Non-negative modulo, because the window can start before the anchor when the window
    // reaches back past the oldest candle and the two are unrelated integers otherwise.
    const phase: number = (((anchor - first) % step.bars) + step.bars) % step.bars;
    const start: number = first + phase;

    const ticks: TimeAxisTick[] = [];
    for (let index = start; index <= last; index += step.bars) {
        ticks.push({
            index: Math.max(0, Math.min(count - 1, index)),
            time: timeAtIndex(times, index, count, interval),
            slot: tickSlot(slots, index, count),
        });
    }
    return ticks;
}

/**
 * The slot a tick's index sits on, matching what `indexToCoordinate` would have said.
 *
 * Inside the series this is `slotAtIndex` verbatim, so an existing chart's labels and
 * grid lines land on exactly the pixel they did before — the field is carried so a
 * *rendering* path can use it, not to change where anything is. Outside it, the index
 * axis continues at one bar per slot, which is the only continuation that matches how
 * the bars inside are spaced.
 */
function tickSlot(slots: Float64Array | null, index: number, count: number): number {
    if (index >= 0 && index < count) return slotAtIndex(slots, index);
    return slotForIndex(slots, index, count);
}

/**
 * The timestamp at an index, extrapolated past either end of the series.
 *
 * A label's whole job is to name an instant, and out there is no candle to ask. Carrying
 * the last candle's own time forward would put a column of identical labels in the empty
 * space, which is the same repetition the in-series labels had and the reason they are
 * compacted — so the series' own modal bar interval is the extrapolation, and the labels
 * keep advancing at the rate the bars do.
 */
function timeAtIndex(
    times: readonly number[],
    index: number,
    count: number,
    interval: number,
): number {
    if (index >= 0 && index < count) return times[index];
    // No interval to extrapolate by means no honest answer, so the nearest real candle's
    // time is the least-wrong one and is at least stable rather than NaN.
    if (!(interval > 0)) return times[index >= count ? count - 1 : 0];
    return times[index >= count ? count - 1 : 0] + (index >= count ? index - count + 1 : index) * interval;
}

/** A label every `bars` bars, on a `ms` boundary where one is meaningful. */
interface TickStep {
    bars: number;
    ms: number;
}

/**
 * The rung of the ladder that puts the label count closest to the pixel budget.
 *
 * The rung is chosen first and the bar step is derived from it, never the other way
 * round. That direction is the whole reason labels land on round times: if the bar step
 * came from the pixel budget and the rung only set a phase, a 14-bar step under a
 * 10-minute rung produces 14:30, 14:44, 14:58 — aligned at the front and nowhere else,
 * which reads worse than no alignment at all. One rung, one step, every label on a
 * boundary.
 *
 * Counting each rung's labels rather than snapping the target up or down is what keeps
 * the budget honest. A ladder is coarse by nature — the gap between a 15-minute rung
 * and a 30-minute rung is a factor of two — so whichever end one snaps to, some target
 * lands badly. Choosing by the resulting count makes that a non-issue, and the tie-break
 * prefers the sparser axis, because a sparse axis reads as deliberate and a dense one
 * reads as noise.
 */
export function chooseTickStep(
    barsVisible: number,
    interval: number,
    budget: number,
): TickStep {
    let best: TickStep | null = null;
    let bestCount: number = 0;
    for (const rung of TICK_LADDER) {
        const bars: number = Math.max(1, Math.round(rung / interval));
        const count: number = Math.ceil(barsVisible / bars);
        if (best === null || closerTo(count, budget, bestCount) || (count === bestCount && bars > best!.bars)) {
            best = { bars, ms: rung };
            bestCount = count;
        }
    }
    // The ladder cannot be empty, but a caller with a nonsense interval should still get
    // an answer rather than a null to dereference.
    if (best === null) return { bars: Math.max(1, Math.ceil(barsVisible / Math.max(budget, 1))), ms: 0 };
    // With one bar per label there is nothing to align: every label is its own bar, and
    // a boundary phase would only decide which of them is called the first.
    if (best.bars < 2) return { bars: best.bars, ms: 0 };
    return best;
}

/** Whether `count` is a better answer than `best` for a target of `budget`. */
function closerTo(count: number, budget: number, best: number): boolean {
    const distance: number = Math.abs(count - budget);
    const bestDistance: number = Math.abs(best - budget);
    if (distance !== bestDistance) return distance < bestDistance;
    return count < best;
}

/**
 * The first bar to label: the first one on or after a step boundary, or the first
 * visible bar when aligning would starve the axis.
 *
 * Forward from the boundary rather than nearest to it, for a reason that only shows up
 * on real data: a bar can sit a minute either side of the boundary, and a nearest-bar
 * snap then alternates between the two sides of it, putting two labels on one bar and
 * skipping the next. Snapping forward is monotonic in the boundary, so the label
 * sequence stays monotonic in the bar index.
 *
 * The count guard is the other half. Alignment is a phase, and a phase can fall
 * entirely outside the window — epoch-day boundaries on a series that trades 09:30 to
 * 16:00 are the obvious case. One label is a valid answer for a window that holds one
 * bar and an obviously broken answer for a window of four hundred, so the phase is only
 * kept when it yields at least two.
 */
function pickAnchor(
    times: readonly number[],
    first: number,
    last: number,
    stepMs: number,
    stepBars: number,
): number {
    if (!(stepMs > 0) || stepBars < 1) return first;
    const boundary: number = Math.ceil(times[first] / stepMs) * stepMs;
    const anchor: number = firstBarAtOrAfter(times, first, last, boundary);
    if (anchor > last) return first;
    if (last > first && Math.floor((last - anchor) / stepBars) < 1) return first;
    return anchor;
}

/** Index of the first bar in `[from, to]` whose time is at or after `time`, or `to + 1`. */
function firstBarAtOrAfter(
    times: readonly number[],
    from: number,
    to: number,
    time: number,
): number {
    let low: number = from;
    let high: number = to + 1;
    while (low < high) {
        const middle: number = (low + high) >>> 1;
        if (times[middle] < time) low = middle + 1;
        else high = middle;
    }
    return low;
}
