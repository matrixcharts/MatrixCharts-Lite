import type { EventEmitter, ChartEvents } from '../core/EventEmitter.js';
import type { IDataRenderer } from '../core/IDataRenderer.js';
import type { PlotRect } from '../core/coordinates.js';
import type { ResolvedVolumeColors } from '../core/options.js';
import type { CandleRenderSpec, Rgba } from './WebGL2Renderer.js';
import type { VerticalTransform } from './WebGLSeries.js';
import { CANDLE_CLOSE, CANDLE_HIGH, CANDLE_LOW, CANDLE_OPEN, CANDLE_STRIDE, CANDLE_VOLUME } from '../math/candleLayout.js';

/** Bounded Canvas2D data fallback sharing the engine's CSS-pixel geometry contract. */
export class Canvas2DDataRenderer implements IDataRenderer {
    private canvas!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;
    private emitter!: EventEmitter<ChartEvents>;
    private offsetX = 0;
    private offsetY = 0;
    private scaleX = 1;
    private scaleY = 1;
    private plot: PlotRect = { x: 0, y: 0, width: 0, height: 0 };
    private dpr = 1;
    private candles = new Float32Array(0);
    private candleSpec: CandleRenderSpec | null = null;
    private line = new Float32Array(0);
    private lineColor: Rgba = [1, 1, 1, 1];
    private area = new Float32Array(0);
    private areaFill: Rgba = [0, 0, 0, 0];
    private histogram = new Float32Array(0);
    private histogramColors: ResolvedVolumeColors | null = null;
    private histogramScaleY = 0;
    private histogramOffsetY = 0;
    private overlays = new Map<string, { points: Float32Array; stride: 2 | 6; color: Rgba; vertical: VerticalTransform | null; pane: number }>();

    public init(canvas: HTMLCanvasElement, emitter: EventEmitter<ChartEvents>): void {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('MatrixCharts: Canvas2D is unavailable.');
        this.canvas = canvas;
        this.ctx = context;
        this.emitter = emitter;
        emitter.on('viewport', this.handleViewport);
    }

