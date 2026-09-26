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
export const DEFAULT_CANDLE_SPACING_PX: number = 14;

export function candlestickBodyWidthDevicePixels(barSpacingCss: number, pixelRatio: number): number {
    if (!(barSpacingCss > 0) || !(pixelRatio > 0) || !Number.isFinite(barSpacingCss) || !Number.isFinite(pixelRatio)) {
        return 1;
    }

    const spacingDevice: number = barSpacingCss * pixelRatio;
    const minGutter: number = spacingDevice >= 10
        ? Math.max(2, Math.round(pixelRatio * 2))
        : spacingDevice >= 4
            ? Math.max(1, Math.round(pixelRatio))
            : 0;
    const maxBody: number = Math.max(1, Math.floor(spacingDevice - minGutter));

    const reducingCoeff: number = 0.25;
    const wideFrom: number = 4;
    const coeff: number = 1 - (reducingCoeff * Math.atan(Math.max(wideFrom, barSpacingCss) - wideFrom)) / (Math.PI * 0.5);
    let width: number = Math.floor(barSpacingCss * coeff * pixelRatio);
    width = Math.min(maxBody, Math.max(1, width));

    const minBody: number = spacingDevice >= 12
        ? Math.min(maxBody, Math.max(7, Math.round(7 * pixelRatio)))
        : spacingDevice >= 6
            ? Math.min(maxBody, Math.max(5, Math.round(5 * pixelRatio)))
            : 1;
    width = Math.max(minBody, width);
    width = Math.min(maxBody, width);

    const wickWidth: number = Math.max(1, Math.floor(pixelRatio));
    if (width >= 2 && width % 2 !== wickWidth % 2) {
        width -= 1;
    }
    return Math.max(1, width);
}

export function candlestickBodyEdgesData(
    centerDataX: number,
    barSpacingData: number,
    scaleX: number,
    offsetX: number,
    pixelRatio: number,
): { left: number; right: number } {
    const pixelsPerData: number = scaleX * pixelRatio;
    const originPx: number = offsetX * pixelRatio;
    const spacingCss: number = barSpacingData * scaleX;
    const bodyWidthPx: number = candlestickBodyWidthDevicePixels(spacingCss, pixelRatio);
    const centerPx: number = centerDataX * pixelsPerData + originPx;
    const leftPx: number = Math.round(centerPx - bodyWidthPx / 2);
    const rightPx: number = leftPx + bodyWidthPx;
    return {
        left: (leftPx - originPx) / pixelsPerData,
        right: (rightPx - originPx) / pixelsPerData,
    };
}
