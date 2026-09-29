// src/core/decorations.ts
//
// Price lines, the last-price tag, and series markers.
//
// These are **decorations, not series**. A price line has no volume, no
// aggregation, and no business being reduced by the pyramid; teaching the
// downsampler about them would mean every indicator output had to declare which
// kind of series it was before a single bar could be aggregated. They are drawn
// on the UI canvas instead, under the crosshair and beside the price gutter,
// which is where the axis labels already live.
//
// The one piece here that is not a caller-supplied value is the last-price tag,
// and it is derived: the chart already knows the newest candle, so asking the
// caller to restate it would be a second source of truth that could disagree
// with the candles by one update.
import { nearestCandleIndexByTime } from './coordinates.js';
const POSITIONS = ['aboveBar', 'belowBar', 'inBar'];
const SHAPES = ['arrowUp', 'arrowDown', 'circle', 'square'];
function fail(message) {
    throw new Error(`MatrixCharts: ${message}`);
}
/** Priorities when two labels want the same strip of the price gutter. */
export const LABEL_PRIORITY = {
    /** An axis tick is the first thing to go: the others are the caller's data. */
    tick: 0,
    priceLine: 1,
    lastPrice: 2,
    crosshair: 3,
};
/**
 * Decides which labels get drawn, given that the gutter is too narrow to hold
 * all of them at once.
 *
 * Kept by priority, not by position, and a kept label displaces anything within
 * its own height of it. Sorting by y alone and thinning out what collides would
 * drop whichever happened to be drawn first, which is not something a reader can
 * predict; dropping the axis tick instead keeps the caller's own annotations.
 *
 * Returns a boolean per input, in the input's order.
 */
export function layoutLabels(candidates) {
    const keep = candidates.map(() => true);
    // Highest priority first, then top to bottom so the result is stable.
    const order = candidates
        .map((candidate, index) => ({ candidate, index }))
        .sort((a, b) => (b.candidate.priority - a.candidate.priority || a.candidate.y - b.candidate.y));
    const placed = [];
    for (const { candidate, index } of order) {
        // Both labels' half-heights, not just this one's: two 14px labels 13px
        // apart overlap by a pixel, and comparing against one height alone would
        // call that clear.
        const half = Math.max(candidate.height, 1) / 2;
        let collides = false;
        for (const other of placed) {
            if (Math.abs(candidate.y - other.y) < half + other.half) {
                collides = true;
                break;
            }
        }
        if (collides) {
            keep[index] = false;
            continue;
        }
        placed.push({ y: candidate.y, half });
    }
    return keep;
}
/** Validates price lines. Colours are resolved by the caller. */
export function resolvePriceLines(specs, resolveColor) {
    if (specs.length === 0)
        return [];
    const seen = new Set();
    const resolved = [];
    for (const spec of specs) {
        if (typeof spec.id !== 'string' || spec.id.trim().length === 0) {
            fail('Each price line needs a non-empty string id.');
        }
        if (seen.has(spec.id)) {
            fail(`Price line id ${JSON.stringify(spec.id)} is used more than once.`);
        }
        seen.add(spec.id);
        if (!Number.isFinite(spec.price)) {
            fail(`Price line ${JSON.stringify(spec.id)} must have a finite price.`);
        }
        if (spec.lineWidth !== undefined) {
            if (!Number.isFinite(spec.lineWidth) || spec.lineWidth < 1 || spec.lineWidth > 4) {
                fail(`Price line ${JSON.stringify(spec.id)} has lineWidth ${spec.lineWidth}; it must be between 1 and 4 CSS pixels.`);
            }
        }
        if (spec.lineStyle !== undefined && spec.lineStyle !== 'solid' && spec.lineStyle !== 'dashed') {
            fail(`Price line ${JSON.stringify(spec.id)} has lineStyle ${JSON.stringify(spec.lineStyle)}; expected 'solid' or 'dashed'.`);
        }
        if (spec.title !== undefined && typeof spec.title !== 'string') {
            fail(`Price line ${JSON.stringify(spec.id)} must have a string title.`);
        }
        resolved.push({
            id: spec.id,
            price: spec.price,
            color: resolveColor(spec, spec.color),
            lineWidth: spec.lineWidth ?? 1,
            lineStyle: spec.lineStyle ?? 'dashed',
            axisLabelVisible: spec.axisLabelVisible !== false,
            title: spec.title ?? '',
            axisLabelColor: spec.axisLabelColor === undefined
                ? null
                : resolveColor(spec, spec.axisLabelColor),
        });
    }
    return resolved;
}
/**
 * Validates markers and snaps their timestamps onto the candle index.
 *
 * A marker snaps; an overlay does not. The distinction is the density: an overlay
 * is a continuous series whose whole shape depends on landing on the right bars,
 * so an unmatched timestamp there is a bug worth refusing, while a marker is a
 * single annotation placed between two bars, where the nearest bar is what the
 * gesture meant.
 */
