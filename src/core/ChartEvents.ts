// src/core/ChartEvents.ts
//
// Public event payloads for v1. These are a frozen contract: fields are only
// added, never removed or repurposed.

import type { CandleData } from './CandleData.js';
import type { LogicalRange, TimeRange } from './coordinates.js';

/** Cancels a subscription. Safe to call more than once. */
export type Unsubscribe = () => void;

/**
 * The pointer is over a candle. `x` is snapped to that candle's centre, so a
 * tooltip can be positioned directly at the crosshair; `y` is the raw pointer
 * position, so the price readout tracks the cursor.
 */
export interface CrosshairData {
    /** CSS x within the container, snapped to the candle centre. */
    x: number;
    /** CSS y within the container, following the pointer. */
    y: number;
    /** Ordinal candle index. Always in `[0, getCandleCount())`. */
    index: number;
    /** Candle timestamp in epoch milliseconds. */
    time: number;
    /** Price at `y` on the current vertical scale. */
    price: number;
    /** The candle under the pointer. */
    candle: CandleData;
}

/**
 * There is no candle under the pointer: the pointer left the container, a drag
 * or pinch is in progress, the chart has no data, or `x` is past the series.
 * Discriminated by `candle === null`.
 */
export interface CrosshairCleared {
    x: null;
    y: null;
    /** `-1` when there is no candle. */
    index: -1;
    time: null;
    price: null;
    candle: null;
}

export type CrosshairMoveEvent = CrosshairData | CrosshairCleared;

/** A click that was not a pan. Same payload as `CrosshairMoveEvent` plus the button. */
export type ChartClickEvent = (CrosshairData | CrosshairCleared) & { button: number };

/**
 * The visible candle range changed. Fires at most once per animation frame and
 * not at all when the visible bars and bar spacing are unchanged, so a drag
 * inside one bar's width produces no events.
 */
export interface VisibleRangeEvent {
    /** Half-open candle index range, `[from, to)`. */
    logical: LogicalRange;
    /** Epoch ms of the first and last visible candle, or `null` when empty. */
    time: TimeRange | null;
    /** CSS pixels per candle index. */
    barSpacing: number;
}

/**
 * A pane's vertical range changed. Fires at most once per animation frame, and not
 * at all for a pane whose range did not actually change.
 *
 * Its own event rather than a field on `VisibleRangeEvent`, and that is the point of
 * three decisions:
 *
 * - `VisibleRangeEvent` is a frozen contract described as being about the visible
 *   *candles* and the bar spacing. Adding a vertical range would give one subscription
 *   two unrelated meanings and two different reasons to be silent, under a name that
 *   describes neither.
 * - The internal `viewport` broadcast is not public and carries `slots` plus every
 *   pane's transform. Publishing it would hand integrators the affine transform itself
 *   — the one part of the engine that has been rewritten three times, from index space
 *   to slot space, with a log-axis conversion and an inversion sign convention. A
 *   contract should carry the values a caller acts on, not how the pixels get there.
 * - It fires on every pan and every append, so anything bound to it re-renders on
 *   every pointer move. This one is quiet when nothing vertical moved, which on a live
 *   feed is most frames.
 *
 * Deduplicated per pane, so a readout of one oscillator's bounds is not woken by the
 * price pane's fit wobbling. A locked pane is silent unless its range genuinely
 * changed, which is the case a caller cares about: a trader stretching an axis by hand.
 */
export interface PaneRangeEvent {
    /** Index of the pane whose range changed. `0` is the price pane. */
    pane: number;
    /**
     * What the pane now shows, low first, in that pane's own units: prices for pane 0,
     * indicator values for the rest. Never inverted and never in scale space, so a log
     * price pane reports prices rather than logs.
     */
    range: readonly [number, number];
}
