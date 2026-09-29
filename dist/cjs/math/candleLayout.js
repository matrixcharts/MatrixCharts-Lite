"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANDLE_VOLUME = exports.CANDLE_WIDTH = exports.CANDLE_CLOSE = exports.CANDLE_LOW = exports.CANDLE_HIGH = exports.CANDLE_OPEN = exports.CANDLE_X = exports.CANDLE_STRIDE = void 0;
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
exports.CANDLE_STRIDE = 7;
/** Ordinal index of the record, in source-space candle units. */
exports.CANDLE_X = 0;
/** Opening price. */
exports.CANDLE_OPEN = 1;
/** Highest price; the maximum across an aggregated group. */
exports.CANDLE_HIGH = 2;
/** Lowest price; the minimum across an aggregated group. */
exports.CANDLE_LOW = 3;
/** Closing price. */
exports.CANDLE_CLOSE = 4;
/** Relative body width; the sum across an aggregated group. */
exports.CANDLE_WIDTH = 5;
/**
 * Traded volume; the sum across an aggregated group. A candle with no volume is
 * stored as 0, so an absent value and a genuine zero are indistinguishable in the
 * record. That is deliberate: both mean "nothing to draw", and the histogram is
 * opt-in.
 */
exports.CANDLE_VOLUME = 6;
