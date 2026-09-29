import type { CandleData } from './CandleData.js';
import type { LogicalRange, TimeRange } from './coordinates.js';
import type { OrderSide, OrderStatus, DrawingOrderEvent } from './tradingTools.js';
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
/** A semantic target under a CSS-pixel chart coordinate. */
export type HitTestResult = {
    kind: 'candle';
    index: number;
    time: number;
    candle: CandleData;
    price: number;
} | {
    kind: 'priceLine';
    id: string;
    price: number;
} | {
    kind: 'order';
    id: string;
    side: OrderSide;
    status: OrderStatus;
    price: number;
    quantity: number;
} | {
    kind: 'marker';
    index: number;
    time: number;
    price: number;
} | {
    kind: 'zone';
    id: string;
    fromIndex: number;
    toIndex: number | null;
    top: number;
    bottom: number;
};
/** A click that was not a pan. Same payload as `CrosshairMoveEvent` plus the button. */
export type ChartClickEvent = (CrosshairData | CrosshairCleared) & {
    button: number;
};
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
    /**
     * Whether the chart is following the newest candle, i.e. `chart.isAtRealtime()`.
     *
     * A live chart is right-anchored and scrolls leftward as bars arrive. Panning away
     * takes the view over: the feed keeps appending into a window the caller has claimed,
     * and from outside the chart that is indistinguishable from a feed that has stopped.
     * This is the field that tells the two apart, and it is the one a UI most needs — a
     * "LIVE" badge, a jump-to-latest button, a dimmed newest-price tag. Deriving it from
     * `logical` against `getCandleCount()` is a subtraction every caller has to remember
     * to do, and a caller that forgets sees a frozen chart and files a bug.
     *
     * It rides on the events that were already firing rather than adding any. The latch
     * only moves in `scrollToRealtime`, `fitContent` and a pan away from the edge, and
     * every one of those changes which bars are on screen, so there is no transition this
     * field can make that the event's own firing rule does not already cover. A chart with
     * no data reports `true`: there is no state to be behind.
     */
    atRealtime: boolean;
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
/**
 * A drawing or order interaction event.
 *
 * Covers the full lifecycle of drawings and orders: selection, creation, moves,
 * resizes, deletions, and order status transitions. A single subscription
 * receives all interaction events, so a UI layer can update its state from
 * one place rather than subscribing to each event type separately.
 */
export interface DrawingOrderInteractionEvent {
    /** The interaction that occurred. */
    type: DrawingOrderEvent['type'];
    /** ID of the drawing or order involved. */
    id: string;
    /** Timestamp of the event. */
    time: number;
    /** The full event payload. */
    detail: DrawingOrderEvent;
}
//# sourceMappingURL=ChartEvents.d.ts.map