    public resize(width: number, height: number, dpr: number): void {
        this.dpr = dpr;
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    public clear(): void {
        this.ctx.clearRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
    }

    public render(): void {
        const ctx = this.ctx;
        const plot = this.plot;
        ctx.save();
        ctx.beginPath();
        ctx.rect(plot.x, plot.y, plot.width, plot.height);
        ctx.clip();
        this.renderHistogram();
        this.renderArea();
        this.renderOverlays();
        this.renderCandles();
        this.renderLine();
        ctx.restore();
    }

    public destroy(): void {
        if (this.emitter) this.emitter.off('viewport', this.handleViewport);
        this.overlays.clear();
        this.candles = new Float32Array(0);
        this.line = new Float32Array(0);
        this.area = new Float32Array(0);
        this.histogram = new Float32Array(0);
    }

    public drawCandlesticks(candles: Float32Array, spec: CandleRenderSpec): void {
        this.candles = new Float32Array(candles);
        this.candleSpec = spec;
    }

    public clearCandlesticks(): void { this.candles = new Float32Array(0); }

    public retainOverlays(activeIds: ReadonlySet<string>): void {
        for (const id of this.overlays.keys()) if (!activeIds.has(id)) this.overlays.delete(id);
    }

    public drawOverlay(id: string, points: Float32Array, stride: 2 | 6, color: Rgba, vertical: VerticalTransform | null, pane = 0): void {
        this.overlays.set(id, { points, stride, color, vertical, pane });
    }

    public drawLine(points: Float32Array, color: Rgba): void { this.line = new Float32Array(points); this.lineColor = color; }
    public clearLine(): void { this.line = new Float32Array(0); }
    public drawArea(points: Float32Array, fill: Rgba): void { this.area = new Float32Array(points); this.areaFill = fill; }
    public clearArea(): void { this.area = new Float32Array(0); }

    public drawHistogram(levels: Float32Array, colors: ResolvedVolumeColors, scaleY: number, offsetY: number): void {
        this.histogram = new Float32Array(levels);
        this.histogramColors = colors;
        this.histogramScaleY = scaleY;
        this.histogramOffsetY = offsetY;
    }

    public clearHistogram(): void { this.histogram = new Float32Array(0); }

    private handleViewport = (payload: ChartEvents['viewport']): void => {
        this.offsetX = payload.offsetX;
        this.offsetY = payload.offsetY;
        this.scaleX = payload.scaleX;
        this.scaleY = payload.scaleY;
        this.plot = payload.plot;
    };

    private x(value: number): number { return this.offsetX + value * this.scaleX; }
    private y(value: number, vertical: VerticalTransform | null = null): number {
        const transform = vertical ?? { scaleY: this.scaleY, offsetY: this.offsetY };
        return transform.offsetY + value * transform.scaleY;
    }
    private css(color: readonly [number, number, number, number]): string {
        return `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${color[3]})`;
    }

    private renderCandles(): void {
        if (!this.candleSpec) return;
        const spec = this.candleSpec;
        const ctx = this.ctx;
        for (let offset = 0; offset < this.candles.length; offset += CANDLE_STRIDE) {
            const x = this.x(this.candles[offset]);
            const open = this.y(this.candles[offset + CANDLE_OPEN]);
            const close = this.y(this.candles[offset + CANDLE_CLOSE]);
            const high = this.y(this.candles[offset + CANDLE_HIGH]);
            const low = this.y(this.candles[offset + CANDLE_LOW]);
            const up = this.candles[offset + CANDLE_CLOSE] >= this.candles[offset + CANDLE_OPEN];
            const color = up ? spec.colors.up : spec.colors.down;
            ctx.strokeStyle = this.css(color);
            ctx.fillStyle = this.css(color);
            if (spec.wickVisible) { ctx.beginPath(); ctx.moveTo(x, high); ctx.lineTo(x, low); ctx.stroke(); }
            if (spec.style === 'ohlc') {
                ctx.beginPath(); ctx.moveTo(x - this.scaleX * 0.35, open); ctx.lineTo(x, open); ctx.moveTo(x, close); ctx.lineTo(x + this.scaleX * 0.35, close); ctx.stroke();
                continue;
            }
            if (spec.style === 'hollow') {
                ctx.strokeRect(x - this.scaleX * 0.35, Math.min(open, close), this.scaleX * 0.7, Math.max(Math.abs(close - open), 1));
            } else {
                ctx.fillRect(x - this.scaleX * 0.35, Math.min(open, close), this.scaleX * 0.7, Math.max(Math.abs(close - open), 1));
            }
        }
    }

    private renderLine(): void { this.renderPolyline(this.line, this.lineColor, null); }
    private renderArea(): void {
        if (this.area.length < 4) return;
        this.renderPolyline(this.area, this.areaFill, null);
        const firstX = this.x(this.area[0]);
        const last = this.area.length - 2;
        const lastX = this.x(this.area[last]);
        const baseline = this.y(0);
        this.ctx.fillStyle = this.css(this.areaFill);
        this.ctx.beginPath();
        this.ctx.moveTo(firstX, baseline);
        for (let offset = 0; offset < this.area.length; offset += 2) this.ctx.lineTo(this.x(this.area[offset]), this.y(this.area[offset + 1]));
        this.ctx.lineTo(lastX, baseline);
        this.ctx.closePath();
        this.ctx.fill();
    }
    private renderPolyline(points: Float32Array, color: Rgba, vertical: VerticalTransform | null): void {
        if (points.length < 4) return;
        this.ctx.strokeStyle = this.css(color);
        this.ctx.beginPath();
        this.ctx.moveTo(this.x(points[0]), this.y(points[1], vertical));
        for (let offset = 2; offset < points.length; offset += 2) this.ctx.lineTo(this.x(points[offset]), this.y(points[offset + 1], vertical));
        this.ctx.stroke();
    }
    private renderOverlays(): void {
        for (const entry of this.overlays.values()) {
            if (entry.points.length < entry.stride * 2) continue;
            this.ctx.strokeStyle = this.css(entry.color);
            this.ctx.beginPath();
            this.ctx.moveTo(this.x(entry.points[0]), this.y(entry.points[1], entry.vertical));
            for (let offset = entry.stride; offset < entry.points.length; offset += entry.stride) {
                this.ctx.lineTo(this.x(entry.points[offset]), this.y(entry.points[offset + 1], entry.vertical));
            }
            this.ctx.stroke();
        }
    }
    private renderHistogram(): void {
        if (this.histogram.length === 0 || this.histogramColors === null) return;
        for (let offset = 0; offset < this.histogram.length; offset += CANDLE_STRIDE) {
            const x = this.x(this.histogram[offset]);
            const y = this.histogramOffsetY + this.histogram[offset + CANDLE_VOLUME] * this.histogramScaleY;
            this.ctx.fillStyle = this.css(this.histogram[offset + CANDLE_CLOSE] >= this.histogram[offset + CANDLE_OPEN] ? this.histogramColors.up : this.histogramColors.down);
            this.ctx.fillRect(x - this.scaleX * 0.35, y, this.scaleX * 0.7, this.plot.y + this.plot.height - y);
        }
    }
}
