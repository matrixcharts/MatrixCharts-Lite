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
import { PRICE_PANE } from './panes.js';
function fail(message) {
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
export function resolveOverlays(specs, candleTimes, resolveColor, resolvePointColor = (spec) => (resolveColor(spec)), paneCount = 1) {
    if (specs.length === 0)
        return [];
    const seen = new Set();
    const resolved = [];
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
        const pane = spec.pane ?? PRICE_PANE;
        if (!Number.isInteger(pane) || pane < 0) {
            fail(`Overlay ${JSON.stringify(spec.id)} has pane ${pane}; a pane index must be a non-negative integer.`);
        }
        if (pane >= paneCount) {
            fail(`Overlay ${JSON.stringify(spec.id)} is on pane ${pane}, but the chart has `
                + `${paneCount} pane${paneCount === 1 ? '' : 's'}. Panes are created by `
                + 'declaring panes.weights, one entry per pane.');
        }
        const values = new Float32Array(candleTimes.length);
        const type = spec.type ?? 'line';
        if (type !== 'line' && type !== 'histogram' && type !== 'band' && type !== 'area') {
            fail(`Overlay ${JSON.stringify(spec.id)} has unknown type ${JSON.stringify(type)}.`);
        }
        const baseline = typeof spec.baseline === 'number' && Number.isFinite(spec.baseline) ? spec.baseline : 0;
        const fillColor = spec.fillColor !== undefined ? resolvePointColor(spec, spec.fillColor) : null;
        if (spec.points.length === 0) {
            resolved.push({
                id: spec.id,
                visible: spec.visible !== false && spec.points.length > 0,
                color: resolveColor(spec),
                pane,
                type,
                baseline,
                values,
                values2: null,
                firstIndex: -1,
                lastIndex: -1,
                pointColors: null,
                fillColor,
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
        let pointColors = null;
        for (let index = 0; index < spec.points.length; index++) {
            const point = spec.points[index];
            if (typeof point !== 'object' || point === null) {
                fail(`Overlay ${JSON.stringify(spec.id)} point ${index} is not an object.`);
            }
            if (!Number.isFinite(point.time) || !Number.isFinite(point.value)) {
                fail(`Overlay ${JSON.stringify(spec.id)} point ${index} must have finite time and value.`);
            }
            if (point.time <= previousTime) {
                fail(`Overlay ${JSON.stringify(spec.id)} times must strictly increase; `
                    + `point ${index} has time ${point.time} after ${previousTime}.`);
            }
            previousTime = point.time;
            const ordinal = indexOfTime(candleTimes, point.time);
            if (ordinal < 0) {
                fail(`Overlay ${JSON.stringify(spec.id)} has a timestamp with no candle at `
                    + `${new Date(point.time).toISOString()}. Overlay values must land on a `
                    + 'candle, not between them.');
            }
            values[ordinal] = point.value;
            if (point.color !== undefined) {
                if (pointColors === null)
                    pointColors = new Float32Array(candleTimes.length * 4);
                const rgba = resolvePointColor(spec, point.color);
                pointColors.set(rgba, ordinal * 4);
            }
            if (firstIndex < 0)
                firstIndex = ordinal;
            lastIndex = ordinal;
        }
        let values2 = null;
        if (Array.isArray(spec.points2)) {
            values2 = new Float32Array(candleTimes.length);
            for (let i = 0; i < spec.points2.length; i++) {
                const pt = spec.points2[i];
                if (typeof pt === 'object' && pt !== null && Number.isFinite(pt.time) && Number.isFinite(pt.value)) {
                    const ord = indexOfTime(candleTimes, pt.time);
                    if (ord >= 0)
                        values2[ord] = pt.value;
                }
            }
        }
        else {
            // Check if any point has value2
            let hasValue2 = false;
            for (let i = 0; i < spec.points.length; i++) {
                if (typeof spec.points[i].value2 === 'number' && Number.isFinite(spec.points[i].value2)) {
                    hasValue2 = true;
                    break;
                }
            }
            if (hasValue2) {
                values2 = new Float32Array(candleTimes.length);
                for (let i = 0; i < spec.points.length; i++) {
                    const pt = spec.points[i];
                    if (typeof pt.value2 === 'number' && Number.isFinite(pt.value2)) {
                        const ord = indexOfTime(candleTimes, pt.time);
                        if (ord >= 0)
                            values2[ord] = pt.value2;
                    }
                }
            }
        }
        resolved.push({
            id: spec.id,
            visible: spec.visible !== false,
            color: resolveColor(spec),
            pane,
            type,
            baseline,
            values,
            values2,
            firstIndex,
            lastIndex,
            pointColors,
            fillColor,
        });
    }
    return resolved;
}
/** Ordinal of an exact timestamp, or -1. */
function indexOfTime(candleTimes, time) {
    let low = 0;
    let high = candleTimes.length - 1;
    while (low <= high) {
        const middle = (low + high) >>> 1;
        if (candleTimes[middle] === time)
            return middle;
        if (candleTimes[middle] < time)
            low = middle + 1;
        else
            high = middle - 1;
    }
    return -1;
}
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
export function growOverlayValues(overlay, required) {
    if (overlay.values.length >= required)
        return;
    const capacity = Math.max(required, Math.max(64, overlay.values.length * 2));
    const values = new Float32Array(capacity);
    values.set(overlay.values);
    overlay.values = values;
    if (overlay.pointColors !== null) {
        const colors = new Float32Array(capacity * 4);
        colors.set(overlay.pointColors);
        overlay.pointColors = colors;
    }
    if (overlay.values2 !== null) {
        const v2 = new Float32Array(capacity);
        v2.set(overlay.values2);
        overlay.values2 = v2;
    }
}
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
export function appendOverlayValue(overlay, ordinal, value, rgba) {
    if (!Number.isInteger(ordinal) || ordinal < 0) {
        fail(`Overlay ${JSON.stringify(overlay.id)} value at ordinal ${ordinal} is not a candle position.`);
    }
    if (!Number.isFinite(value)) {
        fail(`Overlay ${JSON.stringify(overlay.id)} value at ordinal ${ordinal} must be finite.`);
    }
    growOverlayValues(overlay, ordinal + 1);
    overlay.values[ordinal] = value;
    if (rgba !== undefined) {
        if (overlay.pointColors === null)
            overlay.pointColors = new Float32Array(overlay.values.length * 4);
        overlay.pointColors.set(rgba, ordinal * 4);
    }
    if (overlay.firstIndex < 0)
        overlay.firstIndex = ordinal;
    if (ordinal > overlay.lastIndex)
        overlay.lastIndex = ordinal;
    // `visible` is deliberately untouched. It is the caller's intent, and a value
    // arriving is not a request to draw something the caller switched off.
}
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
export function trimOverlayStart(overlay, count) {
    if (count <= 0)
        return;
    if (count < overlay.values.length) {
        overlay.values.copyWithin(0, count);
        if (overlay.pointColors !== null) {
            overlay.pointColors.copyWithin(0, count * 4);
        }
        if (overlay.values2 !== null) {
            overlay.values2.copyWithin(0, count);
        }
    }
    if (overlay.firstIndex >= 0) {
        overlay.firstIndex = Math.max(0, overlay.firstIndex - count);
    }
    if (overlay.lastIndex >= 0) {
        overlay.lastIndex = overlay.lastIndex - count;
    }
    // A window that has been trimmed past its own start has nothing left to draw. -1
    // is the "covers nothing" marker the rest of the module already uses, and it is
    // what stops a stale window from being reduced into buckets the caller believes
    // are covered.
    if (overlay.lastIndex < 0 || overlay.firstIndex > overlay.lastIndex) {
        overlay.firstIndex = -1;
        overlay.lastIndex = -1;
        overlay.visible = false;
    }
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
export function bucketOverlay(values, factor, sourceCount, firstIndex = 0, lastIndex = sourceCount - 1, pointColors = null, barBase = 0, visibleFrom = 0, visibleTo = sourceCount - 1) {
    if (firstIndex < 0 || lastIndex < firstIndex)
        return { points: new Float32Array(0), stride: 2 };
    // The emitted range is the intersection of what the indicator covers and what is
    // on screen, widened by a bucket at each end. Clamping the *covered* range rather
    // than the visible one is what keeps an indicator entering from off-screen: a
    // line whose first covered bar is left of the plot still contributes the buckets
    // that touch it, and a series that starts partway across the chart still begins
    // partway across rather than trailing in from the left edge.
    const screenFrom = Math.floor(Math.max(firstIndex, visibleFrom - (factor > 1 ? factor : 1)));
    const screenTo = Math.ceil(Math.min(lastIndex, visibleTo + (factor > 1 ? factor : 1)));
    if (screenFrom > screenTo)
        return { points: new Float32Array(0), stride: 2 };
    const stride = pointColors === null ? 2 : 6;
    // A preallocated buffer rather than a growing array of boxed numbers. This runs
    // once per overlay per frame, and `Float32Array.from` on a plain array is a second
    // pass over every value with a double-to-float narrowing at each step.
    //
    // Sized from the **emitted** range, not from the whole series. Sizing it from
    // `sourceCount` allocated and discarded a full-length buffer on every frame for
    // every overlay, which is the same O(history) cost this range exists to remove: the
    // allocation is per series length even when almost none of it is written.
    const emittedCount = factor > 1
        ? Math.ceil((screenTo - screenFrom) / factor) + 2
        : screenTo - screenFrom + 1;
    const out = new Float32Array(Math.max(0, emittedCount) * stride);
    let written = 0;
    // `x` is the *bucket index*, not a position. Bucketing is index arithmetic and
    // stays that way: converting to a position is the renderer's job, via
    // `bucketCentreSlot`, because a bucket has no position until it is drawn and
    // deciding one here would put the conversion in two places.
    const emit = (x, ordinal) => {
        if (written + stride > out.length)
            return;
        out[written] = x;
        out[written + 1] = values[ordinal];
        if (pointColors === null) {
            written += 2;
            return;
        }
        out[written + 2] = pointColors[ordinal * 4];
        out[written + 3] = pointColors[ordinal * 4 + 1];
        out[written + 4] = pointColors[ordinal * 4 + 2];
        out[written + 5] = pointColors[ordinal * 4 + 3];
        written += 6;
    };
    if (factor <= 1) {
        const from = Math.max(0, screenFrom);
        const to = Math.min(sourceCount - 1, screenTo);
        for (let ordinal = from; ordinal <= to; ordinal++)
            emit(ordinal + barBase, ordinal);
    }
    else {
        // Walked by absolute bucket rather than by retained ordinal, because that is
        // the grid the candles are reduced on. The retained range each bucket covers
        // is clipped at both ends, so a bucket straddling the trim contributes only
        // the part of itself that survives — the same clipping `bucketCentreSlot`
        // does when it places the bucket.
        const firstBucket = Math.floor((barBase + Math.max(0, screenFrom)) / factor);
        const lastBucket = Math.floor((barBase + Math.min(sourceCount - 1, screenTo)) / factor);
        for (let bucket = firstBucket; bucket <= lastBucket; bucket++) {
            const first = Math.max(0, bucket * factor - barBase);
            const last = Math.min((bucket + 1) * factor - barBase, sourceCount) - 1;
            if (last < first)
                continue;
            if (last < firstIndex || first > lastIndex)
                continue;
            // The bucket's index, which the candles' own slice is keyed by, so the two
            // reduce to the same buckets and land on the same x by construction.
            emit(bucket, last);
        }
    }
    return { points: out.length === written ? out : out.subarray(0, written), stride };
}
