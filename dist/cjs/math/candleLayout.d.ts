/**
 * The interleaved candle record shared by the pyramid, the downsampler, the chart
 * and the data renderer. Every level of the pyramid uses this same layout, so a
 * level is a plain `Float32Array` of `CANDLE_STRIDE`-float records:
 *
 *   [x, open, high, low, close, width, volume]
 *
 * `x` is the source-space ordinal index rather than a pixel or a timestamp, and
 * `width` is a relative weight that aggregation sums, not a pixel width. Neither
 * is a data channel. The data channels are price, carried by the four price
 * fields, and `volume`, which is summed across an aggregated group because a
 * bucket's traded size is the total of its members.
 *
 * The stride is named rather than written inline because a bare `7` would appear
 * in every length calculation, slice, and channel read across the data path,
 * where mistaking it for an unrelated `6` — the renderer's GPU vertex stride,
 * which is also six floats — silently reads the wrong field.
 */
export declare const CANDLE_STRIDE: number;
/** Ordinal index of the record, in source-space candle units. */
export declare const CANDLE_X: number;
/** Opening price. */
export declare const CANDLE_OPEN: number;
/** Highest price; the maximum across an aggregated group. */
export declare const CANDLE_HIGH: number;
/** Lowest price; the minimum across an aggregated group. */
export declare const CANDLE_LOW: number;
/** Closing price. */
export declare const CANDLE_CLOSE: number;
/** Relative body width; the sum across an aggregated group. */
export declare const CANDLE_WIDTH: number;
/**
 * Traded volume; the sum across an aggregated group. A candle with no volume is
 * stored as 0, so an absent value and a genuine zero are indistinguishable in the
 * record. That is deliberate: both mean "nothing to draw", and the histogram is
 * opt-in.
 */
export declare const CANDLE_VOLUME: number;
