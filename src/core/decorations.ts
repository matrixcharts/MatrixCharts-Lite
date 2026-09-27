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

import type { Rgba } from './options.js';
import { nearestCandleIndexByTime } from './coordinates.js';

/** A marker with the price resolved, which is what the renderer actually draws. */
export interface PlacedMarker extends ResolvedMarker {
    /** Price the marker is drawn at, or NaN when its bar has gone. */
    price: number;
}

/** A horizontal rule at a fixed price, optionally labelled on the price axis. */
export interface PriceLineSpec {
    /** Stable identifier, unique within a chart. */
    id: string;
    /** The price the rule sits at. Must be finite. */
    price: number;
    /** CSS colour for the rule and, unless overridden, its axis tag. */
    color?: string;
    /** Rule thickness in CSS pixels, 1 to 4. Defaults to 1. */
    lineWidth?: number;
    /** Defaults to `dashed`, which is what separates an annotation from the grid. */
    lineStyle?: 'solid' | 'dashed';
    /** Whether to draw a tag on the price axis. Defaults to true. */
    axisLabelVisible?: boolean;
    /** Text drawn at the left end of the rule, inside the plot. */
    title?: string;
    /** Tag colour, when it should differ from the rule. */
    axisLabelColor?: string;
}

export interface ResolvedPriceLine {
    id: string;
    price: number;
    color: Rgba;
    lineWidth: number;
    lineStyle: 'solid' | 'dashed';
    axisLabelVisible: boolean;
    title: string;
    axisLabelColor: Rgba | null;
}

/** Where a marker sits relative to its bar. */
export type MarkerPosition = 'aboveBar' | 'belowBar' | 'inBar';

/** What a marker is drawn as. */
export type MarkerShape = 'arrowUp' | 'arrowDown' | 'circle' | 'square';

export interface MarkerSpec {
    /**
     * Unix timestamp in milliseconds.
     *
     * Snapped to the nearest candle, which is what a click on the chart means and
     * what every trading platform does with an annotation placed between two
     * bars. This is the one place in the library where a time is resolved
     * approximately on purpose; the ordinal it lands on is reported by
     * `getMarkers()` so a caller can see where it went.
     */
    time: number;
    /** Defaults to `aboveBar`. */
    position?: MarkerPosition;
    /** Defaults to `arrowUp`. */
    shape?: MarkerShape;
    /** CSS colour for the marker. */
    color?: string;
    /** Text drawn beside the marker. */
    text?: string;
    /** Size multiplier, 0.25 to 4. Defaults to 1. */
    size?: number;
}

export interface ResolvedMarker {
    /** Ordinal the timestamp snapped to. */
    index: number;
    position: MarkerPosition;
    shape: MarkerShape;
    color: Rgba;
    text: string;
    size: number;
}

const POSITIONS: readonly MarkerPosition[] = ['aboveBar', 'belowBar', 'inBar'];
const SHAPES: readonly MarkerShape[] = ['arrowUp', 'arrowDown', 'circle', 'square'];

function fail(message: string): never {
    throw new Error(`MatrixCharts: ${message}`);
}

/** Priorities when two labels want the same strip of the price gutter. */
export const LABEL_PRIORITY = {
    /** An axis tick is the first thing to go: the others are the caller's data. */
    tick: 0,
    priceLine: 1,
    lastPrice: 2,
    crosshair: 3,
} as const;

