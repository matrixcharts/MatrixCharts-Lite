// src/core/coordinates.ts
//
// Pure chart geometry in CSS pixels, shared by Chart, the axis renderer, and the
// public read API so those three can never disagree about what is on screen.
//
// Nothing here knows about devicePixelRatio. Renderers scale into the canvas
// backing store; every conversion below is CSS-pixel to CSS-pixel, so results
// are identical at dpr 1, 2, or 3.

/**
 * The rectangle series are drawn into, in CSS pixels relative to the canvas.
 *
 * The container size and the plot rect are deliberately separate. `cssWidth` and
 * `cssHeight` describe the canvas, which is also where axes, labels, and the
 * crosshair live; the plot rect describes the part of it that holds data. They
 * are equal only while the chart reserves nothing for the axes, which is the
 * current behaviour, so anything that must not spill into the axis gutters has
 * to read the plot rect rather than the canvas.
 */
export interface PlotRect {
    /** Left edge, CSS pixels from the canvas left. */
    x: number;
    /** Top edge, CSS pixels from the canvas top. */
    y: number;
    width: number;
    height: number;
}

/** A plot rect covering the whole canvas, ignoring any axis gutters. */
export function fullPlotRect(cssWidth: number, cssHeight: number): PlotRect {
    return { x: 0, y: 0, width: cssWidth, height: cssHeight };
}

/** Right edge of the plot area, in canvas coordinates. */
export function plotRight(viewport: ChartViewport): number {
    return viewport.plot.x + viewport.plot.width;
}

/** Horizontal centre of the plot area, the anchor for zoom and data reloads. */
export function plotCentreX(viewport: ChartViewport): number {
    return viewport.plot.x + viewport.plot.width / 2;
}

/** Spherical transform of the plot area, all values in CSS pixels. */
export interface ChartViewport {
    /** Screen x of logical index 0. */
    offsetX: number;
    /** Screen y of price 0. */
    offsetY: number;
    /** CSS pixels per candle index. */
    scaleX: number;
    /** CSS pixels per price unit. Negative: price grows upward. */
    scaleY: number;
    /** Container width in CSS pixels. */
    cssWidth: number;
    /** Container height in CSS pixels. */
    cssHeight: number;
    /** Region series occupy, inside the container. */
    plot: PlotRect;
}

/**
 * Half-open candle index range. Indices `from` through `to - 1` are on screen;
 * `from === to` means nothing is visible.
 */
export interface LogicalRange {
    from: number;
    to: number;
}

/**
 * Epoch-millisecond bounds of the visible candles. Both ends are inclusive and
 * name real candle timestamps, because a closed session has no end time to
 * report. `null` when no candle is visible.
 */
export interface TimeRange {
    from: number;
    to: number;
}

/**
 * Fraction of a bar the last candle is inset from the right edge when the chart
 * follows the live edge. The newest candle is centered half a bar inside the
 * plot area rather than flush against it.
 */
export const LIVE_EDGE_INSET = 0.5;

export function indexToCoordinate(viewport: ChartViewport, index: number): number {
    return viewport.offsetX + index * viewport.scaleX;
}

export function coordinateToIndex(viewport: ChartViewport, coordinateX: number): number {
    return (coordinateX - viewport.offsetX) / viewport.scaleX;
}

export function priceToCoordinate(viewport: ChartViewport, price: number): number {
    return viewport.offsetY + price * viewport.scaleY;
}

export function coordinateToPrice(viewport: ChartViewport, coordinateY: number): number {
    return (coordinateY - viewport.offsetY) / viewport.scaleY;
}

/** Clamps a fractional index to a whole candle index inside `[0, candleCount)`. */
export function clampCandleIndex(index: number, candleCount: number): number {
    return Math.max(0, Math.min(candleCount - 1, Math.round(index)));
}

/**
 * Index of the candle nearest a screen x. Returns -1 for an empty series.
 * Selection is by index distance, so a bar is picked the same way whether or not
 * the series has gaps.
 */
