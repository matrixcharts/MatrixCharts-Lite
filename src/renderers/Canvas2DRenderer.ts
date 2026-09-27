// src/renderers/Canvas2DRenderer.ts
import type { IRenderer } from '../core/IRenderer.js';
import type { EventEmitter, ChartEvents } from '../core/EventEmitter.js';
import type { CandleData } from '../core/CandleData.js';
import {
    parseCssColor,
    themeDefaults,
    type ResolvedChartOptions,
    type Rgba,
    contrastText,
    priceLabelFormatter,
} from '../core/options.js';
import {
    type ChartViewport,
    type PlotRect,
    clampCandleIndex,
    coordinateToIndex,
    coordinateToSlot,
    indexToCoordinate,
    slotToCoordinate,
} from '../core/coordinates.js';
import { paneValueAt, type PaneLayout } from '../core/panes.js';
import { fromScaleSpace, priceTicks, toScaleSpace, type PriceScale, type Tick } from '../core/priceScale.js';
import { contiguousRuns } from '../core/sessionScale.js';
import { timeAxisDetail, timeAxisLabels, timeAxisTicks, type TimeAxisTick } from '../core/timeAxis.js';
import {
    LABEL_PRIORITY,
    layoutLabels,
    shouldDrawMarkers,
    zonesWithinBudget,
    type LabelCandidate,
    type PlacedMarker,
    type PlacedZone,
    type ResolvedPriceLine,
} from '../core/decorations.js';
import type { VerticalTransform } from './WebGLSeries.js';

/**
 * Vertical centre of a time-axis label, measured from the plot's bottom edge. The
 * default time gutter is 22px, so 13px puts the text roughly centred in it.
 */
const TIME_LABEL_OFFSET_Y = 13;

/**
 * Height a price-gutter label reserves, and the two heights in play: an axis tick
 * and the last-price tag. They differ so a tag does not displace a tick that is
 * further away than it really is.
 */
const AXIS_LABEL_HEIGHT = 14;
const LAST_PRICE_LABEL_HEIGHT = 18;

/** Marker geometry, in CSS pixels at `size` 1. */
const MARKER_SIZE = 9;
const MARKER_OFFSET = 8;
const MARKER_MARGIN = 24;

/**
 * Which price-gutter labels survive this frame, and where the surviving ones sit.
 * Built by `planLabels` and read by both the axis and the decoration pass, because
 * they compete for the same strip of gutter.
 */
interface DecorationLabels {
    /** One entry per candidate, in candidate order. */
    keep: boolean[];
    /** Axis tick y to its candidate index. */
    tickIndex: Map<number, number>;
    /** Price-line tag y to its candidate index. */
    lineIndex: Map<number, number>;
    lastY: number | null;
    /** Whether the last-price tag was itself kept after collisions. */
    lastShown: boolean;
}

/**
 * One pane's worth of axis labelling: where it is, how a value maps to a y inside
 * it, and which values to label.
 *
 * Bundled because all three come from the same pane entry, and reading a rect
 * from one pane and a transform from another is how a label ends up beside the
 * wrong scale.
 */
interface PriceBand {
    rect: PlotRect;
    y: (value: number) => number;
    ticks: Tick[];
}

export class Canvas2DRenderer implements IRenderer {
    private canvas!: HTMLCanvasElement;
    private emitter!: EventEmitter<ChartEvents>;
    private ctx!: CanvasRenderingContext2D;

    private offsetX: number = 0;
    private offsetY: number = 0;
    private scaleX: number = 1;
    private scaleY: number = 1;
    /**
     * Slot offset of every bar, or null when the series has no breaks.
     *
     * Read only through the helpers in `coordinates` and `timeAxis`, which take a null
     * table as the identity. It is a field rather than something derived from the
     * options because it is rebuilt when the data changes, not when the view does.
     */
    private slotOffsets: Float64Array | null = null;
    /** Region series occupy. Equals the canvas until the axes claim space. */
    private plot: PlotRect = { x: 0, y: 0, width: 0, height: 0 };
    private devicePixelRatio: number = 1;
    private crosshairX: number | null = null;
    private crosshairY: number | null = null;
    private crosshairTime: number | null = null;
    private crosshairCandle: CandleData | null = null;
    /** The pane the pointer is over, and the value there. Both null on a divider. */
    private crosshairPane: number | null = null;
    private crosshairValue: number | null = null;
    private timeValues: readonly number[] = [];
    private options: ResolvedChartOptions = themeDefaults('dark');
    // Parsed once per apply, not per label or per frame.
    private colors = this.parseColors(themeDefaults('dark'));
    private priceFormatter: Intl.NumberFormat = priceLabelFormatter('en-US', 2);
    private timeFormatter: Intl.DateTimeFormat | null = null;
    private timeFormatterKey: string = '';
    /**
     * Pane rects and vertical transforms for the current frame, or `null` when no
     * panes were declared. Null is the single-pane case, which is drawn from the
     * price scale across the whole plot exactly as it was before panes existed.
     */
    private panes: PaneLayout | null = null;
    /**
     * Decorations, drawn on the grid layer so they sit under the crosshair and in
     * the same pass as the axis labels they share the price gutter with.
     */
    private priceLines: readonly ResolvedPriceLine[] = [];
    private markers: readonly PlacedMarker[] = [];
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
    private zones: readonly PlacedZone[] = [];
    private lastPrice: { price: number; direction: 'up' | 'down' } | null = null;
    
    private isGridLayer: boolean;

