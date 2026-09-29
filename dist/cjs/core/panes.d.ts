import type { PlotRect } from './coordinates.js';
import type { VerticalTransform } from '../renderers/WebGLSeries.js';
/** The price pane's index. Every chart has one, and it is always first. */
export declare const PRICE_PANE = 0;
/**
 * One frame's pane geometry, in CSS pixels.
 *
 * Rects and transforms are index-aligned: `transforms[i]` maps values into
 * `rects[i]`, and `rects[0]` is the price pane. A renderer needs both, because a
 * value cannot be placed without a transform and cannot be clipped without a
 * rect, and pairing them by array index is what stops a series being drawn into
 * one pane's scale and clipped to another's.
 */
export interface PaneLayout {
    rects: PlotRect[];
    transforms: VerticalTransform[];
    /**
     * Panes with nothing on screen to scale to, so their transform is a nominal
     * placeholder rather than a fit.
     *
     * This exists so an empty pane can be left unlabelled. Labelling it would mean
     * inventing a scale — the placeholder spans 0 to 1 — and a pane whose axis reads
     * 0.2 to 0.8 invites the reader to take a level off a chart with nothing on it.
     */
    empty: boolean[];
}
export interface PaneOptions {
    /**
     * Relative heights, one per pane, index 0 being the price pane. `[1]` is a
     * single pane filling the plot, which is the default and the behaviour
     * without this feature.
     */
    weights?: number[];
    /** Space reserved between panes, CSS pixels. Defaults to 1. */
    separatorHeight?: number;
}
export interface ResolvedPaneOptions {
    weights: number[];
    separatorHeight: number;
}
/** Default pane options: one pane filling the plot, a hairline between panes. */
export declare const DEFAULT_PANE_OPTIONS: ResolvedPaneOptions;
/**
 * Validates pane weights.
 *
 * Weights are rejected rather than coerced because a pane layout is something a
 * caller reads back and reasons about: a silently repaired weight produces a
 * chart that is not the one that was asked for, and the discrepancy is only
 * visible by looking at it.
 */
export declare function resolvePaneOptions(raw: Partial<PaneOptions> | undefined): ResolvedPaneOptions;
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
export declare function paneRects(plot: PlotRect, weights: readonly number[], separatorHeight: number): PlotRect[];
/**
 * A vertical transform that fits `[minimum, maximum]` into a pane, in CSS pixels.
 *
 * Matches the viewport's own convention: `y = offsetY + value * scaleY`, with a
 * negative scale because larger values sit higher up the pane.
 */
export declare function fitPaneTransform(rect: PlotRect, minimum: number, maximum: number, paddingRatio?: number): VerticalTransform;
/** Value at a y coordinate under a pane transform. The inverse of the fit. */
export declare function paneValueAt(transform: VerticalTransform, coordinateY: number): number;
/** Fewest labels a non-price pane is guaranteed to show across its range. */
export declare const MIN_PANE_TICKS = 4;
/**
 * Value span a pane shows, from its rect and its transform.
 *
 * `scaleY` is **pixels per value unit**, so the span is `height / |scaleY|`.
 * Multiplying instead of dividing is the natural mistake here and it is
 * completely silent: the span comes out too large, a tick step chosen from it is
 * too coarse, and the pane ends up with a single label on its axis.
 */
export declare function paneValueSpan(rect: PlotRect, transform: VerticalTransform): number;
/**
 * Tick step for a pane's axis, given its value span and a pixel-spacing target.
 *
 * Sizing a step from a fixed pixel separation suits a tall pane and starves a short
 * one, so a non-price pane is also guaranteed `minTicks` labels across its span.
 * The guarantee is applied by walking *down* a 1/2/5 ladder, because snapping *up*
 * to that ladder is what defeats it: a request for a quarter of a 45-unit span
 * lands on the next rung, 50, and the count halves.
 */
export declare function paneTickStep(span: number, pixelTarget: number, minTicks?: number, nice?: (target: number) => number): number;
/** Rounds a target step to the nearest 1/2/5 times a power of ten. */
export declare function niceStep(targetStep: number): number;
/**
 * Value range of an overlay across the visible candles, or `null` when it covers
 * none of them.
 *
 * Reads full-resolution values rather than the reduced buckets: the range decides
 * the pane's scale, and a range computed from a subsample can clip a peak that is
 * genuinely on screen.
 */
export declare function visibleOverlayRange(values: Float32Array, firstIndex: number, lastIndex: number, from: number, to: number): [number, number] | null;
