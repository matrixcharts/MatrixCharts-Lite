import type { Rgba } from './options.js';
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
/** Priorities when two labels want the same strip of the price gutter. */
export declare const LABEL_PRIORITY: {
    /** An axis tick is the first thing to go: the others are the caller's data. */
    readonly tick: 0;
    readonly priceLine: 1;
    readonly lastPrice: 2;
    readonly crosshair: 3;
};
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
export declare function layoutLabels(candidates: readonly LabelCandidate[]): boolean[];
/** Validates price lines. Colours are resolved by the caller. */
export declare function resolvePriceLines(specs: readonly PriceLineSpec[], resolveColor: (spec: PriceLineSpec, cssColor: string | undefined) => Rgba): ResolvedPriceLine[];
/**
 * Validates markers and snaps their timestamps onto the candle index.
 *
 * A marker snaps; an overlay does not. The distinction is the density: an overlay
 * is a continuous series whose whole shape depends on landing on the right bars,
 * so an unmatched timestamp there is a bug worth refusing, while a marker is a
 * single annotation placed between two bars, where the nearest bar is what the
 * gesture meant.
 */
export declare function resolveMarkers(specs: readonly MarkerSpec[], candleTimes: readonly number[], resolveColor: (cssColor: string | undefined) => Rgba): ResolvedMarker[];
/**
 * Whether markers are worth drawing at all at this bar spacing.
 *
 * A marker is a fixed number of pixels wide, so at a few pixels per bar a screen
 * full of them is a smear rather than a set of annotations. Below the cutoff they
 * are dropped entirely rather than shrunk, because an unreadable marker is worse
 * than an absent one and the ordinals are still readable through `getMarkers()`.
 */
export declare const MARKER_MIN_BAR_SPACING = 4;
export declare function shouldDrawMarkers(barSpacing: number): boolean;
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
export declare function markerAnchorPrice(candle: AnchorCandle, position: MarkerPosition): number;
/**
 * A zone's lifecycle. It is the caller's to decide: when a zone stops mattering is
 * an analytical judgement about their own indicator, not something this library
 * should infer from price.
 */
export type ZoneState = 'live' | 'mitigated' | 'invalidated';
export declare const ZONE_STATES: readonly ZoneState[];
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
export declare const ZONE_WEIGHTS: {
    readonly live: {
        readonly fill: 0.12;
        readonly border: 0.55;
    };
    readonly mitigated: {
        readonly fill: 0;
        readonly border: 0.25;
    };
    readonly invalidated: {
        readonly fill: 0;
        readonly border: 0.14;
    };
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
export declare const MAX_DRAWN_ZONES = 200;
/**
 * Zones in the order they should be painted.
 *
 * Invalidated, then mitigated, then live, each oldest first. A zone that has been
 * mitigated must sit *under* the live ones: a faint dashed outline drawn on top of
 * a live fill would put the quietest thing in the chart over the loudest.
 */
export declare function zoneStackingOrder(zones: readonly ResolvedZone[]): ResolvedZone[];
/**
 * The zones to actually draw, within the budget. Live zones first, then the most
 * recent mitigated ones.
 */
export declare function zonesWithinBudget(zones: readonly ResolvedZone[], limit?: number): ResolvedZone[];
/** Validates zones. Candle OHLC is supplied by the caller, which has it. */
export declare function resolveZones(specs: readonly ZoneSpec[], candleTimes: readonly number[], candleAt: (index: number) => AnchorCandle, defaultColor: Rgba, parseColor: (cssColor: string, label: string) => Rgba): ResolvedZone[];
