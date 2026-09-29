import type { Rgba } from './options.js';
export type OverlayType = 'line' | 'histogram' | 'band' | 'area';
/** One value at one candle timestamp. */
export interface OverlayPoint {
    /** Unix timestamp in milliseconds. Must match a candle timestamp exactly. */
    time: number;
    value: number;
    /** Optional secondary value for band / cloud fill overlays. */
    value2?: number;
    /**
     * CSS colour for this point, overriding the overlay's own colour. Lets a
     * single overlay change colour along its length — a MACD histogram signed by
     * side, a stop level that flips between bullish and bearish.
     */
    color?: string;
}
/** An overlay as supplied by the caller. */
export interface OverlaySpec {
    /** Stable identifier, unique within a chart. Used to address the overlay later. */
    id: string;
    points: readonly OverlayPoint[];
    /** CSS colour for the stroke. Alpha is honoured. */
    color?: string;
    /** Whether to draw it. An overlay kept for later is cheaper than re-supplying it. */
    visible?: boolean;
    /**
     * Which pane to draw on. 0, the price pane, is the default and always exists.
     */
    pane?: number;
    /**
     * Rendering mode for this overlay:
     * - 'line': continuous polyline (default)
     * - 'histogram': vertical bars from baseline to value (e.g. MACD histogram)
     * - 'band': filled cloud between value and value2 (or points and points2)
     * - 'area': filled polygon between baseline and value
     */
    type?: OverlayType;
    /** Reference baseline value for histogram or area fills (default 0). */
    baseline?: number;
    /** Secondary point series for band / cloud fill. */
    points2?: readonly OverlayPoint[];
    /** Fill colour for area or band. When omitted, overlay colour with alpha is used. */
    fillColor?: string;
}
/** An overlay after validation: colour resolved, values aligned to candle ordinals. */
export interface ResolvedOverlay {
    id: string;
    visible: boolean;
    color: Rgba;
    /** Pane this overlay is drawn on, already checked against the pane count. */
    pane: number;
    /** Overlay rendering mode: 'line' | 'histogram' | 'band' | 'area'. */
    type: OverlayType;
    /** Reference baseline value for histogram / area. */
    baseline: number;
    /** Primary values buffer indexed by candle ordinal. */
    values: Float32Array;
    /** Secondary values buffer for band fills, or null if not a band. */
    values2: Float32Array | null;
    firstIndex: number;
    lastIndex: number;
    pointColors: Float32Array | null;
    /** Resolved fill colour for area or band, or null for default derived colour. */
    fillColor: Rgba | null;
}
/**
 * Validates and aligns overlay specs against the candle time index.
 *
 * Times must match a candle exactly. Snapping to the nearest candle — which is
 * what the coordinate layer does for a pointer or an arbitrary timestamp — would
 * let a misaligned overlay look correct, and a line drawn half a bar out of place
 * is the kind of defect that reaches a trading desk rather than a bug report.
 */
export declare function resolveOverlays(specs: readonly OverlaySpec[], candleTimes: readonly number[], resolveColor: (spec: OverlaySpec) => Rgba, resolvePointColor?: (spec: OverlaySpec, cssColor: string) => Rgba, paneCount?: number): ResolvedOverlay[];
/**
 * Extends an overlay's value buffer so it can hold `required` ordinals.
 *
 * Geometric, because the growth this exists for is one bar at a time. A buffer
 * sized exactly to the candle count reallocates on every append, and a reallocation
 * of a 10,000-value array per tick is the whole cost an incremental path is supposed
 * to remove.
 *
 * Doubling also keeps the amortised cost per appended value constant, which a
 * "grow by one" strategy does not.
 */
export declare function growOverlayValues(overlay: ResolvedOverlay, required: number): void;
/**
 * Records one indicator value against a candle ordinal. O(1).
 *
 * The live-feed path. `setOverlays` re-validates and re-aligns every point of every
 * overlay on every call, so feeding it one new value per tick costs a reallocation
 * and a full pass over the series per tick — which is how an engine with a complete
 * indicator *rendering* layer ends up unable to run an indicator in real time.
 *
 * `rgba` is optional and only pays for a buffer when a point actually carries a
 * colour, so a uniform overlay stays one float per ordinal.
 */