export interface LabelCandidate {
    y: number;
    priority: number;
    /** Vertical space the label needs. Two labels closer than this overlap. */
    height: number;
}

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
export function layoutLabels(candidates: readonly LabelCandidate[]): boolean[] {
    const keep: boolean[] = candidates.map((): boolean => true);
    // Highest priority first, then top to bottom so the result is stable.
    const order = candidates
        .map((candidate: LabelCandidate, index: number): { candidate: LabelCandidate; index: number } => ({ candidate, index }))
        .sort((a, b): number => (
            b.candidate.priority - a.candidate.priority || a.candidate.y - b.candidate.y
        ));

    const placed: Array<{ y: number; half: number }> = [];
    for (const { candidate, index } of order) {
        // Both labels' half-heights, not just this one's: two 14px labels 13px
        // apart overlap by a pixel, and comparing against one height alone would
        // call that clear.
        const half: number = Math.max(candidate.height, 1) / 2;
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
export function resolvePriceLines(
    specs: readonly PriceLineSpec[],
    resolveColor: (spec: PriceLineSpec, cssColor: string | undefined) => Rgba,
): ResolvedPriceLine[] {
    if (specs.length === 0) return [];

    const seen = new Set<string>();
    const resolved: ResolvedPriceLine[] = [];
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
export function resolveMarkers(
    specs: readonly MarkerSpec[],
    candleTimes: readonly number[],
    resolveColor: (cssColor: string | undefined) => Rgba,
): ResolvedMarker[] {
    if (specs.length === 0 || candleTimes.length === 0) return [];

    const timeAt = (index: number): number => candleTimes[index];
    return specs.map((spec: MarkerSpec, order: number): ResolvedMarker => {
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
        const index: number = nearestCandleIndexByTime(candleTimes.length, spec.time, timeAt);
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

export function shouldDrawMarkers(barSpacing: number): boolean {
    return Number.isFinite(barSpacing) && barSpacing >= MARKER_MIN_BAR_SPACING;
}

/** The OHLC a marker position refers to. */
export interface AnchorCandle {
    high: number;
    low: number;
    close: number;
}

/**
 * The price a marker is drawn at, from the bar it landed on.
 *
 * Resolved by the chart rather than the UI layer, because the UI layer holds
 * timestamps and not candle values: it could only have guessed, or the payload
 * would have to carry every candle's OHLC to draw a few arrows.
 */
export function markerAnchorPrice(candle: AnchorCandle, position: MarkerPosition): number {
    if (position === 'aboveBar') return candle.high;
    if (position === 'belowBar') return candle.low;
    return candle.close;
}

// --- zones -------------------------------------------------------------------

/**
 * A zone's lifecycle. It is the caller's to decide: when a zone stops mattering is
 * an analytical judgement about their own indicator, not something this library
 * should infer from price.
 */
export type ZoneState = 'live' | 'mitigated' | 'invalidated';

export const ZONE_STATES: readonly ZoneState[] = ['live', 'mitigated', 'invalidated'];

/**
 * A fixed price zone anchored to one candle and extending right — an order block,
 * a breaker, a fair-value gap, a session range.
 *
 * Candle-anchored rather than a band between two moving lines, because that is
 * what these are: a zone belongs to a specific bar and does not move with price.
 */
export interface ZoneSpec {
    /** Stable identifier, unique within a chart. */
    id: string;
    /**
     * Timestamp of the candle the zone is anchored to. Its left edge and, unless
     * `top`/`bottom` say otherwise, its extent come from that bar.
     *
     * Must match a candle **exactly**. A marker snaps to the nearest bar because a
     * marker is a point and off-by-one-bar is invisible; a zone's left edge is a
     * boundary, so snapping would displace the whole zone by a bar and quietly
     * change which bar it is claiming to be. And the timestamp is taken rather than
     * an ordinal because ordinals shift under retention trimming while timestamps
     * do not.
     */
    time: number;
    /** Upper price bound. Defaults to the anchor candle's high. */
    top?: number;
    /** Lower price bound. Defaults to the anchor candle's low. */
    bottom?: number;
    /**
     * Timestamp of the candle at the zone's right edge, or `null`/absent to extend
     * to the right edge of the plot. A zone runs forward from where it was created
     * and never backward past it; `extendLeft` is the one way to go left, and only
     * for zones that genuinely span the whole chart.
     */
    to?: number | null;
    /**
     * One colour for the zone. The fill and the border are derived from it at
     * standard weights, so a caller who supplies only this gets the conventional
     * pairing rather than two numbers to invent.
     */
    color?: string;
    /** Fill colour including its alpha, overriding the derived fill. */
    fill?: string;
    /** Border colour including its alpha, overriding the derived border. */
    border?: string;
    /** Defaults to `live`. */
    state?: ZoneState;
    /**
     * Whether the zone runs left to the plot's edge as well. For premium/discount
     * bands and session ranges, which are not anchored to a candle at all.
     */
    extendLeft?: boolean;
    /** Small label drawn above the zone's left edge. Off by default. */
    label?: string;
}

export interface ResolvedZone {
    id: string;
    /** Ordinal of the anchor candle. */
    fromIndex: number;
    /** Ordinal of the right edge, or null to extend right. */
    toIndex: number | null;
    /** Price bounds, taken from the anchor candle where not given. */
    top: number;
    bottom: number;
    fill: Rgba;
    border: Rgba;
    borderStyle: 'solid' | 'dashed';
    extendLeft: boolean;
    label: string;
    state: ZoneState;
}

/** A zone with its geometry resolved against the current candles. */
export type PlacedZone = ResolvedZone;

/** Standard weights, so a caller supplying one colour gets the conventional look. */
export const ZONE_WEIGHTS = {
    live: { fill: 0.12, border: 0.55 },
    // A mitigated zone is a faint dashed outline with no fill: the chart keeps its
    // own history without a wall of pale rectangles over the price action.
    mitigated: { fill: 0, border: 0.25 },
    invalidated: { fill: 0, border: 0.14 },
} as const;

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

function withWeight(color: Rgba, alpha: number): Rgba {
    return [color[0], color[1], color[2], alpha];
}

/**
 * Zones in the order they should be painted.
 *
 * Invalidated, then mitigated, then live, each oldest first. A zone that has been
 * mitigated must sit *under* the live ones: a faint dashed outline drawn on top of
 * a live fill would put the quietest thing in the chart over the loudest.
 */
export function zoneStackingOrder(zones: readonly ResolvedZone[]): ResolvedZone[] {
    const rank = (state: ZoneState): number => (
        state === 'invalidated' ? 0 : state === 'mitigated' ? 1 : 2
    );
    return [...zones].sort((a, b): number => (
        rank(a.state) - rank(b.state) || a.fromIndex - b.fromIndex
    ));
}

/**
 * The zones to actually draw, within the budget. Live zones first, then the most
 * recent mitigated ones.
 */
export function zonesWithinBudget(
    zones: readonly ResolvedZone[],
    limit: number = MAX_DRAWN_ZONES,
): ResolvedZone[] {
    // A limit of zero means draw none. The default already covers "unlimited", so
    // reading zero as unlimited too would be a second spelling of the same thing
    // with a third meaning.
    if (limit <= 0) return [];
    if (zones.length <= limit) return [...zones];
    const live: ResolvedZone[] = [];
    const history: ResolvedZone[] = [];
    for (const zone of zones) {
        if (zone.state === 'live') live.push(zone);
        else history.push(zone);
    }
    if (live.length >= limit) {
        return zoneStackingOrder(live.slice(0, limit));
    }
    // Most recent first, so the ones kept are the ones nearest the live edge.
    const byRecency: ResolvedZone[] = [...history].sort(
        (a, b): number => b.fromIndex - a.fromIndex,
    );
    return zoneStackingOrder([...live, ...byRecency.slice(0, limit - live.length)]);
}

/** Validates zones. Candle OHLC is supplied by the caller, which has it. */
export function resolveZones(
    specs: readonly ZoneSpec[],
    candleTimes: readonly number[],
    candleAt: (index: number) => AnchorCandle,
    defaultColor: Rgba,
    parseColor: (cssColor: string, label: string) => Rgba,
): ResolvedZone[] {
    if (specs.length === 0) return [];

    const seen = new Set<string>();
    const resolved: ResolvedZone[] = [];
    for (const spec of specs) {
        if (typeof spec.id !== 'string' || spec.id.trim().length === 0) {
            fail('Each zone needs a non-empty string id.');
        }
        if (seen.has(spec.id)) {
            fail(`Zone id ${JSON.stringify(spec.id)} is used more than once.`);
        }
        seen.add(spec.id);

        const fromIndex: number = exactIndexOfTime(candleTimes, spec.time);
        if (fromIndex < 0) {
            fail(
                `Zone ${JSON.stringify(spec.id)} is anchored to ${new Date(spec.time).toISOString()}, `
                + 'which is not a candle. A zone is a candle and its boundaries, so its '
                + 'timestamp has to match one exactly rather than be snapped to the nearest.',
            );
        }

        let toIndex: number | null = null;
        if (spec.to !== undefined && spec.to !== null) {
            toIndex = exactIndexOfTime(candleTimes, spec.to);
            if (toIndex < 0) {
                fail(`Zone ${JSON.stringify(spec.id)} ends at ${new Date(spec.to).toISOString()}, which is not a candle.`);
            }
            if (toIndex < fromIndex) {
                fail(`Zone ${JSON.stringify(spec.id)} ends before it starts.`);
            }
        }

        const state: ZoneState = spec.state ?? 'live';
        if (!ZONE_STATES.includes(state)) {
            fail(`Zone ${JSON.stringify(spec.id)} has state ${JSON.stringify(spec.state)}; expected one of ${ZONE_STATES.join(', ')}.`);
        }
        if (spec.label !== undefined && typeof spec.label !== 'string') {
            fail(`Zone ${JSON.stringify(spec.id)} must have a string label.`);
        }

        const candle: AnchorCandle = candleAt(fromIndex);
        // Bounds default to the anchor candle, so a caller that has a bar and
        // nothing else still gets the conventional zone for it.
        const top: number = spec.top === undefined ? candle.high : spec.top;
        const bottom: number = spec.bottom === undefined ? candle.low : spec.bottom;
        if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
            fail(`Zone ${JSON.stringify(spec.id)} must have finite top and bottom bounds.`);
        }
        if (top < bottom) {
            fail(`Zone ${JSON.stringify(spec.id)} has top ${top} below its bottom ${bottom}.`);
        }

        const base: Rgba = spec.color === undefined
            ? defaultColor
            : parseColor(spec.color, `zone ${spec.id} colour`);
        const weights = ZONE_WEIGHTS[state];
        const fill: Rgba = spec.fill === undefined
            ? withWeight(base, weights.fill)
            : parseColor(spec.fill, `zone ${spec.id} fill`);
        const border: Rgba = spec.border === undefined
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
function exactIndexOfTime(candleTimes: readonly number[], time: number): number {
    if (!Number.isFinite(time)) return -1;
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