export function resolveMarkers(specs, candleTimes, resolveColor) {
    if (specs.length === 0 || candleTimes.length === 0)
        return [];
    const timeAt = (index) => candleTimes[index];
    return specs.map((spec, order) => {
        if (!Number.isFinite(spec.time)) {
            fail(`Marker ${order} must have a finite time.`);
        }
        if (spec.position !== undefined && !POSITIONS.includes(spec.position)) {
            fail(`Marker ${order} has position ${JSON.stringify(spec.position)}; expected one of ${POSITIONS.join(', ')}.`);
        }
        if (spec.shape !== undefined && !SHAPES.includes(spec.shape)) {
            fail(`Marker ${order} has shape ${JSON.stringify(spec.shape)}; expected one of ${SHAPES.join(', ')}.`);
        }
        if (spec.size !== undefined && (!Number.isFinite(spec.size) || spec.size < 0.25 || spec.size > 4)) {
            fail(`Marker ${order} has size ${spec.size}; it must be between 0.25 and 4.`);
        }
        if (spec.text !== undefined && typeof spec.text !== 'string') {
            fail(`Marker ${order} must have a string text.`);
        }
        const index = nearestCandleIndexByTime(candleTimes.length, spec.time, timeAt);
        if (index < 0) {
            fail(`Marker ${order} has no candle to land on.`);
        }
        return {
            index,
            position: spec.position ?? 'aboveBar',
            shape: spec.shape ?? 'arrowUp',
            color: resolveColor(spec.color),
            text: spec.text ?? '',
            size: spec.size ?? 1,
        };
    });
}
/**
 * Whether markers are worth drawing at all at this bar spacing.
 *
 * A marker is a fixed number of pixels wide, so at a few pixels per bar a screen
 * full of them is a smear rather than a set of annotations. Below the cutoff they
 * are dropped entirely rather than shrunk, because an unreadable marker is worse
 * than an absent one and the ordinals are still readable through `getMarkers()`.
 */
export const MARKER_MIN_BAR_SPACING = 4;
export function shouldDrawMarkers(barSpacing) {
    return Number.isFinite(barSpacing) && barSpacing >= MARKER_MIN_BAR_SPACING;
}
/**
 * The price a marker is drawn at, from the bar it landed on.
 *
 * Resolved by the chart rather than the UI layer, because the UI layer holds
 * timestamps and not candle values: it could only have guessed, or the payload
 * would have to carry every candle's OHLC to draw a few arrows.
 */
export function markerAnchorPrice(candle, position) {
    if (position === 'aboveBar')
        return candle.high;
    if (position === 'belowBar')
        return candle.low;
    return candle.close;
}
export const ZONE_STATES = ['live', 'mitigated', 'invalidated'];
/** Standard weights, so a caller supplying one colour gets the conventional look. */
export const ZONE_WEIGHTS = {
    live: { fill: 0.12, border: 0.55 },
    // A mitigated zone is a faint dashed outline with no fill: the chart keeps its
    // own history without a wall of pale rectangles over the price action.
    mitigated: { fill: 0, border: 0.25 },
    invalidated: { fill: 0, border: 0.14 },
};
/**
 * Most zones drawn at once.
 *
 * Translucent fills compound where they overlap, so a few hundred stacked zones
 * turn the plot into mud. Over the cap, live zones are kept in full and the
 * remaining budget goes to the most recent mitigated ones: a live zone is
 * tradeable, a mitigated one is history, and dropping the oldest *live* zone would
 * drop the most visually dominant thing on the chart.
 */
export const MAX_DRAWN_ZONES = 200;
function withWeight(color, alpha) {
    return [color[0], color[1], color[2], alpha];
}
/**
 * Zones in the order they should be painted.
 *
 * Invalidated, then mitigated, then live, each oldest first. A zone that has been
 * mitigated must sit *under* the live ones: a faint dashed outline drawn on top of
 * a live fill would put the quietest thing in the chart over the loudest.
 */
export function zoneStackingOrder(zones) {
    const rank = (state) => (state === 'invalidated' ? 0 : state === 'mitigated' ? 1 : 2);
    return [...zones].sort((a, b) => (rank(a.state) - rank(b.state) || a.fromIndex - b.fromIndex));
}
/**
 * The zones to actually draw, within the budget. Live zones first, then the most
 * recent mitigated ones.
 */
