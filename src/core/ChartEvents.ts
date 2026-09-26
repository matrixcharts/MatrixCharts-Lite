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