    // FIX: Add a flag to prevent the UI layer from drawing the grid
    constructor(isGridLayer: boolean = true) {
        this.isGridLayer = isGridLayer;
    }

public init(canvas: HTMLCanvasElement, emitter: EventEmitter<ChartEvents>): void {
        this.canvas = canvas;
        this.emitter = emitter;
        const context = canvas.getContext('2d');
        if (!context) throw new Error("MatrixCharts: Failed to initialize 2D context.");
        this.ctx = context;

        this.emitter.on('viewport', this.handleViewportEvent);
        this.emitter.on('data', this.handleDataEvent);
        this.emitter.on('options', this.handleOptionsEvent);
        this.emitter.on('crosshair', this.handleCrosshairEvent);
        this.emitter.on('decorations', this.handleDecorationsEvent);
    }

    public resize(width: number, height: number, dpr: number): void {
        this.devicePixelRatio = dpr;
        this.canvas.width = Math.floor(width * dpr);
        this.canvas.height = Math.floor(height * dpr);
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    private handleViewportEvent = (payload: ChartEvents['viewport']): void => {
        this.offsetX = payload.offsetX;
        this.offsetY = payload.offsetY;
        this.scaleX = payload.scaleX;
        this.slotOffsets = payload.slots;
        this.scaleY = payload.scaleY;
        this.plot = payload.plot;
        // Absent means no panes were declared, and every label is then drawn from
        // the price scale across the whole plot, as before.
        this.panes = payload.panes ?? null;
    };

    private handleOptionsEvent = (options: ResolvedChartOptions): void => {
        this.options = options;
        this.colors = this.parseColors(options);
        this.priceFormatter = priceLabelFormatter(options.locale, options.priceFormat.precision);
        this.timeFormatterKey = '';
        this.timeFormatter = null;
    };

    private parseColors(options: ResolvedChartOptions) {
        return {
            background: parseCssColor(options.layout.background, 'layout.background'),
            text: parseCssColor(options.layout.textColor, 'layout.textColor'),
            grid: parseCssColor(options.grid.color, 'grid.color'),
            crosshair: parseCssColor(options.crosshair.color, 'crosshair.color'),
            up: parseCssColor(options.candlestick.upColor, 'candlestick.upColor'),
            down: parseCssColor(options.candlestick.downColor, 'candlestick.downColor'),
            separator: parseCssColor(options.panes.separatorColor, 'panes.separatorColor'),
        };
    }

    /**
     * The crosshair is owned by Chart. This layer only draws the lines and the
     * readout, so what is drawn always matches what crosshairMove reported.
     */
    private handleCrosshairEvent = (payload: ChartEvents['crosshair']): void => {
        this.crosshairX = payload.x;
        this.crosshairY = payload.y;
        this.crosshairTime = payload.time;
        this.crosshairCandle = payload.candle;
        this.crosshairPane = payload.pane;
        this.crosshairValue = payload.value;
        this.clear();
        this.render();
    };

    private handleDataEvent = (payload: ChartEvents['data']): void => {
        this.timeValues = payload.times;
    };

    private handleDecorationsEvent = (payload: ChartEvents['decorations']): void => {
        // The UI layer is cleared to transparent, so it holds no decorations; the
        // grid layer is not, so only that one has to remember and repaint them.
        if (!this.isGridLayer) return;
        this.priceLines = payload.priceLines;
        this.markers = payload.markers;
        this.zones = payload.zones;
        this.lastPrice = payload.lastPrice;
    };

    private get viewport(): ChartViewport {
        const cssWidth: number = this.canvas.width / this.devicePixelRatio;
        const cssHeight: number = this.canvas.height / this.devicePixelRatio;
        return {
            offsetX: this.offsetX,
            offsetY: this.offsetY,
            scaleX: this.scaleX,
            slots: this.slotOffsets,
            scaleY: this.scaleY,
            cssWidth,
            cssHeight,
            plot: this.plot.width > 0 && this.plot.height > 0
                ? this.plot
                : { x: 0, y: 0, width: cssWidth, height: cssHeight },
        };
    }

    public clear(): void {
        const cssWidth: number = this.canvas.width / this.devicePixelRatio;
        const cssHeight: number = this.canvas.height / this.devicePixelRatio;
        if (this.isGridLayer) {
            this.ctx.fillStyle = this.options.layout.background;
            this.ctx.fillRect(0, 0, cssWidth, cssHeight);
            return;
        }
        this.ctx.clearRect(0, 0, cssWidth, cssHeight);
    }

    /** `rgba(...)` string from an already-parsed colour, at a given alpha. */
    private withAlpha(color: readonly [number, number, number, number], alpha: number): string {
        return `rgba(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)}, ${alpha})`;
    }

    public render(): void {
        if (!this.isGridLayer) {
            this.renderCrosshair();
            return;
        }

        const viewport: ChartViewport = this.viewport;
        // Grid lines are bounded by the plot rect, not the canvas, so reserving an
        // axis gutter later cannot leave grid lines running under the labels.
        const plot: PlotRect = viewport.plot;
        const plotRight: number = plot.x + plot.width;
        const plotBottom: number = plot.y + plot.height;

        this.ctx.save();
        this.ctx.strokeStyle = this.options.grid.color;
        this.ctx.lineWidth = 1;

        // Zones first, so they sit under the grid as well as under the candles.
        // Everything after this point draws on top of them.
        this.renderZones(viewport);

        this.ctx.beginPath();

        // Which bars the axis labels, decided once and shared with the label pass below.
        // They share it because they have to agree exactly: a grid line with no label,
        // or a label with no line, is a defect that only shows up when the two are
        // derived separately — which is how they were derived before, from a step each
        // loop re-derived from a `niceStep` call of its own.
        const ticks: TimeAxisTick[] = timeAxisTicks({
            times: this.timeValues,
            slots: this.slotOffsets,
            fromSlot: coordinateToSlot(viewport, plot.x),
            toSlot: coordinateToSlot(viewport, plotRight),
            widthPx: plot.width,
        });

        // Which axis labels are drawn is decided once, with the decorations, because
        // they share the gutter: a last-price tag sitting on a tick has to displace
        // that tick, and neither knows about the other on its own.
        const labels: DecorationLabels = this.planLabels();

        if (this.options.grid.horzLines) {
            // Horizontal lines are per pane, from that pane's own scale, and off the
            // same tick list the labels come from. Drawing them from the price scale
            // across the whole plot would put a price grid through an RSI pane,
            // labelling it in prices it does not have; and computing the lines and the
            // labels from the same list is what stops a label drifting off its line.
            for (const band of this.priceBands()) {
                for (const tick of band.ticks) {
                    const y: number = band.y(tick.value);
                    if (y < band.rect.y || y > band.rect.y + band.rect.height) continue;
                    const crispY: number = Math.floor(y) + 0.5;
                    this.ctx.moveTo(plot.x, crispY);
                    this.ctx.lineTo(plotRight, crispY);
                }
            }
        }

        if (this.options.grid.vertLines) {
            // No progress guard needed, and that is the point of the rewrite. The old
            // loop stepped in slots, so a slot inside a break resolved to the bar before
            // it, two of them resolved to the same x, and `x <= previousX` ended the
            // loop at the *first* session break - taking every grid line to the right of
            // it with it. The exit is now "past the last visible bar", which is a
            // statement about bars and so cannot be tripped by geometry.
            //
            // Positioned from the tick's own slot rather than `indexToCoordinate`, which
            // clamped its index to the slot table and so put every out-of-series tick on
            // the newest candle — the reason a region with no candles had no vertical
            // lines in it and the grid cells never closed there, while the horizontal
            // lines, coming from the price scale, ran the full width regardless.
            for (const tick of ticks) {
                const x: number = slotToCoordinate(viewport, tick.slot);
                if (x < plot.x || x > plotRight) continue;
                const crispX: number = Math.floor(x) + 0.5;
                this.ctx.moveTo(crispX, plot.y);
                this.ctx.lineTo(crispX, plotBottom);
            }
        }

        this.ctx.stroke();
        this.renderAxes(viewport, ticks, labels);
        this.renderDecorations(viewport, labels);
        this.ctx.restore();
    }

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
    private pricePaneY(price: number): number {
        const band: PriceBand | undefined = this.priceBands()[0];
        if (band === undefined) return price;
        return band.y(toScaleSpace(price, this.options.priceScale.mode));
    }

    private planLabels(): DecorationLabels {
        const bands: PriceBand[] = this.priceBands();
        const priceBand: PriceBand | undefined = bands[0];

        const ticks: Array<{ y: number; price: number }> = [];
        for (const band of bands) {
            for (const tick of band.ticks) {
                const y: number = band.y(tick.value);
                if (y < band.rect.y || y > band.rect.y + band.rect.height) continue;
                ticks.push({ y, price: tick.price });
            }
        }

        const lines: Array<{ y: number; line: ResolvedPriceLine }> = [];
        for (const line of this.priceLines) {
            if (priceBand === undefined) continue;
            const y: number = priceBand.y(toScaleSpace(line.price, this.options.priceScale.mode));
            // A line scrolled off the top or bottom of the price pane is not drawn at
            // all, tag included: a tag for a price that is not on screen reads as a
            // price that is.
            if (y < priceBand.rect.y || y > priceBand.rect.y + priceBand.rect.height) continue;
            lines.push({ y, line });
        }

        // Gated on the option *before* it becomes a candidate, not after. The tag competes
        // with price-line labels for room on the axis and wins, being the higher priority,
        // so leaving it in the layout while not drawing it would keep a caller's own price
        // line from getting its label — an invisible label suppressing a visible one. The
        // side effect is that with the tag off, a price line sitting at the newest close
        // keeps its label where the tag used to take the space.
        let lastY: number | null = null;
        if (this.options.candlestick.lastPriceTag && this.lastPrice !== null && priceBand !== undefined) {
            const y: number = priceBand.y(toScaleSpace(this.lastPrice.price, this.options.priceScale.mode));
            if (y >= priceBand.rect.y && y <= priceBand.rect.y + priceBand.rect.height) lastY = y;
        }

        const candidates: LabelCandidate[] = [];
        const tickIndex = new Map<number, number>();
        for (const tick of ticks) {
            tickIndex.set(tick.y, candidates.length);
            candidates.push({ y: tick.y, priority: LABEL_PRIORITY.tick, height: AXIS_LABEL_HEIGHT });
        }
        const lineIndex = new Map<number, number>();
        for (const entry of lines) {
            if (!entry.line.axisLabelVisible) continue;
            lineIndex.set(entry.y, candidates.length);
            candidates.push({ y: entry.y, priority: LABEL_PRIORITY.priceLine, height: AXIS_LABEL_HEIGHT });
        }
        if (lastY !== null) {
            candidates.push({ y: lastY, priority: LABEL_PRIORITY.lastPrice, height: LAST_PRICE_LABEL_HEIGHT });
        }
        if (this.crosshairY !== null) {
            candidates.push({ y: this.crosshairY, priority: LABEL_PRIORITY.crosshair, height: AXIS_LABEL_HEIGHT });
        }

        const keep: boolean[] = layoutLabels(candidates);
        return {
            keep,
            tickIndex,
            lineIndex,
            lastY,
            lastShown: lastY !== null && keep[candidates.length - 1],
        };
    }

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
    private priceBands(): PriceBand[] {
        const viewport: ChartViewport = this.viewport;
        const panes: PaneLayout | null = this.panes;
        if (panes === null || panes.rects.length === 0) {
            const transform: VerticalTransform = {
                scaleY: viewport.scaleY,
                offsetY: viewport.offsetY,
            };
            return [this.makeBand(viewport.plot, transform, this.options.priceScale.mode, true)];
        }
        const bands: PriceBand[] = [];
        for (let index = 0; index < panes.rects.length; index++) {
            const rect: PlotRect = panes.rects[index];
            if (rect.height <= 0) continue;
            // A pane with nothing on it is left unlabelled rather than given the
            // placeholder 0-to-1 scale, which would read as a real axis on a chart
            // with nothing plotted.
            if (panes.empty[index]) continue;
            // Only the price pane is loggable. A pane holding an oscillator has no
            // reading on a log axis, so it stays linear whatever the price pane is
            // set to.
            const scale: PriceScale = index === 0 ? this.options.priceScale.mode : 'linear';
            bands.push(this.makeBand(rect, panes.transforms[index], scale, index === 0));
        }
        return bands;
    }

    private makeBand(
        rect: PlotRect,
        transform: VerticalTransform,
        scale: PriceScale,
        isPricePane: boolean,
    ): PriceBand {
        const top: number = fromScaleSpace(paneValueAt(transform, rect.y), scale);
        const bottom: number = fromScaleSpace(paneValueAt(transform, rect.y + rect.height), scale);
        const low: number = Math.min(top, bottom);
        const high: number = Math.max(top, bottom);
        // One label per 56 CSS pixels of pane, and never fewer than two: a short pane
        // sized purely by pixels ends up with a single line, which is an axis nobody
        // can read a level off.
        const target: number = Math.max(2, Math.min(8, Math.round(rect.height / 56)));
        return {
            rect,
            // Takes a scale-space value, because that is what the transform is affine
            // over. Passing a price here is the mistake this indirection exists to
            // make impossible.
            y: (value: number): number => transform.offsetY + value * transform.scaleY,
            ticks: priceTicks(
                low,
                high,
                scale,
                target,
                isPricePane ? this.options.priceFormat.minMove : 0,
            ),
        };
    }

    public destroy(): void {
        if (this.emitter) {
            this.emitter.off('viewport', this.handleViewportEvent);
            this.emitter.off('data', this.handleDataEvent);
            this.emitter.off('options', this.handleOptionsEvent);
            this.emitter.off('crosshair', this.handleCrosshairEvent);
        }
        this.clear();
    }

    private renderCrosshair(): void {
        if (!this.options.crosshair.visible) return;
        if (this.crosshairX === null || this.crosshairY === null) return;

        const viewport: ChartViewport = this.viewport;
        // The rules span the plot; the tags annotating them are drawn into the
        // gutters by renderCrosshairReadout.
        const plot: PlotRect = viewport.plot;

        this.ctx.save();
        this.ctx.strokeStyle = this.options.crosshair.color;
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([4, 4]);
        this.ctx.beginPath();
        // The vertical rule spans every pane, on purpose: a volume or momentum spike in
        // a lower pane has to line up with the exact candle it belongs to, and a rule
        // that stopped at the divider would break exactly that alignment.
        this.ctx.moveTo(this.crosshairX + 0.5, plot.y);
        this.ctx.lineTo(this.crosshairX + 0.5, plot.y + plot.height);
        // The horizontal rule spans the hovered pane only. Running it across the whole
        // plot drew a level through panes the pointer was nowhere near, which read as
        // those panes being at that value.
        const hovered: PlotRect | null = this.hoveredPaneRect();
        if (hovered !== null) {
            this.ctx.moveTo(plot.x, this.crosshairY + 0.5);
            this.ctx.lineTo(plot.x + plot.width, this.crosshairY + 0.5);
        }
        this.ctx.stroke();
        this.ctx.restore();
        this.renderCrosshairReadout(viewport);
    }

    /**
     * The rect of the pane the crosshair is over, or `null` on a divider.
     *
     * The pane itself is Chart's answer, carried on the event, so the drag's routing and
     * this agree about which pane a y is in rather than each deciding.
     */
    private hoveredPaneRect(): PlotRect | null {
        const panes: PaneLayout | null = this.panes;
        if (panes === null || this.crosshairPane === null) return null;
        const rect: PlotRect | undefined = panes.rects[this.crosshairPane];
        return rect ?? null;
    }

    /**
     * Draws the OHLC panel and the axis price/time tags for the crosshair. The
     * candle comes from Chart, so it is the exact bar the pointer resolved to
     * rather than an aggregate bucket from the visible pyramid slice.
     *
     * The panel sits just inside the plot's top-left corner so it never covers
     * the price gutter, and both axis tags sit in the gutters beside the rule
     * they annotate, matching where the static axis labels are drawn.
     */
    private renderCrosshairReadout(viewport: ChartViewport): void {
        if (this.crosshairX === null || this.crosshairY === null) return;

        const plot: PlotRect = viewport.plot;
        const candle: CandleData | null = this.crosshairCandle;
        // The floating OHLC panel, which is the only part of the crosshair a caller is
        // expected to replace with their own. Off by default; see `crosshair.readout`.
        // The gutter tags below are *not* gated by it: they label the crosshair's own
        // position, the way a crosshair does in a terminal, and removing them would take
        // away the reading the crosshair exists to give.
        if (candle && this.options.crosshair.readout) {
            const panelX: number = plot.x + 10;
            const panelY: number = plot.y + 10;
            const panelWidth: number = 158;
            const panelHeight: number = 58;
            const open: number = candle.open;
            const close: number = candle.close;
            const timeLabel: string = `T ${this.formatTimeAtTimestamp(candle.time)}`;
            const valueLabels: string[] = [
                `O ${this.formatAxisValue(open)}`,
                `H ${this.formatAxisValue(candle.high)}`,
                `L ${this.formatAxisValue(candle.low)}`,
                `C ${this.formatAxisValue(close)}`,
            ];
            const bullish: boolean = close >= open;
            // An explicit border colour wins. Unset, the frame follows the candle's
            // direction, which is what it always did and what makes it read as an error
            // state on a light theme: a *data* colour doing a *chrome* job.
            const border: Rgba = this.options.crosshair.readoutBorderColor;
            const borderColor: readonly [number, number, number, number] = border[3] > 0
                ? border
                : (bullish ? this.colors.up : this.colors.down);

            this.ctx.save();
            this.ctx.font = '11px sans-serif';
            this.ctx.textBaseline = 'middle';
            // Fill and text come as a pair, and the text falls back to a colour chosen
            // against the fill rather than to the theme's. A chip drawn in the plot's own
            // background was a hole in the plot, and on a saturated fill the theme's text
            // colour was close to invisible.
            this.ctx.fillStyle = this.cssColor(this.options.crosshair.readoutBackground);
            this.ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
            this.ctx.strokeStyle = this.withAlpha(borderColor, 0.95);
            this.ctx.strokeRect(panelX + 0.5, panelY + 0.5, panelWidth - 1, panelHeight - 1);
            const effectiveBg = this.options.crosshair.readoutBackground[3] === 0
                ? this.colors.background
                : this.options.crosshair.readoutBackground;

            this.ctx.fillStyle = this.cssColor(
                this.options.crosshair.readoutText[3] === 0
                    ? contrastText(effectiveBg)
                    : this.options.crosshair.readoutText,
            );
            this.ctx.fillText(timeLabel, panelX + 8, panelY + 10);
            for (let valueIndex: number = 0; valueIndex < valueLabels.length; valueIndex++) {
                const columnX: number = panelX + 8 + (valueIndex % 2) * 76;
                const rowY: number = panelY + 29 + Math.floor(valueIndex / 2) * 16;
                this.ctx.fillText(valueLabels[valueIndex], columnX, rowY);
            }
            this.ctx.restore();
        }

        // Both tags annotate a rule that is drawn across the plot, so they belong
        // in the gutter beside that rule: the value tag in the left gutter, the
        // time tag in the time gutter.
        //
        // The value tag reads the *hovered pane's* value, in that pane's units, from the
        // value Chart resolved. It used to ask the price pane's transform for whatever y
        // the pointer was at, so hovering an RSI pane put a price — 102.24 on a pane
        // showing 30 to 86 — on an oscillator's axis. On a divider there is no pane, so
        // the tag is suppressed rather than guessed at.
        if (this.crosshairValue !== null) {
            const background = this.options.crosshair.axisLabelBackground;
            const effectiveBg = background[3] === 0 ? this.colors.background : background;
            const text = this.options.crosshair.axisLabelText[3] === 0 
                    ? contrastText(effectiveBg) 
                    : this.options.crosshair.axisLabelText;

            this.drawTag(
                this.formatAxisValue(this.crosshairValue),
                plot.x - 6,
                this.crosshairY as number,
                background,
                text,
                'right'
            );
        }
        const timeTag: string | null = this.crosshairTime === null
            ? null
            : this.formatTimeAtTimestamp(this.crosshairTime);
            
        if (timeTag !== null) {
            const bg = this.options.crosshair.axisLabelBackground;
            const effectiveBg = bg[3] === 0 ? this.colors.background : bg;
            const fg = this.options.crosshair.axisLabelText[3] === 0 
                    ? contrastText(effectiveBg) 
                    : this.options.crosshair.axisLabelText;

            this.drawTag(
                timeTag,
                this.crosshairX,
                plot.y + plot.height + TIME_LABEL_OFFSET_Y,
                bg,
                fg,
                'center'
            );
        }
    }

    /**
     * Draws the plot frame and the axis labels. Labels live in the reserved
     * gutters rather than over the data, so no price or time ever sits on top of
     * a candle: prices are right-aligned against the plot's left edge inside the
     * price gutter, times sit below the plot's bottom edge inside the time
     * gutter.
     */
    private renderAxes(
        viewport: ChartViewport,
        ticks: readonly TimeAxisTick[],
        labels: DecorationLabels,
    ): void {
        const plot: PlotRect = viewport.plot;
        const plotRight: number = plot.x + plot.width;
        const plotBottom: number = plot.y + plot.height;
        this.ctx.save();
        this.ctx.font = '11px sans-serif';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = this.options.layout.textColor;
        this.ctx.strokeStyle = this.withAlpha(this.colors.grid, 0.38 / Math.max(this.colors.grid[3], 0.01));
        this.ctx.lineWidth = 1;

        this.ctx.beginPath();
        this.ctx.moveTo(plot.x + 0.5, plot.y);
        this.ctx.lineTo(plot.x + 0.5, plotBottom);
        this.ctx.moveTo(plot.x, plotBottom - 0.5);
        this.ctx.lineTo(plotRight, plotBottom - 0.5);
        this.ctx.stroke();

        // One set of price labels per pane, from that pane's own scale and its own
        // tick list, minus whichever ones a price line or the last-price tag has
        // claimed.
        for (const band of this.priceBands()) {
            for (const tick of band.ticks) {
                const y: number = band.y(tick.value);
                if (y < band.rect.y || y > band.rect.y + band.rect.height) continue;
                const index: number | undefined = labels.tickIndex.get(y);
                if (index !== undefined && labels.keep[index] === false) continue;
                this.drawLabel(this.formatAxisValue(tick.price), plot.x - 6, y, 'right');
            }
        }

        // Separators are drawn after the labels so a division reads as sitting on
        // top of both panes rather than being interrupted by the label boxes.
        this.renderPaneSeparators();

        // The same list the grid lines came from, which is why the two cannot disagree
        // about where a label belongs. Formatting reads the tick's own timestamp rather
        // than looking the bar up again: a lookup by index is a second answer to a
        // question the tick has already answered, and the label must name the candle the
        // line is drawn on.
        //
        // Positioned from the tick's slot, for the same reason the grid lines are: an
        // index is not a position once it can be past the end of the data, and asking
        // `indexToCoordinate` for one puts the label back on the newest candle.
        //
        // `labels` has already chosen each text in its full or short form, so the date
        // appears once per day rather than on every tick. What is left is collision, and
        // that needs text widths, so it is decided here rather than in the label pass: a
        // label whose box would reach back into the previous one is dropped, and the one
        // after it is free to be drawn. Dropping the later label rather than the earlier
        // keeps the sequence anchored to the left edge, so the reading starts where the
        // plot does.
        // The detail is read off the ticks themselves rather than off the series, because
        // the window can reach past either end of the data and the tick times are the only
        // ones that describe what is actually on screen. An empty list has no detail to
        // read and no label to draw, so it is not a case to answer.
        if (ticks.length === 0) {
            this.ctx.restore();
            return;
        }

        let crosshairTimeTagLeft = Number.POSITIVE_INFINITY;
        let crosshairTimeTagRight = Number.NEGATIVE_INFINITY;
        if (this.crosshairX !== null) {
            const timeTagText = this.crosshairTime === null
                ? null
                : this.formatTimeAtTimestamp(this.crosshairTime);
            if (timeTagText !== null) {
                const hw: number = this.ctx.measureText(timeTagText).width / 2 + 5; // 3 padding + 2 margin
                crosshairTimeTagLeft = this.crosshairX - hw;
                crosshairTimeTagRight = this.crosshairX + hw;
            }
        }

        let previousRight: number = Number.NEGATIVE_INFINITY;
        for (const label of timeAxisLabels({
            ticks,
            locale: this.options.locale,
            timeZone: this.options.timeZone,
            detail: timeAxisDetail(ticks[0].time, ticks[ticks.length - 1].time),
        })) {
            const x: number = slotToCoordinate(viewport, label.slot);
            if (x < plot.x || x > plotRight) continue;
            const halfWidth: number = this.ctx.measureText(label.text).width / 2;
            const left = x - halfWidth;
            const right = x + halfWidth;
            if (left < previousRight) continue;
            
            if (right >= crosshairTimeTagLeft && left <= crosshairTimeTagRight) continue;
            
            previousRight = right;
            this.drawLabel(label.text, x, plotBottom + TIME_LABEL_OFFSET_Y, 'center');
        }

        this.ctx.restore();
    }

    /**
     * The line between adjacent panes.
     *
     * Drawn from the gap the pane rects already leave rather than from a
     * recomputed position, so the line cannot land a pixel off the space the data
     * layer is clipping to — a separator that does not match the gap it fills
     * leaves a sliver of one pane's background showing.
     */
    private renderPaneSeparators(): void {
        const panes: PaneLayout | null = this.panes;
        if (panes === null || panes.rects.length < 2) return;
        const gap: number = this.options.panes.separatorHeight;
        if (gap <= 0) return;

        this.ctx.save();
        this.ctx.strokeStyle = this.options.panes.separatorColor;
        this.ctx.fillStyle = this.options.panes.separatorColor;
        this.ctx.lineWidth = 1;
        for (let index = 1; index < panes.rects.length; index++) {
            const above: PlotRect = panes.rects[index - 1];
            const y: number = above.y + above.height;
            this.ctx.beginPath();
            this.ctx.moveTo(panes.rects[index].x, Math.floor(y) + 0.5);
            this.ctx.lineTo(panes.rects[index].x + panes.rects[index].width, Math.floor(y) + 0.5);
            this.ctx.stroke();
            // A gap wider than one pixel is filled rather than outlined, so the
            // whole reserved space is covered and not just its centre line.
            if (gap > 1) {
                this.ctx.fillRect(panes.rects[index].x, y, panes.rects[index].width, gap - 1);
            }
        }
        this.ctx.restore();
    }

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
    private renderDecorations(viewport: ChartViewport, labels: DecorationLabels): void {
        const plot: PlotRect = viewport.plot;
        const plotRight: number = plot.x + plot.width;

        // Markers first, so a price line and its tag sit above them.
        this.renderMarkers(viewport, plot);

        for (const line of this.priceLines) {
            const y: number = this.pricePaneY(line.price);
            if (y < plot.y || y > plot.y + plot.height) continue;

            this.ctx.save();
            this.ctx.strokeStyle = this.cssColor(line.color);
            this.ctx.lineWidth = line.lineWidth;
            if (line.lineStyle === 'dashed') this.ctx.setLineDash([6, 4]);
            // The rule spans the plot and stops at its edge, so it never runs under
            // the price gutter; only the tag is allowed in there.
            this.ctx.beginPath();
            const crispY: number = Math.floor(y) + 0.5;
            this.ctx.moveTo(plot.x, crispY);
            this.ctx.lineTo(plotRight, crispY);
            this.ctx.stroke();
            this.ctx.restore();

            if (line.title.length > 0) {
                this.drawLabel(line.title, plot.x + 6, crispY, 'left');
            }
            if (line.axisLabelVisible) {
                const index: number | undefined = labels.lineIndex.get(y);
                if (index === undefined || labels.keep[index]) {
                    this.drawTag(
                        this.formatAxisValue(line.price),
                        plot.x - 6,
                        crispY,
                        line.axisLabelColor ?? line.color,
                    );
                }
            }
        }

        if (labels.lastShown && labels.lastY !== null && this.lastPrice !== null) {
            const y: number = this.pricePaneY(this.lastPrice.price);
            const crispY: number = Math.floor(y) + 0.5;
            const directionColor: readonly [number, number, number, number] =
                this.lastPrice.direction === 'up' ? this.colors.up : this.colors.down;
            // The rule keeps the candle's direction colour — it is a statement about the
            // series, and it is a line rather than a chip. The *tag* is a chip, so it takes
            // the configured background. If unset/transparent, it falls back to the candle's direction color.
            const configuredBg: readonly [number, number, number, number] =
                this.options.candlestick.lastPriceTagBackground;
            const background: readonly [number, number, number, number] =
                configuredBg[3] === 0 ? directionColor : configuredBg;
            const text: readonly [number, number, number, number] =
                this.options.candlestick.lastPriceTagText[3] === 0
                    ? contrastText(background)
                    : this.options.candlestick.lastPriceTagText;
            this.ctx.save();
            this.ctx.strokeStyle = this.cssColor(directionColor);
            this.ctx.lineWidth = 1;
            // Dashed so it reads as "where price is now" rather than as another
            // annotation the caller placed.
            this.ctx.setLineDash([2, 2]);
            this.ctx.beginPath();
            this.ctx.moveTo(plot.x, crispY);
            this.ctx.lineTo(plotRight, crispY);
            this.ctx.stroke();
            this.ctx.restore();
            this.drawTag(this.formatAxisValue(this.lastPrice.price), plot.x - 6, crispY, background, text);
        }
    }

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
    private renderZones(viewport: ChartViewport): void {
        if (this.zones.length === 0) return;
        const plot: PlotRect = viewport.plot;
        const drawn: PlacedZone[] = zonesWithinBudget(this.zones);

        for (const zone of drawn) {
            const yTop: number = this.pricePaneY(zone.top);
            const yBottom: number = this.pricePaneY(zone.bottom);
            if (yTop === yBottom) continue;

            // A zone entirely above or below the pane is not drawn at all. Clipping a
            // partially visible one is right; drawing a whole off-screen one is not.
            if (yTop < plot.y || yBottom > plot.y + plot.height) continue;

            // Split at the breaks inside the zone, so a level laid down on Friday and
            // still valid on Monday is drawn in both sessions and absent in the gap.
            // One rectangle spanning the whole thing is a claim that the level was
            // occupied continuously, including while the market was shut, and that is
            // the same claim the break exists to stop the chart making.
            const lastIndex: number = zone.toIndex ?? this.timeValues.length - 1;
            const runs: Array<[number, number]> = contiguousRuns(
                this.slotOffsets,
                zone.fromIndex,
                lastIndex,
                this.timeValues.length,
            );

            for (const [runStart, runEnd] of runs) {
                const x0: number = zone.extendLeft && runStart === runs[0][0]
                    ? plot.x
                    : indexToCoordinate(viewport, runStart) - viewport.scaleX / 2;
                const x1: number = zone.toIndex === null && runEnd === runs[runs.length - 1][1]
                    ? plot.x + plot.width
                    : indexToCoordinate(viewport, runEnd) + viewport.scaleX / 2;

                const left: number = Math.max(x0, plot.x);
                const right: number = Math.min(x1, plot.x + plot.width);
                if (right <= left) continue;

                this.ctx.save();
                this.ctx.beginPath();
                this.ctx.rect(left, Math.min(yTop, yBottom), right - left, Math.abs(yBottom - yTop));
                this.ctx.clip();
                if (zone.fill[3] > 0) {
                    this.ctx.fillStyle = this.cssColor(zone.fill);
                    this.ctx.fill();
                }
                this.ctx.restore();

                this.ctx.save();
                this.ctx.strokeStyle = this.cssColor(zone.border);
                // One CSS pixel, snapped to a device boundary. A 2px border is the
                // clearest tell that something is a web control rather than an
                // instrument.
                this.ctx.lineWidth = 1;
                if (zone.borderStyle === 'dashed') this.ctx.setLineDash([3, 3]);
                const leftEdge: number = Math.floor(left) + 0.5;
                const rightEdge: number = Math.round(right) - 0.5;
                const topEdge: number = Math.round(Math.min(yTop, yBottom)) + 0.5;
                const bottomEdge: number = Math.round(Math.max(yTop, yBottom)) - 0.5;
                this.ctx.beginPath();
                this.ctx.moveTo(leftEdge, topEdge);
                this.ctx.lineTo(rightEdge, topEdge);
                this.ctx.moveTo(leftEdge, bottomEdge);
                this.ctx.lineTo(rightEdge, bottomEdge);
                this.ctx.moveTo(leftEdge, topEdge);
                this.ctx.lineTo(leftEdge, bottomEdge);
                if (zone.toIndex !== null) this.ctx.lineTo(rightEdge, bottomEdge);
                this.ctx.stroke();
                this.ctx.restore();

                if (zone.label.length > 0 && runStart === runs[0][0]) {
                    // Above the zone, not inside it: a label inside a 6px zone is
                    // unreadable, which is the same reason zone labels are off by
                    // default. Once per zone rather than once per run, because a zone
                    // surviving a weekend is one level, and three labels saying so
                    // reads as three separate zones.
                    this.drawLabel(zone.label, left + 4, topEdge - 8, 'left');
                }
            }
        }
    }

    private renderMarkers(viewport: ChartViewport, plot: PlotRect): void {
        if (this.markers.length === 0) return;
        // A marker is a fixed number of pixels wide, so below a few pixels per bar a
        // screen of them is a smear. Dropped rather than shrunk.
        if (!shouldDrawMarkers(Math.abs(viewport.scaleX))) return;

        for (const marker of this.markers) {
            if (!Number.isFinite(marker.price)) continue;
            const x: number = indexToCoordinate(viewport, marker.index);
            if (x < plot.x - MARKER_MARGIN || x > plot.x + plot.width + MARKER_MARGIN) continue;

            const size: number = MARKER_SIZE * marker.size;
            let y: number = this.pricePaneY(marker.price);
            // Arrows stand off the bar they annotate; a circle or square sits on the
            // price itself, because a marker's job is to point at a level.
            if (marker.position === 'aboveBar') y -= MARKER_OFFSET;
            else if (marker.position === 'belowBar') y += MARKER_OFFSET;

            this.ctx.save();
            this.ctx.fillStyle = this.cssColor(marker.color);
            this.ctx.strokeStyle = this.cssColor(marker.color);
            this.ctx.lineWidth = 1.5;
            if (marker.shape === 'arrowUp' || marker.shape === 'arrowDown') {
                this.drawArrow(x, y, size, marker.shape === 'arrowUp' ? -1 : 1);
            } else if (marker.shape === 'circle') {
                this.ctx.beginPath();
                this.ctx.arc(x, y, size / 2, 0, Math.PI * 2);
                this.ctx.fill();
            } else {
                this.ctx.fillRect(x - size / 2, y - size / 2, size, size);
            }
            this.ctx.restore();

            if (marker.text.length > 0) {
                this.drawLabel(
                    marker.text,
                    x + size,
                    marker.position === 'belowBar' ? y + size : y - size,
                    'left',
                );
            }
        }
    }

    /** A filled triangle, pointing up or down, with its tip at `y`. */
    private drawArrow(x: number, y: number, size: number, direction: -1 | 1): void {
        const half: number = size / 2;
        const length: number = size * 0.9;
        this.ctx.beginPath();
        this.ctx.moveTo(x, y - direction * length / 2);
        this.ctx.lineTo(x - half, y + direction * length / 2);
        this.ctx.lineTo(x + half, y + direction * length / 2);
        this.ctx.closePath();
        this.ctx.fill();
    }

    /**
     * A tag in the price gutter, filled in its own colour so it reads as belonging
     * to the line or candle it labels rather than as another axis label.
     *
     * `textColor` is passed in rather than read from the theme because the text has to be
     * chosen against `color`, and the theme's text colour is a statement about the plot
     * rather than about a saturated fill. Omit it and the choice is made here.
     */
    private drawTag(
        text: string,
        x: number,
        y: number,
        color: readonly [number, number, number, number],
        textColor?: readonly [number, number, number, number],
        alignment: CanvasTextAlign = 'right'
    ): void {
        this.ctx.save();
        this.drawLabel(text, x, y, alignment);
        // drawLabel painted the usual background and text; repaint the box in the
        // tag's colour and the text over it, so the shape is the same size for every
        // tag and the collision planning above stays honest.
        this.ctx.fillStyle = this.cssColor(color);
        const metrics: TextMetrics = this.ctx.measureText(text);
        const padding: number = 3;
        const width: number = metrics.width + padding * 2;
        const boxLeft = alignment === 'right' 
            ? x - width + padding 
            : alignment === 'center'
                ? x - width / 2
                : x - padding;
                
        this.ctx.fillRect(boxLeft, y - AXIS_LABEL_HEIGHT / 2, width, AXIS_LABEL_HEIGHT);
        this.ctx.fillStyle = this.cssColor(textColor ?? contrastText(color));
        this.ctx.textAlign = alignment;
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(text, x, y);
        this.ctx.restore();
    }

    /** `rgba(...)` string for an already-parsed colour, keeping its own alpha. */
    private cssColor(color: readonly [number, number, number, number]): string {
        return this.withAlpha(color, color[3]);
    }

    private drawLabel(text: string, x: number, y: number, alignment: CanvasTextAlign): void {
        this.ctx.textAlign = alignment;
        const metrics: TextMetrics = this.ctx.measureText(text);
        const padding: number = 3;
        const textWidth: number = metrics.width + padding * 2;
        const textHeight: number = 14;
        const boxLeft: number = alignment === 'right'
            ? x - textWidth + padding
            : alignment === 'center'
                ? x - textWidth / 2
                : x - padding;
        this.ctx.fillStyle = this.withAlpha(this.colors.background, 0.92);
        this.ctx.fillRect(boxLeft, y - textHeight / 2, textWidth, textHeight);
        this.ctx.fillStyle = this.options.layout.textColor;
        this.ctx.fillText(text, x, y);
    }

    /** Price labels honour `priceFormat.precision` and the configured locale. */
    private formatAxisValue(value: number): string {
        if (!Number.isFinite(value)) return '';
        return this.priceFormatter.format(value);
    }

    /** Formats a real candle timestamp, choosing detail from the visible span. */
    private formatTimeAtTimestamp(timestamp: number): string {
        const date: Date = new Date(timestamp);
        const { locale, timeZone } = this.options;
        // Detail level depends on the visible span, so cache per span bucket.
        const viewport: ChartViewport = this.viewport;
        const plotRight: number = viewport.plot.x + viewport.plot.width;
        const firstVisibleIndex: number = this.nearestCandleIndex(
            coordinateToIndex(viewport, viewport.plot.x),
        );
        const lastVisibleIndex: number = this.nearestCandleIndex(
            coordinateToIndex(viewport, plotRight),
        );
        const visibleSpan: number = Math.abs(this.timeValues[lastVisibleIndex] - this.timeValues[firstVisibleIndex]);
        const detail: 'minute' | 'day' | 'month' = visibleSpan < 2 * 24 * 60 * 60 * 1000
            ? 'minute'
            : visibleSpan < 365 * 24 * 60 * 60 * 1000
                ? 'day'
                : 'month';
        const key: string = `${locale}|${timeZone}|${detail}`;
        if (this.timeFormatter === null || this.timeFormatterKey !== key) {
            const options: Intl.DateTimeFormatOptions = detail === 'minute'
                ? { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone }
                : detail === 'day'
                    ? { month: 'short', day: '2-digit', timeZone }
                    : { year: 'numeric', month: 'short', timeZone };
            this.timeFormatter = new Intl.DateTimeFormat(locale, options);
            this.timeFormatterKey = key;
        }
        return this.timeFormatter.format(date);
    }

    private nearestCandleIndex(index: number): number {
        return clampCandleIndex(index, this.timeValues.length);
    }
}
