// src/renderers/Canvas2DRenderer.ts
import type { IRenderer } from '../core/IRenderer.js';
import type { EventEmitter, ChartEvents } from '../core/EventEmitter.js';
import type { CandleData } from '../core/CandleData.js';
import {
    parseCssColor,
    themeDefaults,
    type ResolvedChartOptions,
} from '../core/options.js';
import {
    type ChartViewport,
    type PlotRect,
    clampCandleIndex,
    coordinateToIndex,
    coordinateToPrice,
    indexToCoordinate,
    priceToCoordinate,
    visiblePriceRange,
} from '../core/coordinates.js';
import { paneTickStep, paneValueAt, paneValueSpan, MIN_PANE_TICKS, type PaneLayout } from '../core/panes.js';
import type { VerticalTransform } from './WebGLSeries.js';

/**
 * Vertical centre of a time-axis label, measured from the plot's bottom edge. The
 * default time gutter is 22px, so 13px puts the text roughly centred in it.
 */
const TIME_LABEL_OFFSET_Y = 13;

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
    step: number;
    range: [number, number];
}

export class Canvas2DRenderer implements IRenderer {
    private canvas!: HTMLCanvasElement;
    private emitter!: EventEmitter<ChartEvents>;
    private ctx!: CanvasRenderingContext2D;

