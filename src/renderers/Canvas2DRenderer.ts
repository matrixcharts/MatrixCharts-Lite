// src/renderers/Canvas2DRenderer.ts
import type { IRenderer } from '../core/IRenderer';

export class Canvas2DRenderer implements IRenderer {
    private canvas!: HTMLCanvasElement;
    private ctx!: CanvasRenderingContext2D;

    private offsetX: number = 0;
    private offsetY: number = 0;
    private scaleX: number = 1;
    private scaleY: number = 1;
    private devicePixelRatio: number = 1;
    private crosshairX: number | null = null;
    private crosshairY: number | null = null;
    private ohlcData: Float32Array | null = null;
    
    private isGridLayer: boolean;

    // FIX: Add a flag to prevent the UI layer from drawing the grid
    constructor(isGridLayer: boolean = true) {
        this.isGridLayer = isGridLayer;
    }

    public init(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        const context = canvas.getContext('2d');
        if (!context) throw new Error("MatrixCharts: Failed to initialize 2D context.");
        this.ctx = context;
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

    public setViewport(offsetX: number, offsetY: number, scaleX: number, scaleY: number): void {
        this.offsetX = offsetX;
        this.offsetY = offsetY;
        this.scaleX = scaleX;
        this.scaleY = scaleY;
    }

    public setOHLCData(candles: Float32Array): void {
        if (candles.length % 6 !== 0) {
            throw new Error('MatrixCharts: OHLC data must contain x/open/high/low/close/width values.');
        }
        this.ohlcData = new Float32Array(candles);
    }

    public clear(): void {
        const cssWidth = this.canvas.width / window.devicePixelRatio;
        const cssHeight = this.canvas.height / window.devicePixelRatio;
        this.ctx.clearRect(0, 0, cssWidth, cssHeight);
    }

    public render(): void {
        if (!this.isGridLayer) {
            this.renderCrosshair();
            return;
        }

        const cssWidth = this.canvas.width / window.devicePixelRatio;
        const cssHeight = this.canvas.height / window.devicePixelRatio;

        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'; // High-visibility institutional grid
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();

        // 1. Draw Horizontal Grid Lines (Price/Y-Axis)
        // Static for now since we are currently only panning on the X-axis
        const horizontalSpacing = 50;
        for (let y = 0; y <= cssHeight; y += horizontalSpacing) {
            // Offset by 0.5 pixels for perfectly crisp 1px lines on standard displays
            const crispY = Math.floor(y) + 0.5; 
            this.ctx.moveTo(0, crispY);
            this.ctx.lineTo(cssWidth, crispY);
        }

        // 2. Draw Vertical Grid Lines (Time/X-Axis) with Adaptive Zoom Scaling
        const baseSpacing = 100;
        
        // Calculate a logarithmic scaling factor so the grid adapts dynamically
        // When you zoom out, the lines double in spacing to prevent clumping.
        const zoomLevel = Math.floor(Math.log2(this.scaleX));
        const dynamicDataStep = baseSpacing * Math.pow(2, -zoomLevel);
        
        // Multiply by the current scale to get the actual pixel distance on screen
        const visiblePixelStep = dynamicDataStep * this.scaleX;

        // Calculate where the first vertical line should start based on the pan offset
        const startX = (this.offsetX % visiblePixelStep) - visiblePixelStep;

        for (let x = startX; x < cssWidth + visiblePixelStep; x += visiblePixelStep) {
            const crispX = Math.floor(x) + 0.5;
            this.ctx.moveTo(crispX, 0);
            this.ctx.lineTo(crispX, cssHeight);
        }

        this.ctx.stroke();
        this.renderAxes(cssWidth, cssHeight, horizontalSpacing, visiblePixelStep, startX);
        this.ctx.restore();
    }

    public destroy(): void {
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
        const timeLabel: string = `T ${this.formatAxisValue(candleX)}`;
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
        this.drawLabel(this.formatAxisValue(candleX), this.crosshairX + 6, cssHeight - 10, 'left');
        this.ctx.restore();
    }

    private renderAxes(
        cssWidth: number,
        cssHeight: number,
        horizontalSpacing: number,
        visiblePixelStep: number,
        startX: number,
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

        for (let y: number = 0; y <= cssHeight; y += horizontalSpacing) {
            const price: number = (y - this.offsetY) / this.scaleY;
            this.drawLabel(this.formatAxisValue(price), 6, y, 'left');
        }

        for (let x: number = startX; x < cssWidth + visiblePixelStep; x += visiblePixelStep) {
            if (x < 0 || x > cssWidth) continue;
            const time: number = (x - this.offsetX) / this.scaleX;
            this.drawLabel(this.formatAxisValue(time), x + 4, cssHeight - 10, 'left');
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
}