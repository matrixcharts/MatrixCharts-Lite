// src/core/coordinates.ts
//
// Slot helpers come from the session model. They are null-tolerant: a null slot
// array means the identity, so an unbroken chart takes the path it always took.
import { barsBeforeSlot, indexAtSlot, slotAtIndex } from './sessionScale.js';

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
    /** Screen x of slot 0. */
    offsetX: number;
    /** Screen y of price 0. */
    offsetY: number;
    /**
     * CSS pixels per slot.
     *
     * A bar is one slot wide, so for an unbroken series this is the pixels per bar
     * and every number in the API keeps its meaning. Where a session break adds
     * slots, it is still the bar spacing; the break occupies slots of its own rather
     * than pushing later bars along, so panning and zooming stay in the units the
     * caller configured them in.
     */
    scaleX: number;
    /** CSS pixels per price unit. Negative: price grows upward. */
    scaleY: number;
    /** Container width in CSS pixels. */
    cssWidth: number;
    /** Container height in CSS pixels. */
    cssHeight: number;
    /** Region series occupy, inside the container. */
    plot: PlotRect;
    /**
     * Slot offset of every bar, or null when the series has no session breaks.
     *
     * Null is the identity rather than a special case, so an unbroken chart is
     * bit-for-bit the transform that shipped for six phases and no existing caller
     * has to know slots exist.
     */
    slots: Float64Array | null;
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
    return viewport.offsetX + slotAtIndex(viewport.slots, index) * viewport.scaleX;
}

/**
 * Fractional slot position at a screen x.
 *
 * Slot rather than index, and that is the whole reason the axis has two units. A
 * fractional index is only meaningful while bars are evenly spaced; with a break in
 * the series, "index 20.4" names no position at all, whereas slot 20.4 is exactly
 * where the pixel is.
 */
export function coordinateToSlot(viewport: ChartViewport, coordinateX: number): number {
    return (coordinateX - viewport.offsetX) / viewport.scaleX;
}

/**
 * Index of the bar at a screen x.
 *
 * A whole index, not a fraction. With session breaks there is no such thing as a
 * fractional index — the gap between bar 20 and bar 21 is not a number of bars — so
 * every caller that used to read a fraction here wanted a bar, and the two that did
 * not have been relying on it to pick a bucket, which the draw range gives directly.
 */
export function coordinateToIndex(viewport: ChartViewport, coordinateX: number): number {
    return indexAtSlot(viewport.slots, coordinateToSlot(viewport, coordinateX));
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
 * Selection is by distance along the axis, so a bar is picked the same way whether or
 * not the series has gaps.
 */
export function nearestCandleIndex(
    viewport: ChartViewport,
    coordinateX: number,
    candleCount: number,
): number {
    if (candleCount <= 0) return -1;
    // Rounded here rather than left to the lookup, because "nearest" is a rounding
    // and the axis a bar sits on is not a uniform index spacing once gaps are in it.
    return clampCandleIndex(
        Math.round(indexAtSlot(viewport.slots, coordinateToSlot(viewport, coordinateX))),
        candleCount,
    );
}

/** Visible candle indices, partial bars included, clamped to the series. */
export function visibleLogicalRange(viewport: ChartViewport, candleCount: number): LogicalRange {
    if (candleCount <= 0) return { from: 0, to: 0 };

    // Both ends are clamped in *slot* space and the fully-off cases are named
    // separately, because clamping an index throws away the one thing that matters
    // here: a plot scrolled off the left of the series and a plot whose left edge
    // rests on the first bar both clamp to index 0, and only one of them has a
    // visible bar. Clamping after the conversion makes the first report one.
    // Bars are positioned by their left edge and are one slot wide, so the last one
    // ends a slot after its own position. Comparing the left edge of the plot against
    // the last bar's *centre* instead would declare the series off-screen while that
    // bar was still fully visible.
    const lastSlot: number = slotAtIndex(viewport.slots, candleCount - 1);
    const lastRightSlot: number = lastSlot + 1;
    const leftSlot: number = coordinateToSlot(viewport, viewport.plot.x);
    const rightSlot: number = coordinateToSlot(viewport, viewport.plot.x + viewport.plot.width);
    if (rightSlot <= 0) return { from: 0, to: 0 };
    if (leftSlot >= lastRightSlot) return { from: candleCount, to: candleCount };

    // `from` is the last bar whose left edge is at or before the plot's left edge, so
    // a bar clipped in half still counts. `to` is the count of bars whose left edge is
    // at or before the right edge, so a bar ending exactly *on* the right edge is not
    // counted — it has no width on screen. The two ends genuinely want different
    // roundings, which is why one is an index and the other a count.
    const from: number = Math.max(
        0,
        Math.min(
            candleCount,
            Math.floor(indexAtSlot(viewport.slots, Math.max(0, leftSlot))),
        ),
    );
    const to: number = Math.max(
        from,
        Math.min(candleCount, barsBeforeSlot(viewport.slots, Math.min(rightSlot, lastRightSlot))),
    );
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
export function liveEdgeOffsetX(
    plotRightEdge: number,
    slots: Float64Array | null,
    candleCount: number,
    scaleX: number,
): number {
    // The last bar's *slot*, not its index. On an unbroken series those are the same
    // number and this is the expression that shipped before slots; with a break in
    // the series, using the index would park the newest bar short of the edge by the
    // whole of the gap before it, which on a week of 1-minute bars is most of a
    // screen.
    const lastSlot: number = slotAtIndex(slots, candleCount - 1);
    return plotRightEdge - (lastSlot + LIVE_EDGE_INSET) * scaleX;
}

/** Whether a viewport is close enough to the live edge to keep following it. */
export function isAtLiveEdgeOffset(
    offsetX: number,
    scaleX: number,
    slots: Float64Array | null,
    candleCount: number,
    plotRightEdge: number,
): boolean {
    if (candleCount === 0) return true;
    const lastCandleX: number = offsetX + slotAtIndex(slots, candleCount - 1) * scaleX;
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