    private offsetX: number = 0;
    private offsetY: number = 0;
    private scaleX: number = 1;
    private scaleY: number = 1;
    /** Region series occupy. Equals the canvas until the axes claim space. */
    private plot: PlotRect = { x: 0, y: 0, width: 0, height: 0 };
    private devicePixelRatio: number = 1;
    private crosshairX: number | null = null;
    private crosshairY: number | null = null;
    private crosshairTime: number | null = null;
    private crosshairCandle: CandleData | null = null;
    private timeValues: readonly number[] = [];
    private options: ResolvedChartOptions = themeDefaults('dark');
    // Parsed once per apply, not per label or per frame.
    private colors = this.parseColors(themeDefaults('dark'));
    private priceFormatter: Intl.NumberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    private timeFormatter: Intl.DateTimeFormat | null = null;
    private timeFormatterKey: string = '';
    /**
     * Pane rects and vertical transforms for the current frame, or `null` when no
     * panes were declared. Null is the single-pane case, which is drawn from the
     * price scale across the whole plot exactly as it was before panes existed.
     */
    private panes: PaneLayout | null = null;
    
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
        this.scaleY = payload.scaleY;
        this.plot = payload.plot;
        // Absent means no panes were declared, and every label is then drawn from
        // the price scale across the whole plot, as before.
        this.panes = payload.panes ?? null;
    };

    private handleOptionsEvent = (options: ResolvedChartOptions): void => {
        this.options = options;
        this.colors = this.parseColors(options);
        this.priceFormatter = new Intl.NumberFormat(options.locale, {
            maximumFractionDigits: options.priceFormat.precision,
        });
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
        if (!this.isGridLayer) {
            this.clear();
            this.render();
        }
    };

    private handleDataEvent = (payload: ChartEvents['data']): void => {
        this.timeValues = payload.times;
    };

    private get viewport(): ChartViewport {
        const cssWidth: number = this.canvas.width / this.devicePixelRatio;
        const cssHeight: number = this.canvas.height / this.devicePixelRatio;
        return {
            offsetX: this.offsetX,
            offsetY: this.offsetY,
            scaleX: this.scaleX,
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
        this.ctx.beginPath();

        const timeTickStep: number = this.niceStep(96 / this.scaleX);
        const firstTimeTick: number = Math.ceil(
            coordinateToIndex(viewport, plot.x) / timeTickStep,
        ) * timeTickStep;

        if (this.options.grid.horzLines) {
            // Horizontal lines are per pane, from that pane's own scale. Drawing
            // them from the price scale across the whole plot would put a price
            // grid through an RSI pane, labelling it in prices it does not have.
            for (const band of this.priceBands()) {
                const [minimumVisiblePrice, maximumVisiblePrice]: [number, number] = band.range;
                const firstPriceTick: number = Math.ceil(minimumVisiblePrice / band.step) * band.step;
                for (let price: number = firstPriceTick; price <= maximumVisiblePrice + band.step * 1e-9; price += band.step) {
                    const y: number = band.y(price);
                    if (y < band.rect.y || y > band.rect.y + band.rect.height) continue;
                    const crispY: number = Math.floor(y) + 0.5;
                    this.ctx.moveTo(plot.x, crispY);
                    this.ctx.lineTo(plotRight, crispY);
                }
            }
        }

        if (this.options.grid.vertLines) {
            for (let time: number = firstTimeTick; ; time += timeTickStep) {
                const x: number = indexToCoordinate(viewport, time);
                if (x > plotRight) break;
                if (x < plot.x) continue;
                const crispX: number = Math.floor(x) + 0.5;
                this.ctx.moveTo(crispX, plot.y);
                this.ctx.lineTo(crispX, plotBottom);
            }
        }

        this.ctx.stroke();
        this.renderAxes(viewport, timeTickStep, firstTimeTick);
        this.ctx.restore();
    }

    /**
     * One price band per pane: the rect, the transform from a value to a y within
     * it, and a tick step sized to that pane's own scale.
     *
     * With no panes declared this is a single band covering the whole plot on the
     * price scale, which is the behaviour that shipped before panes existed.
     */
    private priceBands(): PriceBand[] {
        const viewport: ChartViewport = this.viewport;
        const panes: PaneLayout | null = this.panes;
        if (panes === null || panes.rects.length === 0) {
            return [{
                rect: viewport.plot,
                y: (price: number): number => priceToCoordinate(viewport, price),
                step: this.priceTickStepFor(viewport.scaleY, viewport.plot, true),
                range: visiblePriceRange(viewport),
            }];
        }
        const bands: PriceBand[] = [];
        for (let index = 0; index < panes.rects.length; index++) {
            const rect: PlotRect = panes.rects[index];
            if (rect.height <= 0) continue;
            const transform: VerticalTransform = panes.transforms[index];
            // A pane with nothing on it is left unlabelled rather than given the
            // placeholder 0-to-1 scale, which would read as a real axis on a chart
            // with nothing plotted.
            if (panes.empty[index]) continue;
            const top: number = paneValueAt(transform, rect.y);
            const bottom: number = paneValueAt(transform, rect.y + rect.height);
            bands.push({
                rect,
                y: (price: number): number => transform.offsetY + price * transform.scaleY,
                step: this.priceTickStepFor(transform.scaleY, rect, index === 0),
                range: [Math.min(top, bottom), Math.max(top, bottom)],
            });
        }
        return bands;
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
        this.ctx.moveTo(this.crosshairX + 0.5, plot.y);
        this.ctx.lineTo(this.crosshairX + 0.5, plot.y + plot.height);
        this.ctx.moveTo(plot.x, this.crosshairY + 0.5);
        this.ctx.lineTo(plot.x + plot.width, this.crosshairY + 0.5);
        this.ctx.stroke();
        this.ctx.restore();
        this.renderCrosshairReadout(viewport);
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
        if (candle) {
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

            this.ctx.save();
            this.ctx.font = '11px sans-serif';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillStyle = this.withAlpha(this.colors.background, 0.96);
            this.ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
            this.ctx.strokeStyle = this.withAlpha(bullish ? this.colors.up : this.colors.down, 0.95);
            this.ctx.strokeRect(panelX + 0.5, panelY + 0.5, panelWidth - 1, panelHeight - 1);
            this.ctx.fillStyle = this.options.layout.textColor;
            this.ctx.fillText(timeLabel, panelX + 8, panelY + 10);
            for (let valueIndex: number = 0; valueIndex < valueLabels.length; valueIndex++) {
                const columnX: number = panelX + 8 + (valueIndex % 2) * 76;
                const rowY: number = panelY + 29 + Math.floor(valueIndex / 2) * 16;
                this.ctx.fillText(valueLabels[valueIndex], columnX, rowY);
            }
            this.ctx.restore();
        }

        // Both tags annotate a rule that is drawn across the plot, so they belong
        // in the gutter beside that rule: the price tag in the price gutter, the
        // time tag in the time gutter.
        const currentPrice: number = coordinateToPrice(viewport, this.crosshairY);
        this.drawLabel(
            this.formatAxisValue(currentPrice),
            plot.x - 6,
            this.crosshairY,
            'right',
        );
        const timeTag: string = this.crosshairTime === null
            ? this.formatAxisValue(this.crosshairX)
            : this.formatTimeAtTimestamp(this.crosshairTime);
        this.drawLabel(
            timeTag,
            this.crosshairX,
            plot.y + plot.height + TIME_LABEL_OFFSET_Y,
            'center',
        );
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
        timeTickStep: number,
        firstTimeTick: number,
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

        // One set of price labels per pane, from that pane's own scale.
        for (const band of this.priceBands()) {
            const [minimumVisiblePrice, maximumVisiblePrice]: [number, number] = band.range;
            const firstPriceTick: number = Math.ceil(minimumVisiblePrice / band.step) * band.step;
            for (let price: number = firstPriceTick; price <= maximumVisiblePrice + band.step * 1e-9; price += band.step) {
                const y: number = band.y(price);
                if (y < band.rect.y || y > band.rect.y + band.rect.height) continue;
                this.drawLabel(this.formatAxisValue(price), plot.x - 6, y, 'right');
            }
        }

        // Separators are drawn after the labels so a division reads as sitting on
        // top of both panes rather than being interrupted by the label boxes.
        this.renderPaneSeparators();

        for (let time: number = firstTimeTick; ; time += timeTickStep) {
            const x: number = indexToCoordinate(viewport, time);
            if (x > plotRight) break;
            if (x < plot.x) continue;
            this.drawLabel(this.formatTimeAtIndex(time), x, plotBottom + TIME_LABEL_OFFSET_Y, 'center');
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

    /**
     * Tick step for one pane's own scale.
     *
     * `priceFormat.minMove` is the instrument's tradable increment, which is a
     * property of prices and therefore belongs to the price pane only. Applying it
     * to a pane holding an RSI would round every tick to a multiple of 0.01 and
     * leave a pane spanning 0 to 100 labelled with a tick every hundredth.
     */
    /**
     * Tick step for one pane's own scale.
     *
     * `priceFormat.minMove` is the instrument's tradable increment, which is a
     * property of prices and therefore belongs to the price pane only. Applying it
     * to a pane holding an RSI would round every tick to a multiple of 0.01 and
     * leave a pane spanning 0 to 100 labelled with a tick every hundredth.
     *
     * A non-price pane also gets a minimum tick *count*. Sizing a step from a fixed
     * pixel spacing suits a tall pane and starves a short one: an RSI pane a
     * quarter as tall as the price pane still spans its whole range in far fewer
     * pixels, so a step chosen for 56px of separation rounds up past the pane's
     * own range and leaves a single label on the axis — an RSI you cannot read a
     * level off.
     */
    private priceTickStepFor(scaleY: number, rect: PlotRect, isPricePane: boolean): number {
        const pixelTarget: number = 56 / Math.abs(scaleY);
        // The span comes from the pane module rather than being recomputed here,
        // because combining a rect with a transform is exactly where the units get
        // mixed up, and getting it wrong is completely silent.
        const span: number = paneValueSpan(rect, { scaleY, offsetY: 0 });
        const target: number = isPricePane
            ? this.niceStep(pixelTarget)
            : paneTickStep(span, pixelTarget, MIN_PANE_TICKS, (value: number): number => this.niceStep(value));

        const { minMove } = this.options.priceFormat;
        if (!isPricePane || !(minMove > 0)) return target;
        const steps: number = Math.ceil(target / minMove - 1e-9);
        return Math.max(minMove, steps * minMove);
    }
    private formatTimeAtIndex(index: number): string {
        if (this.timeValues.length === 0) return this.formatAxisValue(index);
        const candleIndex: number = this.nearestCandleIndex(index);
        return this.formatTimeAtTimestamp(this.timeValues[candleIndex]);
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

    private niceStep(targetStep: number): number {
        if (!Number.isFinite(targetStep) || targetStep <= 0) return 1;
        const magnitude: number = Math.pow(10, Math.floor(Math.log10(targetStep)));
        const normalized: number = targetStep / magnitude;
        const factor: number = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
        return factor * magnitude;
    }
}