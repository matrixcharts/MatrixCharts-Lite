import type { IRenderer } from '../core/IRenderer.js';
import type { EventEmitter, ChartEvents } from '../core/EventEmitter.js';
import type { OverlayPainter } from '../core/paint.js';
export declare class Canvas2DRenderer implements IRenderer {
    private canvas;
    private emitter;
    private ctx;
    private offsetX;
    private offsetY;
    private scaleX;
    private scaleY;
    /**
     * Slot offset of every bar, or null when the series has no breaks.
     *
     * Read only through the helpers in `coordinates` and `timeAxis`, which take a null
     * table as the identity. It is a field rather than something derived from the
     * options because it is rebuilt when the data changes, not when the view does.
     */
    private slotOffsets;
    /** Region series occupy. Equals the canvas until the axes claim space. */
    private plot;
    private devicePixelRatio;
    private crosshairX;
    private crosshairY;
    private crosshairTime;
    private crosshairCandle;
    /** The pane the pointer is over, and the value there. Both null on a divider. */
    private crosshairPane;
    private crosshairValue;
    private timeValues;
    /**
     * The modal bar interval, when the chart supplied one.
     *
     * Undefined means the chart did not say, and the time axis derives it — correct
     * and O(n log n). The chart owns the timestamps, so it owns this too, and at a
     * million retained candles deriving it per frame is the single most expensive
     * thing in the render path.
     */
    private timeInterval;
    /**
     * The caller's registered painter, or null.
     *
     * Held on the UI layer rather than on the chart, because the chart has no way to
     * reach a 2D context and the layer is the thing that owns one. The chart
     * forwards the registration.
     */
    private overlayPainter;
    /** Last error key already reported, so a throwing painter logs once. */
    private lastOverlayPainterError;
    private options;
    private colors;
    private priceFormatter;
    private timeFormatter;
    private timeFormatterKey;
    /**
     * Pane rects and vertical transforms for the current frame, or `null` when no
     * panes were declared. Null is the single-pane case, which is drawn from the
     * price scale across the whole plot exactly as it was before panes existed.
     */
    private panes;
    /**
     * Decorations, drawn on the grid layer so they sit under the crosshair and in
     * the same pass as the axis labels they share the price gutter with.
     */
    private priceLines;
    private markers;
    /**
     * Zones, drawn first and on the *grid* layer.
     *
     * The grid layer is z-index 0, beneath the data layer, so a translucent zone
     * painted here composites against the background only and the candles composite
     * on top at full opacity. A zone on the data layer would multiply over the candle
     * pixels and tint them, which is the washed-out look every order-block indicator
     * is trying to avoid — and the reason the fill and border weights are decoupled
     * in the first place.
     */
    private zones;
    private lastPrice;
    private isGridLayer;
    constructor(isGridLayer?: boolean);
    init(canvas: HTMLCanvasElement, emitter: EventEmitter<ChartEvents>): void;
    resize(width: number, height: number, dpr: number): void;
    private handleViewportEvent;
    private handleOptionsEvent;
    private parseColors;
    /**
     * The crosshair is owned by Chart. This layer only draws the lines and the
     * readout, so what is drawn always matches what crosshairMove reported.
     */
    private handleCrosshairEvent;
    private handleDataEvent;
    private handleDecorationsEvent;
    private get viewport();
    /**
     * Runs the caller's registered painter, if any, with a context bound to this
     * layer's current view.
     *
     * The context object is rebuilt per frame rather than cached, because almost
     * everything in it — the plot rect, the pane rects, the transform, the scale —
     * changes when the view does, and a stale one would draw a trend line at the
     * zoom it was registered at. The cost is one small object per frame, which is
     * not what a painter costs anyway.
     */
    private paintCallerOverlay;
    /** The context handed to a painter, resolved against this frame's view. */
    private paintContext;
    private reportOverlayPainterError;
    clear(): void;
    /** `rgba(...)` string from an already-parsed colour, at a given alpha. */
    private withAlpha;
    render(): void;
    /**
     * Decides, in one pass, which labels the price gutter can show: the axis ticks,
     * the price-line tags, and the last-price tag.
     *
     * Planned together because they compete for the same strip of gutter and none of
     * them can see the others. A last-price tag at 104.30 sitting on the 104 tick
     * has to displace that tick, or the two are drawn on top of each other and both
     * become unreadable.
     */
    /**
     * Screen y of a price on the price pane, honouring its scale.
     *
     * Every decoration arrives in prices and has to be placed in scale space, since
     * that is what the pane's transform is affine over. Funnelling all of them
     * through here is deliberate: five call sites each converting for themselves is
     * five chances to forget one, and on a log axis a forgotten conversion puts a
     * price line at a plausible-looking wrong place rather than off screen.
     */
    private pricePaneY;
    private planLabels;
    /**
     * One price band per pane: the rect, the transform from a scale-space value to a
     * y within it, and the ticks to label.
     *
     * The tick list is built here and reused by both the grid lines and the labels,
     * so a label cannot drift off the line it belongs to. It is built from the
     * pane's *scale*, which is why a log pane is labelled 1, 2, 5, 10 rather than
     * 2.7, 7.4, 148 — and why `priceFormat.minMove` is only ever applied to the
     * price pane, it being a property of prices.
     *
     * With no panes declared this is a single band covering the whole plot, which is
     * the behaviour that shipped before panes existed.
     */
    private priceBands;
    private makeBand;
    destroy(): void;
    /**
     * Registers the caller's paint callback, or clears it with null.
     *
     * Only the UI layer accepts one. The grid layer is the one that gets an opaque
     * background fill, so anything drawn there would be erased by the next frame's
     * background; a registration aimed at the wrong layer is refused rather than
     * silently ignored.
     */
    setOverlayPainter(painter: OverlayPainter | null): void;
    private renderCrosshair;
    /**
     * The rect of the pane the crosshair is over, or `null` on a divider.
     *
     * The pane itself is Chart's answer, carried on the event, so the drag's routing and
     * this agree about which pane a y is in rather than each deciding.
     */
    private hoveredPaneRect;
    /**
     * Draws the OHLC panel and the axis price/time tags for the crosshair. The
     * candle comes from Chart, so it is the exact bar the pointer resolved to
     * rather than an aggregate bucket from the visible pyramid slice.
     *
     * The panel sits just inside the plot's top-left corner so it never covers
     * the price gutter, and both axis tags sit in the gutters beside the rule
     * they annotate, matching where the static axis labels are drawn.
     */
    private renderCrosshairReadout;
    /**
     * Draws the plot frame and the axis labels. Labels live in the reserved
     * gutters rather than over the data, so no price or time ever sits on top of
     * a candle: prices are right-aligned against the plot's left edge inside the
     * price gutter, times sit below the plot's bottom edge inside the time
     * gutter.
     */
    private renderAxes;
    /**
     * The line between adjacent panes.
     *
     * Drawn from the gap the pane rects already leave rather than from a
     * recomputed position, so the line cannot land a pixel off the space the data
     * layer is clipping to — a separator that does not match the gap it fills
     * leaves a sliver of one pane's background showing.
     */
    private renderPaneSeparators;
    /**
     * Price lines, their axis tags, the last-price rule, and markers.
     *
     * Drawn here rather than in a renderer of their own because the whole point is
     * that they are not series: nothing here allocates a buffer, nothing is
     * aggregated, and nothing needs the downsampler to know it exists. Canvas2D
     * handles a few thousand of these without complaint; the point at which that
     * stops being true is the point to revisit this, and it is recorded in the
     * contract rather than guessed at now.
     */
    private renderDecorations;
    /**
     * Zones: a low-alpha fill and a firmer border, the border dashed once the zone
     * has stopped being live.
     *
     * Everything here is in CSS pixels and confined to the plot rect, so a zone
     * never paints over the price gutter. The left edge is the anchor candle's left
     * boundary and the right edge is the live edge of the plot, which is what makes a
     * zone read as "this happened at that bar and is still in effect" rather than as
     * a band floating over the chart.
     */
    private renderZones;
    private renderMarkers;
    /** A filled triangle, pointing up or down, with its tip at `y`. */
    private drawArrow;
    /**
     * A tag in the price gutter, filled in its own colour so it reads as belonging
     * to the line or candle it labels rather than as another axis label.
     *
     * `textColor` is passed in rather than read from the theme because the text has to be
     * chosen against `color`, and the theme's text colour is a statement about the plot
     * rather than about a saturated fill. Omit it and the choice is made here.
     */
    private drawTag;
    /** `rgba(...)` string for an already-parsed colour, keeping its own alpha. */
    private cssColor;
    private drawLabel;
    /** Price labels honour `priceFormat.precision` and the configured locale. */
    private formatAxisValue;
    /** Formats a real candle timestamp, choosing detail from the visible span. */
    private formatTimeAtTimestamp;
    private nearestCandleIndex;
}
//# sourceMappingURL=Canvas2DRenderer.d.ts.map