"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Canvas2DDataRenderer = void 0;
const candleLayout_js_1 = require("../math/candleLayout.js");
/** Bounded Canvas2D data fallback sharing the engine's CSS-pixel geometry contract. */
class Canvas2DDataRenderer {
    constructor() {
        this.offsetX = 0;
        this.offsetY = 0;
        this.scaleX = 1;
        this.scaleY = 1;
        this.plot = { x: 0, y: 0, width: 0, height: 0 };
        this.dpr = 1;
        this.candles = new Float32Array(0);
        this.candleSpec = null;
        this.line = new Float32Array(0);
        this.lineColor = [1, 1, 1, 1];
        this.area = new Float32Array(0);
        this.areaFill = [0, 0, 0, 0];
        this.histogram = new Float32Array(0);
        this.histogramColors = null;
        this.histogramScaleY = 0;
        this.histogramOffsetY = 0;
        this.histogramPane = 0;
        this.panes = null;
        this.overlays = new Map();
        this.handleViewport = (payload) => {
            this.offsetX = payload.offsetX;
            this.offsetY = payload.offsetY;
            this.scaleX = payload.scaleX;
            this.scaleY = payload.scaleY;
            this.plot = payload.plot;
            this.panes = payload.panes ?? null;
        };
    }
    init(canvas, emitter) {
        const context = canvas.getContext('2d');
        if (!context)
            throw new Error('MatrixCharts: Canvas2D is unavailable.');
        this.canvas = canvas;
        this.ctx = context;
        this.emitter = emitter;
        emitter.on('viewport', this.handleViewport);
    }
    resize(width, height, dpr) {
        this.dpr = dpr;
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
    }
    render() {
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
    destroy() {
        if (this.emitter)
            this.emitter.off('viewport', this.handleViewport);
        this.overlays.clear();
        this.candles = new Float32Array(0);
        this.line = new Float32Array(0);
        this.area = new Float32Array(0);
        this.histogram = new Float32Array(0);
    }
    drawCandlesticks(candles, spec) {
        this.candles = new Float32Array(candles);
        this.candleSpec = spec;
    }
    clearCandlesticks() { this.candles = new Float32Array(0); }
    retainOverlays(activeIds) {
        for (const id of this.overlays.keys())
            if (!activeIds.has(id))
                this.overlays.delete(id);
    }
    drawOverlay(id, points, stride, color, vertical, pane = 0, type = 'line', baseline = 0, points2 = null, fillColor = null) {
        this.overlays.set(id, { points, stride, color, vertical, pane, type, baseline, points2, fillColor });
    }
    drawLine(points, color) { this.line = new Float32Array(points); this.lineColor = color; }
    clearLine() { this.line = new Float32Array(0); }
    drawArea(points, fill) { this.area = new Float32Array(points); this.areaFill = fill; }
    clearArea() { this.area = new Float32Array(0); }
    drawHistogram(levels, colors, scaleY, offsetY, pane = 0) {
        this.histogram = new Float32Array(levels);
        this.histogramColors = colors;
        this.histogramScaleY = scaleY;
        this.histogramOffsetY = offsetY;
        this.histogramPane = pane;
    }
    clearHistogram() { this.histogram = new Float32Array(0); }
    x(value) { return this.offsetX + value * this.scaleX; }
    y(value, vertical = null) {
        const transform = vertical ?? { scaleY: this.scaleY, offsetY: this.offsetY };
        return transform.offsetY + value * transform.scaleY;
    }
    css(color) {
        return `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${color[3]})`;
    }
    renderCandles() {
        if (!this.candleSpec)
            return;
        const spec = this.candleSpec;
        const ctx = this.ctx;
        for (let offset = 0; offset < this.candles.length; offset += candleLayout_js_1.CANDLE_STRIDE) {
            const x = this.x(this.candles[offset]);
            const open = this.y(this.candles[offset + candleLayout_js_1.CANDLE_OPEN]);
            const close = this.y(this.candles[offset + candleLayout_js_1.CANDLE_CLOSE]);
            const high = this.y(this.candles[offset + candleLayout_js_1.CANDLE_HIGH]);
            const low = this.y(this.candles[offset + candleLayout_js_1.CANDLE_LOW]);
            const up = this.candles[offset + candleLayout_js_1.CANDLE_CLOSE] >= this.candles[offset + candleLayout_js_1.CANDLE_OPEN];
            const color = up ? spec.colors.up : spec.colors.down;
            ctx.strokeStyle = this.css(color);
            ctx.fillStyle = this.css(color);
            if (spec.wickVisible) {
                ctx.beginPath();
                ctx.moveTo(x, high);
                ctx.lineTo(x, low);
                ctx.stroke();
            }
            if (spec.style === 'ohlc') {
                ctx.beginPath();
                ctx.moveTo(x - this.scaleX * 0.35, open);
                ctx.lineTo(x, open);
                ctx.moveTo(x, close);
                ctx.lineTo(x + this.scaleX * 0.35, close);
                ctx.stroke();
                continue;
            }
            if (spec.style === 'hollow') {
                ctx.strokeRect(x - this.scaleX * 0.35, Math.min(open, close), this.scaleX * 0.7, Math.max(Math.abs(close - open), 1));
            }
            else {
                ctx.fillRect(x - this.scaleX * 0.35, Math.min(open, close), this.scaleX * 0.7, Math.max(Math.abs(close - open), 1));
            }
        }
    }
    renderLine() { this.renderPolyline(this.line, this.lineColor, null); }
    renderArea() {
        if (this.area.length < 4)
            return;
        this.renderPolyline(this.area, this.areaFill, null);
        const firstX = this.x(this.area[0]);
        const last = this.area.length - 2;
        const lastX = this.x(this.area[last]);
        const baseline = this.y(0);
        this.ctx.fillStyle = this.css(this.areaFill);
        this.ctx.beginPath();
        this.ctx.moveTo(firstX, baseline);
        for (let offset = 0; offset < this.area.length; offset += 2)
            this.ctx.lineTo(this.x(this.area[offset]), this.y(this.area[offset + 1]));
        this.ctx.lineTo(lastX, baseline);
        this.ctx.closePath();
        this.ctx.fill();
    }
    renderPolyline(points, color, vertical) {
        if (points.length < 4)
            return;
        this.ctx.strokeStyle = this.css(color);
        this.ctx.beginPath();
        this.ctx.moveTo(this.x(points[0]), this.y(points[1], vertical));
        for (let offset = 2; offset < points.length; offset += 2)
            this.ctx.lineTo(this.x(points[offset]), this.y(points[offset + 1], vertical));
        this.ctx.stroke();
    }
    renderOverlays() {
        for (const entry of this.overlays.values()) {
            if (entry.points.length < entry.stride * 2)
                continue;
            const type = entry.type ?? 'line';
            if (type === 'histogram') {
                const baseCoord = this.y(entry.baseline, entry.vertical);
                for (let offset = 0; offset < entry.points.length; offset += entry.stride) {
                    const x = this.x(entry.points[offset]);
                    const yVal = this.y(entry.points[offset + 1], entry.vertical);
                    const color = entry.stride === 6
                        ? [entry.points[offset + 2], entry.points[offset + 3], entry.points[offset + 4], entry.points[offset + 5]]
                        : entry.color;
                    this.ctx.fillStyle = this.css(color);
                    const barWidth = Math.max(1, this.scaleX * 0.7);
                    const top = Math.min(baseCoord, yVal);
                    const height = Math.max(Math.abs(baseCoord - yVal), 1);
                    this.ctx.fillRect(x - barWidth / 2, top, barWidth, height);
                }
            }
            else if (type === 'area') {
                const baseCoord = this.y(entry.baseline, entry.vertical);
                const firstX = this.x(entry.points[0]);
                const last = entry.points.length - entry.stride;
                const lastX = this.x(entry.points[last]);
                this.ctx.fillStyle = this.css(entry.fillColor ?? [entry.color[0], entry.color[1], entry.color[2], entry.color[3] * 0.3]);
                this.ctx.beginPath();
                this.ctx.moveTo(firstX, baseCoord);
                for (let offset = 0; offset < entry.points.length; offset += entry.stride) {
                    this.ctx.lineTo(this.x(entry.points[offset]), this.y(entry.points[offset + 1], entry.vertical));
                }
                this.ctx.lineTo(lastX, baseCoord);
                this.ctx.closePath();
                this.ctx.fill();
                this.ctx.strokeStyle = this.css(entry.color);
                this.ctx.beginPath();
                this.ctx.moveTo(firstX, this.y(entry.points[1], entry.vertical));
                for (let offset = entry.stride; offset < entry.points.length; offset += entry.stride) {
                    this.ctx.lineTo(this.x(entry.points[offset]), this.y(entry.points[offset + 1], entry.vertical));
                }
                this.ctx.stroke();
            }
            else if (type === 'band' && entry.points2 && entry.points2.length >= 2) {
                this.ctx.fillStyle = this.css(entry.fillColor ?? [entry.color[0], entry.color[1], entry.color[2], entry.color[3] * 0.25]);
                this.ctx.beginPath();
                this.ctx.moveTo(this.x(entry.points[0]), this.y(entry.points[1], entry.vertical));
                for (let offset = entry.stride; offset < entry.points.length; offset += entry.stride) {
                    this.ctx.lineTo(this.x(entry.points[offset]), this.y(entry.points[offset + 1], entry.vertical));
                }
                const p2 = entry.points2;
                const p2Stride = p2.length % 6 === 0 && entry.stride === 6 ? 6 : 2;
                for (let offset = p2.length - p2Stride; offset >= 0; offset -= p2Stride) {
                    this.ctx.lineTo(this.x(p2[offset]), this.y(p2[offset + 1], entry.vertical));
                }
                this.ctx.closePath();
                this.ctx.fill();
                this.ctx.strokeStyle = this.css(entry.color);
                this.ctx.beginPath();
                this.ctx.moveTo(this.x(entry.points[0]), this.y(entry.points[1], entry.vertical));
                for (let offset = entry.stride; offset < entry.points.length; offset += entry.stride) {
                    this.ctx.lineTo(this.x(entry.points[offset]), this.y(entry.points[offset + 1], entry.vertical));
                }
                this.ctx.stroke();
            }
            else {
                this.ctx.strokeStyle = this.css(entry.color);
                this.ctx.beginPath();
                this.ctx.moveTo(this.x(entry.points[0]), this.y(entry.points[1], entry.vertical));
                for (let offset = entry.stride; offset < entry.points.length; offset += entry.stride) {
                    this.ctx.lineTo(this.x(entry.points[offset]), this.y(entry.points[offset + 1], entry.vertical));
                }
                this.ctx.stroke();
            }
        }
    }
    renderHistogram() {
        if (this.histogram.length === 0 || this.histogramColors === null)
            return;
        const targetRect = (this.histogramPane > 0 && this.panes && this.panes.rects[this.histogramPane])
            ? this.panes.rects[this.histogramPane]
            : this.plot;
        const baseline = targetRect.y + targetRect.height;
        for (let offset = 0; offset < this.histogram.length; offset += candleLayout_js_1.CANDLE_STRIDE) {
            const x = this.x(this.histogram[offset]);
            const y = this.histogramOffsetY + this.histogram[offset + candleLayout_js_1.CANDLE_VOLUME] * this.histogramScaleY;
            this.ctx.fillStyle = this.css(this.histogram[offset + candleLayout_js_1.CANDLE_CLOSE] >= this.histogram[offset + candleLayout_js_1.CANDLE_OPEN] ? this.histogramColors.up : this.histogramColors.down);
            this.ctx.fillRect(x - this.scaleX * 0.35, y, this.scaleX * 0.7, baseline - y);
        }
    }
}
exports.Canvas2DDataRenderer = Canvas2DDataRenderer;
