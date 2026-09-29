/** How a price maps to a position on the vertical axis. */
export type PriceScale = 'linear' | 'log';
/**
 * Lowest price a log axis will show.
 *
 * Log is undefined at and below zero, so a log pane has to decide what a zero or
 * negative price means. Clamping is the answer, not dropping the bar: the bar still
 * exists and still has a high and a low, it simply has no position on this axis, and
 * pinning it to the floor makes that visible rather than silently omitting it.
 */
export declare const LOG_PRICE_FLOOR = 1e-9;
/** Price to the value the affine transform actually operates on. */
export declare function toScaleSpace(price: number, scale: PriceScale): number;
/** The inverse. `fromScaleSpace(toScaleSpace(p))` round-trips for positive prices. */
export declare function fromScaleSpace(value: number, scale: PriceScale): number;
/** Whether a price has a position on this axis at all. */
export declare function isRepresentable(price: number, scale: PriceScale): boolean;
/**
 * The price range a pane should fit on this scale, with non-positive prices
 * excluded.
 *
 * Excluding rather than clamping, because the *range* is a different question from
 * the position: a pane whose range is floored at 1e-9 would have every real price
 * crushed into the top pixel. So a linear pane fits a zero bar at zero, and a log
 * pane fits only the bars that have a position on it.
 */
export declare function representableRange(minimum: number, maximum: number, scale: PriceScale): [number, number] | null;
/** A tick value, and the price it labels. */
export interface Tick {
    /** Position on the axis, in scale space. */
    value: number;
    /** The price a reader sees. */
    price: number;
}
/**
 * Round ticks for a linear axis: whole multiples of a 1/2/5 step.
 *
 * The step is chosen from a target *count* rather than a pixel separation, so the
 * same function serves the price axis, a pane's own axis, and the time axis that
 * follows, instead of each working out its own arithmetic.
 */
export declare function linearTicks(minimum: number, maximum: number, targetCount: number, minStep?: number): Tick[];
/**
 * Round ticks for a log axis: 1, 2 and 5 within each decade.
 *
 * 1-2-5 in *price* space, not in log space. Stepping a log axis by a round number
 * of log units gives 1, 2, 5 decades apart and labels the axis 2.7, 7.4, 148, which
 * is not a set of numbers anyone reads prices in.
 */
export declare function logTicks(minimum: number, maximum: number, targetCount: number): Tick[];
/** Ticks for whichever scale is in use. */
export declare function priceTicks(minimum: number, maximum: number, scale: PriceScale, targetCount: number, minStep?: number): Tick[];