export function nearestCandleIndex(
    viewport: ChartViewport,
    coordinateX: number,
    candleCount: number,
): number {
    if (candleCount <= 0) return -1;
    return clampCandleIndex(coordinateToIndex(viewport, coordinateX), candleCount);
}

/** Visible candle indices, partial bars included, clamped to the series. */
export function visibleLogicalRange(viewport: ChartViewport, candleCount: number): LogicalRange {
    if (candleCount <= 0) return { from: 0, to: 0 };

    const firstPartial: number = coordinateToIndex(viewport, viewport.plot.x);
    const lastPartial: number = coordinateToIndex(
        viewport,
        viewport.plot.x + viewport.plot.width,
    );
    const from: number = Math.max(0, Math.min(candleCount, Math.floor(firstPartial)));
    const to: number = Math.max(from, Math.min(candleCount, Math.ceil(lastPartial)));
    return { from, to };
}

/** Inclusive price bounds of the plot area, low first. */
export function visiblePriceRange(viewport: ChartViewport): [number, number] {
    const priceAtTop: number = coordinateToPrice(viewport, viewport.plot.y);
    const priceAtBottom: number = coordinateToPrice(
        viewport,
        viewport.plot.y + viewport.plot.height,
    );
    return [Math.min(priceAtTop, priceAtBottom), Math.max(priceAtTop, priceAtBottom)];
}

/**
 * Bar spacings closer together than this count as unchanged. Guards against
 * float drift from repeated wheel and pinch arithmetic re-notifying listeners.
 */
export const BAR_SPACING_EPSILON = 1e-6;

/** The subset of viewport state a `visibleRangeChange` notification carries. */
export interface VisibleRangeSnapshot {
    logical: LogicalRange;
    barSpacing: number;
}

/**
 * Whether a new snapshot is worth notifying about. Indices are whole numbers, so
 * they compare exactly; bar spacing uses an epsilon.
 */
export function isSameVisibleRange(
    previous: VisibleRangeSnapshot | null,
    logical: LogicalRange,
    barSpacing: number,
): boolean {
    if (previous === null) return false;
    if (previous.logical.from !== logical.from || previous.logical.to !== logical.to) return false;
    return Math.abs(previous.barSpacing - barSpacing) < BAR_SPACING_EPSILON;
}

/**
 * Screen x that parks the newest candle at the live edge. The edge is the right
 * side of the plot rect, not of the canvas, and it is an absolute coordinate
 * rather than a width: a left gutter shifts the whole plot right, so passing a
 * width here would park the newest bar that many pixels short of the edge.
 */
export function liveEdgeOffsetX(plotRightEdge: number, candleCount: number, scaleX: number): number {
    return plotRightEdge - (candleCount - LIVE_EDGE_INSET) * scaleX;
}

/** Whether a viewport is close enough to the live edge to keep following it. */
export function isAtLiveEdgeOffset(
    offsetX: number,
    scaleX: number,
    candleCount: number,
    plotRightEdge: number,
): boolean {
    if (candleCount === 0) return true;
    const lastCandleX: number = offsetX + (candleCount - 1) * scaleX;
    const tolerance: number = Math.max(24, scaleX * 1.5);
    return lastCandleX >= plotRightEdge - tolerance && lastCandleX <= plotRightEdge + tolerance;
}

/**
 * Index of the candle whose timestamp is nearest `time`, searched over
 * `[start, count)`. This is the only place that maps a wall-clock time onto the
 * ordinal axis, so a gap between sessions can never be interpolated across.
 * Returns -1 for an empty range.
 */
export function nearestCandleIndexByTime(
    count: number,
    time: number,
    timeAt: (index: number) => number,
    start: number = 0,
): number {
    if (count <= start) return -1;

    let low: number = start;
    let high: number = count - 1;
    while (low < high) {
        const middle: number = (low + high) >>> 1;
        if (timeAt(middle) < time) low = middle + 1;
        else high = middle;
    }

    if (low === start) return start;
    const previous: number = low - 1;
    return Math.abs(timeAt(low) - time) < Math.abs(timeAt(previous) - time) ? low : previous;
}
