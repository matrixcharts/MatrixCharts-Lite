/**
 * Smallest gap between two time labels, in CSS pixels.
 *
 * The same target the loop used before it moved here. A label is roughly 60-70px of
 * text at 11px, so 96 leaves a visible gap rather than two labels nearly touching.
 */
export declare const DEFAULT_MIN_LABEL_PX = 96;
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
export declare function timeAxisDetail(firstTime: number, lastTime: number): TimeAxisDetail;
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
export declare function timeAxisLabels(input: TimeAxisLabelsInput): TimeAxisLabel[];
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
export declare function timeAxisTicks(input: TimeAxisTicksInput): TimeAxisTick[];
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
export declare function chooseTickStep(barsVisible: number, interval: number, budget: number): TickStep;
export {};
//# sourceMappingURL=timeAxis.d.ts.map