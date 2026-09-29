/**
 * Horizontal candlestick layout.
 *
 * Industry comparisons (readable zoom, ~6–12 CSS px per bar):
 * - TradingView Lightweight Charts: default barSpacing = 6; body trends to ~80% of the slot.
 * - Highcharts Stock: default pointPadding ≈ 0.1 → about 80% body / 20% gap.
 * - SciChart examples: dataPointWidth = 0.7 → 70% body / 30% gap.
 *
 * Authoritative plates need both a blocky body and a visible gutter. That is not a fill-ratio
 * fight: it is pixels-per-bar. At 14 CSS px/bar and ~75% fill the body is ~9 device pixels
 * with a 4–5px gutter. The previous 83% fill plus per-edge rounding often collapsed the gap
 * and stole a pixel from the body.
 */
export declare const DEFAULT_CANDLE_SPACING_PX: number;
export declare function candlestickBodyWidthDevicePixels(barSpacingCss: number, pixelRatio: number): number;
export declare function candlestickBodyEdgesData(centerDataX: number, barSpacingData: number, scaleX: number, offsetX: number, pixelRatio: number): {
    left: number;
    right: number;
};
//# sourceMappingURL=candlestickBodyWidth.d.ts.map