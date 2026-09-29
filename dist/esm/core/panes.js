// src/core/panes.ts
//
// Pure pane geometry in CSS pixels.
//
// A pane is a horizontal band of the plot area with its own vertical transform.
// Pane 0 is the price pane; anything a caller adds below it measures something
// other than price — an RSI, a MACD histogram — and therefore cannot share the
// price scale, or it would have to be squashed to fit the price range.
//
// All series still share the *horizontal* transform, because every series is
// indexed on the same time axis. Only the vertical one is per-pane, which is why
// a series can be moved to another pane without anything about its data changing.
/** The price pane's index. Every chart has one, and it is always first. */
export const PRICE_PANE = 0;
function fail(message) {
    throw new Error(`MatrixCharts: ${message}`);
}
/** Default pane options: one pane filling the plot, a hairline between panes. */
export const DEFAULT_PANE_OPTIONS = {
    weights: [1],
    separatorHeight: 1,
};
/**
 * Validates pane weights.
 *
 * Weights are rejected rather than coerced because a pane layout is something a
 * caller reads back and reasons about: a silently repaired weight produces a
 * chart that is not the one that was asked for, and the discrepancy is only
 * visible by looking at it.
 */
export function resolvePaneOptions(raw) {
    const separatorHeight = raw?.separatorHeight ?? DEFAULT_PANE_OPTIONS.separatorHeight;
    if (!Number.isFinite(separatorHeight) || separatorHeight < 0) {
        fail('panes.separatorHeight must be a non-negative, finite number of CSS pixels.');
    }
    const weights = raw?.weights;
    if (weights === undefined) {
        return { weights: [...DEFAULT_PANE_OPTIONS.weights], separatorHeight };
    }
    if (!Array.isArray(weights) || weights.length === 0) {
        fail('panes.weights must be a non-empty array, one weight per pane.');
    }
    for (let index = 0; index < weights.length; index++) {
        const weight = weights[index];
        if (!Number.isFinite(weight) || weight <= 0) {
            fail(`panes.weights[${index}] must be a finite number greater than zero.`);
        }
    }
    return { weights: weights.map((weight) => weight), separatorHeight };
}
/**
 * Splits the plot area into one rect per pane, top to bottom.
 *
 * Boundaries are accumulated once and each rect is derived from consecutive
 * boundaries, rather than each pane computing its own extent from its weight.
 * Accumulating separately is how a fractional weight leaves a one-pixel seam or
 * an overlap between two panes, and a seam is a stripe of background showing
 * through the middle of a chart.
 *
 * Boundaries are also snapped to whole CSS pixels, so a separator lands on an
 * exact pixel and two panes cannot both claim it.
 */
export function paneRects(plot, weights, separatorHeight) {
    if (weights.length === 0)
        return [];
    if (plot.height <= 0 || plot.width <= 0) {
        // A collapsed plot has no bands to divide; one empty rect per pane keeps
        // every index into the pane table valid rather than throwing mid-frame.
        return weights.map(() => ({ ...plot, height: 0 }));
    }
    const count = weights.length;
    const separators = Math.max(0, count - 1);
    const separatorTotal = separatorHeight * separators;
    const available = Math.max(0, plot.height - separatorTotal);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const rects = [];
    let consumed = 0;
    for (let index = 0; index < count; index++) {
        const top = plot.y + consumed;
        let height;
        if (index === count - 1) {
            // The last pane takes whatever is left, so rounding never leaves the
            // stack short of the plot's bottom edge.
            height = plot.y + plot.height - top;
        }
        else {
            height = Math.round((weights[index] / totalWeight) * available);
        }
        rects.push({ x: plot.x, y: top, width: plot.width, height });
        consumed += height + separatorHeight;
    }
    return rects;
}
/**
 * A vertical transform that fits `[minimum, maximum]` into a pane, in CSS pixels.
 *
 * Matches the viewport's own convention: `y = offsetY + value * scaleY`, with a
 * negative scale because larger values sit higher up the pane.
 */
