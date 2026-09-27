// src/core/overlays.ts
//
// Pure geometry and validation for overlay series: values supplied from outside
// the library, drawn on the same time index as the candles.
//
// There is no indicator maths here by design. An EMA, a Bollinger band, or
// anything else is computed elsewhere and arrives as plain values; this module's
// whole job is to refuse input that would silently draw in the wrong place and to
// reduce the values to the same buckets as the candles so the two can never
// drift apart as the chart zooms.

import type { Rgba } from './options.js';
import { PRICE_PANE } from './panes.js';

/** One value at one candle timestamp. */
export interface OverlayPoint {
    /** Unix timestamp in milliseconds. Must match a candle timestamp exactly. */
    time: number;
    value: number;
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
     *
     * A higher index is for values that do not measure price — an RSI, a MACD
     * histogram — which would otherwise be squashed into the price range. The pane
     * must exist: it is created by declaring `panes.weights`, so naming an index
     * that was never declared is rejected rather than quietly drawn on the wrong
     * one.
     */
    pane?: number;
}

/** An overlay after validation: colour resolved, values aligned to candle ordinals. */
export interface ResolvedOverlay {
    id: string;
    visible: boolean;
    color: Rgba;
    /** Pane this overlay is drawn on, already checked against the pane count. */
    pane: number;
    /**
     * One value per retained candle, indexed by candle ordinal. A timestamp that
     * matched no candle is rejected rather than skipped, so this array is always
     * the same length as the candle count and index `i` always means candle `i`.
     * Ordinals outside `firstIndex`..`lastIndex` hold 0 and are never drawn.
     */
    values: Float32Array;
    /**
     * First and last ordinal the indicator actually covers, or -1 when it covers
     * none.
     *
     * This matters more than it looks. Most indicators have a warm-up and emit
     * nothing until they have enough history — a 21-period EMA over 1000 bars
     * starts at bar 20. Treating the uncovered leading bars as zero would draw a
     * line from price zero up to the first real value, which is the single most
     * destructive thing an overlay could do to a chart.
     */
    firstIndex: number;
    lastIndex: number;
    /**
     * Per-ordinal RGBA, or `null` when every point shares the overlay's colour.
     *
     * The common case is a whole overlay in one colour, and paying four floats per
     * ordinal for that on every frame would be waste, so the uniform case stays
     * `null` and the renderer expands the single colour itself.
     */
    pointColors: Float32Array | null;
}

function fail(message: string): never {
    throw new Error(`MatrixCharts: ${message}`);
}

/**
 * Validates and aligns overlay specs against the candle time index.
 *
 * Times must match a candle exactly. Snapping to the nearest candle — which is
 * what the coordinate layer does for a pointer or an arbitrary timestamp — would
 * let a misaligned overlay look correct, and a line drawn half a bar out of place
 * is the kind of defect that reaches a trading desk rather than a bug report.
 */