export function zonesWithinBudget(zones, limit = MAX_DRAWN_ZONES) {
    // A limit of zero means draw none. The default already covers "unlimited", so
    // reading zero as unlimited too would be a second spelling of the same thing
    // with a third meaning.
    if (limit <= 0)
        return [];
    if (zones.length <= limit)
        return [...zones];
    const live = [];
    const history = [];
    for (const zone of zones) {
        if (zone.state === 'live')
            live.push(zone);
        else
            history.push(zone);
    }
    if (live.length >= limit) {
        return zoneStackingOrder(live.slice(0, limit));
    }
    // Most recent first, so the ones kept are the ones nearest the live edge.
    const byRecency = [...history].sort((a, b) => b.fromIndex - a.fromIndex);
    return zoneStackingOrder([...live, ...byRecency.slice(0, limit - live.length)]);
}
/** Validates zones. Candle OHLC is supplied by the caller, which has it. */
export function resolveZones(specs, candleTimes, candleAt, defaultColor, parseColor) {
    if (specs.length === 0)
        return [];
    const seen = new Set();
    const resolved = [];
    for (const spec of specs) {
        if (typeof spec.id !== 'string' || spec.id.trim().length === 0) {
            fail('Each zone needs a non-empty string id.');
        }
        if (seen.has(spec.id)) {
            fail(`Zone id ${JSON.stringify(spec.id)} is used more than once.`);
        }
        seen.add(spec.id);
        const fromIndex = exactIndexOfTime(candleTimes, spec.time);
        if (fromIndex < 0) {
            fail(`Zone ${JSON.stringify(spec.id)} is anchored to ${new Date(spec.time).toISOString()}, `
                + 'which is not a candle. A zone is a candle and its boundaries, so its '
                + 'timestamp has to match one exactly rather than be snapped to the nearest.');
        }
        let toIndex = null;
        if (spec.to !== undefined && spec.to !== null) {
            toIndex = exactIndexOfTime(candleTimes, spec.to);
            if (toIndex < 0) {
                fail(`Zone ${JSON.stringify(spec.id)} ends at ${new Date(spec.to).toISOString()}, which is not a candle.`);
            }
            if (toIndex < fromIndex) {
                fail(`Zone ${JSON.stringify(spec.id)} ends before it starts.`);
            }
        }
        const state = spec.state ?? 'live';
        if (!ZONE_STATES.includes(state)) {
            fail(`Zone ${JSON.stringify(spec.id)} has state ${JSON.stringify(spec.state)}; expected one of ${ZONE_STATES.join(', ')}.`);
        }
        if (spec.label !== undefined && typeof spec.label !== 'string') {
            fail(`Zone ${JSON.stringify(spec.id)} must have a string label.`);
        }
        const candle = candleAt(fromIndex);
        // Bounds default to the anchor candle, so a caller that has a bar and
        // nothing else still gets the conventional zone for it.
        const top = spec.top === undefined ? candle.high : spec.top;
        const bottom = spec.bottom === undefined ? candle.low : spec.bottom;
        if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
            fail(`Zone ${JSON.stringify(spec.id)} must have finite top and bottom bounds.`);
        }
        if (top < bottom) {
            fail(`Zone ${JSON.stringify(spec.id)} has top ${top} below its bottom ${bottom}.`);
        }
        const base = spec.color === undefined
            ? defaultColor
            : parseColor(spec.color, `zone ${spec.id} colour`);
        const weights = ZONE_WEIGHTS[state];
        const fill = spec.fill === undefined
            ? withWeight(base, weights.fill)
            : parseColor(spec.fill, `zone ${spec.id} fill`);
        const border = spec.border === undefined
            ? withWeight(base, weights.border)
            : parseColor(spec.border, `zone ${spec.id} border`);
        resolved.push({
            id: spec.id,
            fromIndex,
            toIndex,
            top,
            bottom,
            fill,
            border,
            // The border is what carries the state: solid while live, dashed once
            // the zone has stopped mattering. Swapping the fill colour instead would
            // put a colour alarm over a chart that has merely moved on.
            borderStyle: state === 'live' ? 'solid' : 'dashed',
            extendLeft: spec.extendLeft === true,
            label: spec.label ?? '',
            state,
        });
    }
    return resolved;
}
/** Ordinal of an exact timestamp, or -1. */
function exactIndexOfTime(candleTimes, time) {
    if (!Number.isFinite(time))
        return -1;
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