export function fitPaneTransform(rect, minimum, maximum, paddingRatio = 0.1) {
    if (rect.height <= 0)
        return { scaleY: -1, offsetY: rect.y };
    let low = minimum;
    let high = maximum;
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
        // Nothing to fit. A zero range would divide by zero and put every vertex
        // at the same y, so a nominal band is used and the pane simply draws empty.
        low = 0;
        high = 1;
    }
    if (high - low === 0) {
        // A flat series has no extent to show; give it a band around its value so
        // it draws as a line across the middle rather than a single clipped pixel.
        const magnitude = Math.max(Math.abs(low) * 0.1, 1);
        low -= magnitude;
        high += magnitude;
    }
    const padding = (high - low) * paddingRatio;
    const paddedLow = low - padding;
    const paddedHigh = high + padding;
    const scaleY = -rect.height / (paddedHigh - paddedLow);
    return { scaleY, offsetY: rect.y + rect.height - paddedLow * scaleY };
}
/** Value at a y coordinate under a pane transform. The inverse of the fit. */
export function paneValueAt(transform, coordinateY) {
    return (coordinateY - transform.offsetY) / transform.scaleY;
}
/** Fewest labels a non-price pane is guaranteed to show across its range. */
export const MIN_PANE_TICKS = 4;
/**
 * Value span a pane shows, from its rect and its transform.
 *
 * `scaleY` is **pixels per value unit**, so the span is `height / |scaleY|`.
 * Multiplying instead of dividing is the natural mistake here and it is
 * completely silent: the span comes out too large, a tick step chosen from it is
 * too coarse, and the pane ends up with a single label on its axis.
 */
export function paneValueSpan(rect, transform) {
    if (!(Math.abs(transform.scaleY) > 0))
        return 0;
    return rect.height / Math.abs(transform.scaleY);
}
/**
 * Tick step for a pane's axis, given its value span and a pixel-spacing target.
 *
 * Sizing a step from a fixed pixel separation suits a tall pane and starves a short
 * one, so a non-price pane is also guaranteed `minTicks` labels across its span.
 * The guarantee is applied by walking *down* a 1/2/5 ladder, because snapping *up*
 * to that ladder is what defeats it: a request for a quarter of a 45-unit span
 * lands on the next rung, 50, and the count halves.
 */
export function paneTickStep(span, pixelTarget, minTicks = MIN_PANE_TICKS, nice = niceStep) {
    if (!(span > 0) || !Number.isFinite(span))
        return nice(pixelTarget > 0 ? pixelTarget : 1);
    let step = nice(Math.min(pixelTarget > 0 ? pixelTarget : span, span / minTicks));
    // Bounded: a pathological span or scale must not spin here.
    for (let guard = 0; guard < 12 && step > 0 && span / step < minTicks; guard++) {
        step = finerNiceStep(step);
    }
    return step > 0 ? step : span / minTicks;
}
/** Rounds a target step to the nearest 1/2/5 times a power of ten. */
export function niceStep(targetStep) {
    if (!Number.isFinite(targetStep) || targetStep <= 0)
        return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(targetStep)));
    const normalized = targetStep / magnitude;
    const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return factor * magnitude;
}
/** The next rounder value below a 1/2/5-ladder step: 50 to 20, 20 to 10. */
function finerNiceStep(step) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(step)));
    const normalized = step / magnitude;
    if (normalized >= 5)
        return magnitude * 2;
    if (normalized >= 2)
        return magnitude;
    return magnitude / 2;
}
/**
 * Value range of an overlay across the visible candles, or `null` when it covers
 * none of them.
 *
 * Reads full-resolution values rather than the reduced buckets: the range decides
 * the pane's scale, and a range computed from a subsample can clip a peak that is
 * genuinely on screen.
 */
export function visibleOverlayRange(values, firstIndex, lastIndex, from, to) {
    const low = Math.max(0, firstIndex, Math.floor(from));
    const high = Math.min(values.length - 1, lastIndex, Math.ceil(to));
    if (high < low)
        return null;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let index = low; index <= high; index++) {
        const value = values[index];
        if (!Number.isFinite(value))
            continue;
        if (value < minimum)
            minimum = value;
        if (value > maximum)
            maximum = value;
    }
    if (minimum > maximum)
        return null;
    return [minimum, maximum];
}