export function resolveOverlays(
    specs: readonly OverlaySpec[],
    candleTimes: readonly number[],
    resolveColor: (spec: OverlaySpec) => Rgba,
    resolvePointColor: (spec: OverlaySpec, cssColor: string) => Rgba = (spec): Rgba => (
        resolveColor(spec)
    ),
    paneCount: number = 1,
): ResolvedOverlay[] {
    if (specs.length === 0) return [];

    const seen = new Set<string>();
    const resolved: ResolvedOverlay[] = [];

    for (const spec of specs) {
        if (typeof spec.id !== 'string' || spec.id.trim().length === 0) {
            fail('Each overlay needs a non-empty string id.');
        }
        if (seen.has(spec.id)) {
            fail(`Overlay id ${JSON.stringify(spec.id)} is used more than once.`);
        }
        seen.add(spec.id);

        if (!Array.isArray(spec.points)) {
            fail(`Overlay ${JSON.stringify(spec.id)} must supply a points array.`);
        }
        // Checked before any data work, so a typo in a pane index is reported as
        // the typo it is rather than as a downstream complaint about geometry.
        const pane: number = spec.pane ?? PRICE_PANE;
        if (!Number.isInteger(pane) || pane < 0) {
            fail(`Overlay ${JSON.stringify(spec.id)} has pane ${pane}; a pane index must be a non-negative integer.`);
        }
        if (pane >= paneCount) {
            fail(
                `Overlay ${JSON.stringify(spec.id)} is on pane ${pane}, but the chart has `
                + `${paneCount} pane${paneCount === 1 ? '' : 's'}. Panes are created by `
                + 'declaring panes.weights, one entry per pane.',
            );
        }
        const values = new Float32Array(candleTimes.length);
        if (spec.points.length === 0) {
            // Kept, but with nothing to draw. Not an error: an indicator that has
            // not produced a value yet is a normal state, not a malformed series.
            resolved.push({
                id: spec.id,
                visible: spec.visible !== false && spec.points.length > 0,
                color: resolveColor(spec),
                pane,
                values,
                firstIndex: -1,
                lastIndex: -1,
                pointColors: null,
            });
            continue;
        }

        // A binary search per point would be faster, but overlays are validated
        // once per data change rather than per frame, and a linear walk keeps the
        // strict-increasing check and the alignment check in one pass.
        let previousTime = Number.NEGATIVE_INFINITY;
        let firstIndex = -1;
        let lastIndex = -1;
        // Allocated only once a point actually carries a colour, so an overlay in
        // one colour costs nothing extra.
        let pointColors: Float32Array | null = null;
        for (let index = 0; index < spec.points.length; index++) {
            const point = spec.points[index];
            if (typeof point !== 'object' || point === null) {
                fail(`Overlay ${JSON.stringify(spec.id)} point ${index} is not an object.`);
            }
            if (!Number.isFinite(point.time) || !Number.isFinite(point.value)) {
                fail(`Overlay ${JSON.stringify(spec.id)} point ${index} must have finite time and value.`);
            }
            if (point.time <= previousTime) {
                fail(
                    `Overlay ${JSON.stringify(spec.id)} times must strictly increase; `
                    + `point ${index} has time ${point.time} after ${previousTime}.`,
                );
            }
            previousTime = point.time;

            const ordinal = indexOfTime(candleTimes, point.time);
            if (ordinal < 0) {
                fail(
                    `Overlay ${JSON.stringify(spec.id)} has a timestamp with no candle at `
                    + `${new Date(point.time).toISOString()}. Overlay values must land on a `
                    + 'candle, not between them.',
                );
            }
            values[ordinal] = point.value;
            if (point.color !== undefined) {
                if (pointColors === null) pointColors = new Float32Array(candleTimes.length * 4);
                const rgba = resolvePointColor(spec, point.color);
                pointColors.set(rgba, ordinal * 4);
            }
            if (firstIndex < 0) firstIndex = ordinal;
            lastIndex = ordinal;
        }

        resolved.push({
            id: spec.id,
            visible: spec.visible !== false,
            color: resolveColor(spec),
            pane,
            values,
            firstIndex,
            lastIndex,
            pointColors,
        });
    }

    return resolved;
}

/** Ordinal of an exact timestamp, or -1. */
function indexOfTime(candleTimes: readonly number[], time: number): number {
    let low = 0;
    let high = candleTimes.length - 1;
    while (low <= high) {
        const middle = (low + high) >>> 1;
        if (candleTimes[middle] === time) return middle;
        if (candleTimes[middle] < time) low = middle + 1;
        else high = middle - 1;
    }
    return -1;
}

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
 */
export function bucketOverlay(
    values: Float32Array,
    factor: number,
    sourceCount: number,
    firstIndex: number = 0,
    lastIndex: number = sourceCount - 1,
    pointColors: Float32Array | null = null,
): BucketedOverlay {
    if (firstIndex < 0 || lastIndex < firstIndex) return { points: new Float32Array(0), stride: 2 };

    const stride: 2 | 6 = pointColors === null ? 2 : 6;
    const out: number[] = [];
    // `x` is the *bucket index*, not a position. Bucketing is index arithmetic and
    // stays that way: converting to a position is the renderer's job, via
    // `bucketCentreSlot`, because a bucket has no position until it is drawn and
    // deciding one here would put the conversion in two places.
    const emit = (x: number, ordinal: number): void => {
        out.push(x, values[ordinal]);
        if (pointColors === null) return;
        out.push(
            pointColors[ordinal * 4],
            pointColors[ordinal * 4 + 1],
            pointColors[ordinal * 4 + 2],
            pointColors[ordinal * 4 + 3],
        );
    };

    if (factor <= 1) {
        const from = Math.max(0, firstIndex);
        const to = Math.min(sourceCount - 1, lastIndex);
        for (let ordinal = from; ordinal <= to; ordinal++) emit(ordinal, ordinal);
    } else {
        const bucketCount = Math.ceil(sourceCount / factor);
        for (let bucket = 0; bucket < bucketCount; bucket++) {
            const first = bucket * factor;
            const last = Math.min(first + factor, sourceCount) - 1;
            if (last < firstIndex || first > lastIndex) continue;
            // The bucket's index, which the candles' own slice is keyed by, so the two
            // reduce to the same buckets and land on the same x by construction.
            emit(bucket, last);
        }
    }
    return { points: Float32Array.from(out), stride };
}