export declare function appendOverlayValue(overlay: ResolvedOverlay, ordinal: number, value: number, rgba?: Rgba): void;
/**
 * Shifts an overlay's window after `count` candles are trimmed from the front.
 *
 * Without this, every overlay on a chart that reaches its retention cap is drawn on
 * the wrong bars: the candles move left and the values do not, so an EMA lags the
 * price by exactly the trim count from the first frame. Nothing about it looks wrong
 * on a short series, which is why it survives — and why it is pinned by a test rather
 * than left to be found.
 *
 * `copyWithin` rather than a loop: a memmove of the live window, and there is one
 * buffer per overlay rather than one per bar, so this is a handful of passes whatever
 * the candle count.
 *
 * The buffer's capacity is left alone. It is over-allocated by design, and shrinking
 * it would mean an allocation on the retention path — the one path that must not
 * allocate. Reads are bounded by the candle count the caller holds, so the values left
 * above it are never seen.
 */
export declare function trimOverlayStart(overlay: ResolvedOverlay, count: number): void;
export interface BucketedOverlay {
    /** Interleaved points: `[x, value]` or `[x, value, r, g, b, a]`. */
    points: Float32Array;
    /**
     * Floats per point, which is 2 or 6. Returned rather than inferred, because
     * inferring a stride from a length is exactly the kind of guess that renders
     * correctly until it does not.
     */
    stride: 2 | 6;
}
/**
 * Reduces aligned overlay values to the same buckets the candle pyramid uses,
 * emitting points in data coordinates.
 *
 * The bucket x is computed with the pyramid's own formula, so an overlay point
 * lands on exactly the same x as the candle it belongs to at every level. That is
 * what keeps the two series from drifting apart as the chart zooms: they are not
 * merely close, they are identical.
 *
 * A bucket is emitted only when its **last** ordinal is covered, so an indicator
 * that starts partway across the series begins partway across the chart rather
 * than trailing in from wherever the uncovered values happen to sit.
 *
 * A bucket takes the **last** value in its group, which is the conventional
 * choice for a line and keeps the visible end of the series anchored. It does drop
 * intra-bucket extremes, so an overlay whose peaks matter more than its shape
 * should be sampled at a finer level than the candles.
 *
 * Interior omissions are not supported: a `LINE_STRIP` cannot express a break, so
 * a value missing between two covered ones would be drawn as a straight line
 * across the gap. Indicators that emit a contiguous run, which is what a warm-up
 * produces, are unaffected.
 *
 * `barBase` is the absolute ordinal of the first retained bar. The emitted x is an
 * **absolute** bucket index, matching the pyramid's own grid, which is cut on absolute
 * boundaries and is deliberately not re-cut when history is trimmed. Passing the base
 * is what keeps an overlay and the candles beneath it reducing to the same buckets: two
 * grids that differ by the trim count put a moving average one bucket away from the
 * price it annotates, which is invisible until the chart is panned.
 *
 * `visibleFrom` and `visibleTo` are the retained-window ordinals currently on screen,
 * and the reduction is confined to them. The candles have always been culled this way
 * — the engine draws the buckets the plot covers, not the ones the series holds — and an
 * overlay reduced over the whole retained series on every frame costs the same work for
 * the 49,200 bars scrolled off the left edge as for the 800 on screen. Measured at
 * 50,000 bars and 32 indicators, 14.8 ms per frame collapsed to 0.28 ms.
 *
 * The range is **clamped to the covered window and widened by a bucket at each end**,
 * never substituted for it. That is what keeps an overlay entering from off-screen
 * drawn: its first visible bucket is emitted, so the line reaches the plot edge rather
 * than starting at the first bar inside it. The candle slice widens the same way.
 *
 * Reducing a narrower range is not a different reduction. A bucket's value is the last
 * ordinal in its group, and the groups are cut on absolute boundaries, so the buckets a
 * culled range produces are the same buckets the full range produced, in the same
 * order, with the same values.
 */
export declare function bucketOverlay(values: Float32Array, factor: number, sourceCount: number, firstIndex?: number, lastIndex?: number, pointColors?: Float32Array | null, barBase?: number, visibleFrom?: number, visibleTo?: number): BucketedOverlay;
//# sourceMappingURL=overlays.d.ts.map