// src/renderers/Canvas2DRenderer.ts
import type { IRenderer } from '../core/IRenderer';
import type { EventEmitter, ChartEvents } from '../core/EventEmitter';

export class Canvas2DRenderer implements IRenderer {
    private canvas!: HTMLCanvasElement;
    private emitter!: EventEmitter<ChartEvents>;
    private ctx!: CanvasRenderingContext2D;

    private offsetX: number = 0;
    private offsetY: number = 0;
    private scaleX: number = 1;
    private scaleY: number = 1;
    private devicePixelRatio: number = 1;
    private crosshairX: number | null = null;
    private crosshairY: number | null = null;
    private ohlcData: Float32Array | null = null;
    private timeValues: readonly number[] = [];
    
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

        if (!this.isGridLayer) {
            canvas.addEventListener('mousemove', this.handleMouseMove);
            canvas.addEventListener('mouseleave', this.handleMouseLeave);
        }
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
    };

    private handleDataEvent = (payload: ChartEvents['data']): void => {
        if (payload.ohlc.length % 6 !== 0) {
            throw new Error('MatrixCharts: OHLC data must contain x/open/high/low/close/width values.');
        }
        this.ohlcData = new Float32Array(payload.ohlc);
        this.timeValues = payload.times;
    };

    public clear(): void {
        const cssWidth: number = this.canvas.width / this.devicePixelRatio;
        const cssHeight: number = this.canvas.height / this.devicePixelRatio;
        this.ctx.clearRect(0, 0, cssWidth, cssHeight);
    }

    public render(): void {
        if (!this.isGridLayer) {
            this.renderCrosshair();
            return;
        }

        const cssWidth: number = this.canvas.width / this.devicePixelRatio;
        const cssHeight: number = this.canvas.height / this.devicePixelRatio;

        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'; // High-visibility institutional grid
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();

        const priceTickStep: number = this.niceStep(56 / Math.abs(this.scaleY));
        const [minimumVisiblePrice, maximumVisiblePrice]: [number, number] = this.getVisiblePriceRange(cssHeight);
        const firstPriceTick: number = Math.ceil(minimumVisiblePrice / priceTickStep) * priceTickStep;
        for (let price: number = firstPriceTick; price <= maximumVisiblePrice + priceTickStep * 1e-9; price += priceTickStep) {
            const y: number = this.offsetY + price * this.scaleY;
            if (y < 0 || y > cssHeight) continue;
            const crispY: number = Math.floor(y) + 0.5;
            this.ctx.moveTo(0, crispY);
            this.ctx.lineTo(cssWidth, crispY);
        }

        const timeTickStep: number = this.niceStep(96 / this.scaleX);
        const firstTimeTick: number = Math.ceil((-this.offsetX / this.scaleX) / timeTickStep) * timeTickStep;
        for (let time: number = firstTimeTick; ; time += timeTickStep) {
            const x: number = this.offsetX + time * this.scaleX;
            if (x > cssWidth) break;
            if (x < 0) continue;
            const crispX: number = Math.floor(x) + 0.5;
            this.ctx.moveTo(crispX, 0);
            this.ctx.lineTo(crispX, cssHeight);
        }

        this.ctx.stroke();
        this.renderAxes(cssWidth, cssHeight, priceTickStep, timeTickStep, firstTimeTick);
        this.ctx.restore();
    }

    public destroy(): void {
        if (this.emitter) {
            this.emitter.off('viewport', this.handleViewportEvent);
            this.emitter.off('data', this.handleDataEvent);
        }
        if (!this.isGridLayer) {
            this.canvas.removeEventListener('mousemove', this.handleMouseMove);
            this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
        }
        this.clear();
    }

    private handleMouseMove = (event: MouseEvent): void => {
        const bounds: DOMRect = this.canvas.getBoundingClientRect();
        this.crosshairX = event.clientX - bounds.left;
        this.crosshairY = event.clientY - bounds.top;
        this.clear();
        this.render();
    };

    private handleMouseLeave = (): void => {
        this.crosshairX = null;
        this.crosshairY = null;
        this.clear();
    };

    private renderCrosshair(): void {
        if (this.crosshairX === null || this.crosshairY === null) return;

        const cssWidth: number = this.canvas.width / this.devicePixelRatio;
        const cssHeight: number = this.canvas.height / this.devicePixelRatio;

        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(0, 220, 255, 0.85)';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([4, 4]);
        this.ctx.beginPath();
        this.ctx.moveTo(this.crosshairX + 0.5, 0);
        this.ctx.lineTo(this.crosshairX + 0.5, cssHeight);
        this.ctx.moveTo(0, this.crosshairY + 0.5);
        this.ctx.lineTo(cssWidth, this.crosshairY + 0.5);
        this.ctx.stroke();
        this.ctx.restore();
        this.renderOHLCLabels(cssWidth, cssHeight);
    }

    private renderOHLCLabels(cssWidth: number, cssHeight: number): void {
        if (!this.ohlcData || this.ohlcData.length === 0 || this.crosshairX === null || this.crosshairY === null) {
            return;
        }

        const cursorDataX: number = (this.crosshairX - this.offsetX) / this.scaleX;
        let nearestCandleIndex: number = 0;
        let nearestDistance: number = Number.POSITIVE_INFINITY;
        const candleCount: number = this.ohlcData.length / 6;
        for (let candleIndex: number = 0; candleIndex < candleCount; candleIndex++) {
            const candleX: number = this.ohlcData[candleIndex * 6];
            const distance: number = Math.abs(candleX - cursorDataX);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestCandleIndex = candleIndex;
            }
        }

        const dataIndex: number = nearestCandleIndex * 6;
        const candleX: number = this.ohlcData[dataIndex];
        const open: number = this.ohlcData[dataIndex + 1];
        const high: number = this.ohlcData[dataIndex + 2];
        const low: number = this.ohlcData[dataIndex + 3];
        const close: number = this.ohlcData[dataIndex + 4];
        const panelX: number = 10;
        const panelY: number = 10;
        const panelWidth: number = 158;
        const panelHeight: number = 58;
        const timeLabel: string = `T ${this.formatTimeAtIndex(candleX)}`;
        const valueLabels: string[] = [
            `O ${this.formatAxisValue(open)}`,
            `H ${this.formatAxisValue(high)}`,
            `L ${this.formatAxisValue(low)}`,
            `C ${this.formatAxisValue(close)}`,
        ];

        this.ctx.save();
        this.ctx.font = '11px sans-serif';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = 'rgba(13, 17, 23, 0.92)';
        this.ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
        this.ctx.strokeStyle = close >= open
            ? 'rgba(26, 218, 145, 0.85)'
            : 'rgba(245, 72, 90, 0.85)';
        this.ctx.strokeRect(panelX + 0.5, panelY + 0.5, panelWidth - 1, panelHeight - 1);
        this.ctx.fillStyle = 'rgba(201, 209, 217, 0.9)';
        this.ctx.fillText(timeLabel, panelX + 8, panelY + 10);
        for (let valueIndex: number = 0; valueIndex < valueLabels.length; valueIndex++) {
            const columnX: number = panelX + 8 + (valueIndex % 2) * 76;
            const rowY: number = panelY + 29 + Math.floor(valueIndex / 2) * 16;
            this.ctx.fillText(valueLabels[valueIndex], columnX, rowY);
        }

        const currentPrice: number = (this.crosshairY - this.offsetY) / this.scaleY;
        this.drawLabel(this.formatAxisValue(currentPrice), cssWidth - 6, this.crosshairY, 'right');
        this.drawLabel(this.formatTimeAtIndex(candleX), this.crosshairX + 6, cssHeight - 10, 'left');
        this.ctx.restore();
    }

    private renderAxes(
        cssWidth: number,
        cssHeight: number,
        priceTickStep: number,
        timeTickStep: number,
        firstTimeTick: number,
    ): void {
        this.ctx.save();
        this.ctx.font = '11px sans-serif';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = 'rgba(201, 209, 217, 0.9)';
        this.ctx.strokeStyle = 'rgba(201, 209, 217, 0.35)';
        this.ctx.lineWidth = 1;

        this.ctx.beginPath();
        this.ctx.moveTo(0.5, 0);
        this.ctx.lineTo(0.5, cssHeight);
        this.ctx.moveTo(0, cssHeight - 0.5);
        this.ctx.lineTo(cssWidth, cssHeight - 0.5);
        this.ctx.stroke();

        const [minimumVisiblePrice, maximumVisiblePrice]: [number, number] = this.getVisiblePriceRange(cssHeight);
        const firstPriceTick: number = Math.ceil(minimumVisiblePrice / priceTickStep) * priceTickStep;
        for (let price: number = firstPriceTick; price <= maximumVisiblePrice + priceTickStep * 1e-9; price += priceTickStep) {
            const y: number = this.offsetY + price * this.scaleY;
            if (y >= 0 && y <= cssHeight) this.drawLabel(this.formatAxisValue(price), 6, y, 'left');
        }

        for (let time: number = firstTimeTick; ; time += timeTickStep) {
            const x: number = this.offsetX + time * this.scaleX;
            if (x > cssWidth) break;
            if (x >= 0) this.drawLabel(this.formatTimeAtIndex(time), x + 4, cssHeight - 10, 'left');
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
        this.ctx.fillStyle = 'rgba(13, 17, 23, 0.78)';
        this.ctx.fillRect(boxLeft, y - textHeight / 2, textWidth, textHeight);
        this.ctx.fillStyle = 'rgba(201, 209, 217, 0.9)';
        this.ctx.fillText(text, x, y);
    }

    private formatAxisValue(value: number): string {
        if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
        if (Number.isInteger(value)) return value.toString();
        return value.toFixed(1);
    }

    private formatTimeAtIndex(index: number): string {
        if (this.timeValues.length === 0) return this.formatAxisValue(index);

        const clampedIndex: number = Math.max(0, Math.min(this.timeValues.length - 1, index));
        const lowerIndex: number = Math.floor(clampedIndex);
        const upperIndex: number = Math.min(lowerIndex + 1, this.timeValues.length - 1);
        const fraction: number = clampedIndex - lowerIndex;
        const timestamp: number = this.timeValues[lowerIndex] +
            (this.timeValues[upperIndex] - this.timeValues[lowerIndex]) * fraction;
        const date: Date = new Date(timestamp);
        const dataSpan: number = this.timeValues[this.timeValues.length - 1] - this.timeValues[0];
        const averageInterval: number = dataSpan / Math.max(this.timeValues.length - 1, 1);
        const cssWidth: number = this.canvas.width / this.devicePixelRatio;
        const visibleSpan: number = averageInterval * cssWidth / this.scaleX;
        const options: Intl.DateTimeFormatOptions = visibleSpan < 2 * 24 * 60 * 60 * 1000
            ? { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }
            : visibleSpan < 365 * 24 * 60 * 60 * 1000
                ? { month: 'short', day: '2-digit' }
                : { year: 'numeric', month: 'short' };
        return new Intl.DateTimeFormat(undefined, options).format(date);
    }

    private niceStep(targetStep: number): number {
        if (!Number.isFinite(targetStep) || targetStep <= 0) return 1;
        const magnitude: number = Math.pow(10, Math.floor(Math.log10(targetStep)));
        const normalized: number = targetStep / magnitude;
        const factor: number = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
        return factor * magnitude;
    }

    private getVisiblePriceRange(cssHeight: number): [number, number] {
        const priceAtTop: number = -this.offsetY / this.scaleY;
        const priceAtBottom: number = (cssHeight - this.offsetY) / this.scaleY;
        return [Math.min(priceAtTop, priceAtBottom), Math.max(priceAtTop, priceAtBottom)];
    }
}