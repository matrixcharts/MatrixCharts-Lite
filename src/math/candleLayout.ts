/**
 * The interleaved candle record shared by the pyramid, the downsampler, the chart
 * and the data renderer. Every level of the pyramid uses this same layout, so a
 * level is a plain `Float32Array` of `CANDLE_STRIDE`-float records:
 *
 *   [x, open, high, low, close, width]
 *
 * `x` is the source-space ordinal index rather than a pixel or a timestamp, and
 * `width` is a relative weight that aggregation sums, not a pixel width. Neither
 * is a data channel: the only data channel is price, carried by the four price
 * fields. A new channel, such as volume, is appended as a further field and its
 * aggregate rule added alongside the ones in `LTTBDownsampler`.
 *
 * The stride is named rather than written inline because a bare `6` appears in
 * every length calculation, slice, and channel read across the data path, where
 * mistaking it for an unrelated `6` — the renderer's GPU vertex stride, which is
 * also six floats — silently reads the wrong field.
 */
export const CANDLE_STRIDE: number = 6;

/** Ordinal index of the record, in source-space candle units. */
export const CANDLE_X: number = 0;
/** Opening price. */
export const CANDLE_OPEN: number = 1;
/** Highest price; the maximum across an aggregated group. */
export const CANDLE_HIGH: number = 2;
/** Lowest price; the minimum across an aggregated group. */
export const CANDLE_LOW: number = 3;
/** Closing price. */
export const CANDLE_CLOSE: number = 4;
/** Relative body width; the sum across an aggregated group. */
export const CANDLE_WIDTH: number = 5;
