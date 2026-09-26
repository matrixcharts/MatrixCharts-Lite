// src/core/Chart.ts
import type { IRenderer } from './IRenderer';
import { WebGL2Renderer } from '../renderers/WebGL2Renderer';
import { Canvas2DRenderer } from '../renderers/Canvas2DRenderer';
import { LTTBDownsampler } from '../math/LTTBDownsampler';
import { EventEmitter, ChartEvents } from './EventEmitter';
import type { CandleData } from './CandleData';

export class Chart {
    private container: HTMLElement;
    private emitter: EventEmitter<ChartEvents> = new EventEmitter();
    private canvasWrapper: HTMLDivElement;
    private resizeObserver: ResizeObserver;
    
    // Store your active renderers
    private renderers: IRenderer[] = [];
    private isDragging: boolean = false;
    private lastPointerX: number = 0;
    private activePointers: Map<number, { x: number; y: number }> = new Map();
    private lastPinchDistance: number = 0;
    private lastPinchCenterX: number = 0;
    private offsetX: number = 0;
    private scaleX: number = 1;
    private offsetY: number = 0;
    private scaleY: number = 1;
    private candleLevels: Float32Array[] = [];
    private displayedCandles: Float32Array = new Float32Array(0);
    private candleTimes: Float64Array = new Float64Array(0);

    constructor(containerId: string) {
        const el = document.getElementById(containerId);
        if (!el) throw new Error(`MatrixCharts: Container '${containerId}' not found.`);
        this.container = el;

        this.canvasWrapper = document.createElement('div');
        this.canvasWrapper.style.position = 'relative';
        this.canvasWrapper.style.width = '100%';
        this.canvasWrapper.style.height = '100%';
        this.canvasWrapper.style.touchAction = 'none';
        this.container.appendChild(this.canvasWrapper);

        // Initialize layers
        const gridCanvas = this.createLayer(0);
        const dataCanvas = this.createLayer(1);
        const uiCanvas = this.createLayer(2);

        // Layer 0: Background Grid
        const gridRenderer = new Canvas2DRenderer(true);
        gridRenderer.init(gridCanvas, this.emitter);
        this.renderers.push(gridRenderer);

        // Layer 1: GPU Data
        const dataRenderer = new WebGL2Renderer(); 
        dataRenderer.init(dataCanvas, this.emitter);
        this.renderers.push(dataRenderer);

        // Layer 2: UI Overlay
        const uiRenderer = new Canvas2DRenderer(false);
        uiRenderer.init(uiCanvas, this.emitter);
        this.renderers.push(uiRenderer);

        // Bind the resize observer to the wrapper
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                this.handleResize(width, height);
            }
        });
        
        this.resizeObserver.observe(this.canvasWrapper);
        this.bindEvents();
    }

    private createLayer(zIndex: number): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.transformOrigin = 'top left';
        canvas.style.pointerEvents = zIndex === 2 ? 'auto' : 'none'; // Top layer catches mouse events
        canvas.style.zIndex = zIndex.toString();
        this.canvasWrapper.appendChild(canvas);
        return canvas;
    }

    private handleResize(width: number, height: number): void {
        if (width === 0 || height === 0) return;
        
        const dpr = window.devicePixelRatio || 1;
        
        // Broadcast the resize and new DPR to all rendering engines
        for (const renderer of this.renderers) {
            renderer.resize(width, height, dpr);
        }
        
        this.updateViewport();
    }

    private redraw(): void {
        for (const renderer of this.renderers) {
            renderer.clear();
            renderer.render();
        }
    }

    private bindEvents(): void {
        this.canvasWrapper.addEventListener('pointerdown', this.handlePointerDown);
        this.canvasWrapper.addEventListener('pointermove', this.handlePointerMove);
        this.canvasWrapper.addEventListener('pointerup', this.handlePointerEnd);
        this.canvasWrapper.addEventListener('pointercancel', this.handlePointerEnd);
        this.canvasWrapper.addEventListener('lostpointercapture', this.handlePointerEnd);
        this.canvasWrapper.addEventListener('wheel', this.handleWheel, { passive: false });
    }

    private handlePointerDown = (event: PointerEvent): void => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        this.canvasWrapper.setPointerCapture(event.pointerId);
        this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (this.activePointers.size === 1) {
            this.isDragging = true;
            this.lastPointerX = event.clientX;
        } else if (this.activePointers.size === 2) {
            this.isDragging = false;
            this.resetPinchBaseline();
        }
    };

    private handlePointerMove = (event: PointerEvent): void => {
        if (!this.activePointers.has(event.pointerId)) return;
        this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (this.activePointers.size >= 2) {
            this.handlePinchMove();
            return;
        }
        if (!this.isDragging) return;

        const deltaX: number = event.clientX - this.lastPointerX;
        this.lastPointerX = event.clientX;
        this.offsetX += deltaX;
        this.updateViewport();
    };

    private handlePointerEnd = (event: PointerEvent): void => {
        this.activePointers.delete(event.pointerId);

        if (this.activePointers.size === 1) {
            const remainingPointer: { x: number; y: number } | undefined = this.activePointers.values().next().value;
            this.isDragging = true;
            this.lastPointerX = remainingPointer?.x ?? 0;
            this.lastPinchDistance = 0;
        } else if (this.activePointers.size === 0) {
            this.isDragging = false;
            this.lastPinchDistance = 0;
        } else {
            this.resetPinchBaseline();
        }
    };

    private handleWheel = (event: WheelEvent): void => {
        event.preventDefault();

        const requestedFactor: number = event.deltaY > 0 ? 0.9 : 1.1;
        const rect: DOMRect = this.canvasWrapper.getBoundingClientRect();
        const mouseX: number = event.clientX - rect.left;
        this.zoomAt(requestedFactor, mouseX);
    };

    private zoomAt(requestedFactor: number, anchorX: number): void {
        const previousScale: number = this.scaleX;
        this.scaleX = Math.max(1e-4, Math.min(1e4, previousScale * requestedFactor));
        const appliedFactor: number = this.scaleX / previousScale;
        this.offsetX = anchorX - (anchorX - this.offsetX) * appliedFactor;
        this.updateViewport();
    }

    public setData(candles: readonly CandleData[]): void {
        const rawCandles: Float32Array = new Float32Array(candles.length * 6);
        const times: Float64Array = new Float64Array(candles.length);
        let previousTime: number = Number.NEGATIVE_INFINITY;

        for (let candleIndex: number = 0; candleIndex < candles.length; candleIndex++) {
            const candle: CandleData = candles[candleIndex];
            if (
                ![candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) ||
                candle.time <= previousTime ||
                candle.high < Math.max(candle.open, candle.close) ||
                candle.low > Math.min(candle.open, candle.close) ||
                candle.high < candle.low
            ) {
                throw new Error(`MatrixCharts: Invalid or out-of-order OHLC candle at index ${candleIndex}.`);
            }

            const outputIndex: number = candleIndex * 6;
            rawCandles[outputIndex] = candleIndex;
            rawCandles[outputIndex + 1] = candle.open;
            rawCandles[outputIndex + 2] = candle.high;
            rawCandles[outputIndex + 3] = candle.low;
            rawCandles[outputIndex + 4] = candle.close;
            rawCandles[outputIndex + 5] = 0.7;
            times[candleIndex] = candle.time;
            previousTime = candle.time;
        }

        this.candleLevels = candles.length > 0
            ? LTTBDownsampler.buildOHLCPyramid(rawCandles)
            : [];
        this.candleTimes = times;

        if (candles.length === 0) {
            this.offsetX = 0;
            this.scaleX = 1;
        } else {
            const cssWidth: number = this.canvasWrapper.clientWidth || 800;
            this.scaleX = Math.max(1e-4, Math.min(1e4, cssWidth / candles.length));
            this.offsetX = (cssWidth - (candles.length - 1) * this.scaleX) / 2;
        }
        this.updateViewport();
    }

    private resetPinchBaseline(): void {
        const pointers: { x: number; y: number }[] = Array.from(this.activePointers.values()).slice(0, 2);
        if (pointers.length < 2) return;
        this.lastPinchDistance = Math.hypot(pointers[1].x - pointers[0].x, pointers[1].y - pointers[0].y);
        this.lastPinchCenterX = (pointers[0].x + pointers[1].x) / 2;
    }

    private handlePinchMove(): void {
        const pointers: { x: number; y: number }[] = Array.from(this.activePointers.values()).slice(0, 2);
        if (pointers.length < 2) return;

        const distance: number = Math.hypot(pointers[1].x - pointers[0].x, pointers[1].y - pointers[0].y);
        const centerX: number = (pointers[0].x + pointers[1].x) / 2;
        const rect: DOMRect = this.canvasWrapper.getBoundingClientRect();
        if (this.lastPinchDistance <= 1) {
            this.lastPinchDistance = distance;
            this.lastPinchCenterX = centerX;
            return;
        }

        if (distance > 1) {
            this.zoomAt(distance / this.lastPinchDistance, centerX - rect.left);
        } else {
            this.offsetX += centerX - this.lastPinchCenterX;
            this.updateViewport();
        }
        this.lastPinchDistance = distance;
        this.lastPinchCenterX = centerX;
    }

    private autoScaleY(): void {
        if (this.displayedCandles.length === 0) return;

        const cssHeight = this.canvasWrapper.clientHeight || 500;

        let maxHigh = Number.NEGATIVE_INFINITY;
        let minLow = Number.POSITIVE_INFINITY;
        const count: number = this.displayedCandles.length / 6;
        for (let i: number = 0; i < count; i++) {
            maxHigh = Math.max(maxHigh, this.displayedCandles[i * 6 + 2]);
            minLow = Math.min(minLow, this.displayedCandles[i * 6 + 3]);
        }

        // Add 10% padding to top and bottom
        const priceRange = maxHigh - minLow;
        const padding = priceRange === 0
            ? Math.max(Math.abs(maxHigh) * 0.1, 1)
            : priceRange * 0.1;
        
        const paddedMin = minLow - padding;
        const paddedMax = maxHigh + padding;

        this.scaleY = -cssHeight / (paddedMax - paddedMin);
        this.offsetY = cssHeight - paddedMin * this.scaleY;
    }

    private updateViewport(): void {
        this.updateVisibleCandles();
        this.autoScaleY();
        // Broadcast the spatial update to all subscribed renderers without coupling
        this.emitter.emit('viewport', { 
            offsetX: this.offsetX, 
            offsetY: this.offsetY, 
            scaleX: this.scaleX, 
            scaleY: this.scaleY 
        });
        this.redraw();
    }

    private updateVisibleCandles(): void {
        if (this.candleLevels.length === 0) {
            this.displayedCandles = new Float32Array(0);
        } else {
            let levelIndex: number = 0;
            while (
                levelIndex + 1 < this.candleLevels.length &&
                this.scaleX * Math.pow(2, levelIndex + 1) <= 2
            ) {
                levelIndex++;
            }

            const aggregationFactor: number = Math.pow(2, levelIndex);
            const level: Float32Array = this.candleLevels[levelIndex];
            const levelCount: number = level.length / 6;
            const visibleMinX: number = -this.offsetX / this.scaleX;
            const visibleMaxX: number = (this.canvasWrapper.clientWidth - this.offsetX) / this.scaleX;
            const startBucket: number = Math.max(0, Math.floor(visibleMinX / aggregationFactor) - 1);
            const endBucket: number = Math.min(
                levelCount,
                Math.ceil(visibleMaxX / aggregationFactor) + 2,
            );
            this.displayedCandles = endBucket > startBucket
                ? level.slice(startBucket * 6, endBucket * 6)
                : new Float32Array(0);
        }

        const dataRenderer: WebGL2Renderer = this.renderers[1] as WebGL2Renderer;
        dataRenderer.drawCandlesticks(
            this.displayedCandles,
            [0.1, 0.85, 0.55, 0.9],
            [0.95, 0.25, 0.35, 0.9],
        );
        this.emitter.emit('data', { ohlc: this.displayedCandles, times: this.candleTimes });
    }

    public destroy(): void {
        this.canvasWrapper.removeEventListener('pointerdown', this.handlePointerDown);
        this.canvasWrapper.removeEventListener('pointermove', this.handlePointerMove);
        this.canvasWrapper.removeEventListener('pointerup', this.handlePointerEnd);
        this.canvasWrapper.removeEventListener('pointercancel', this.handlePointerEnd);
        this.canvasWrapper.removeEventListener('lostpointercapture', this.handlePointerEnd);
        this.canvasWrapper.removeEventListener('wheel', this.handleWheel);
        this.resizeObserver.disconnect();
        for (const renderer of this.renderers) {
            renderer.destroy();
        }
        this.container.innerHTML = ''; // Clean up DOM
    }

    public testDrawWebGLData(): void {
        const dataRenderer = this.renderers[1] as WebGL2Renderer;
        
        const points = new Float32Array(20000); 
        for (let i = 0; i < 10000; i++) {
            const x = (i / 10000) * 800;
            const y = 250 + Math.sin(i * 0.05) * 100;
            points[i * 2] = x;
            points[i * 2 + 1] = y;
        }
        
        dataRenderer.drawLine(points, [0.0, 1.0, 1.0, 1.0]);
        this.redraw();
    }

    public testDrawWebGLCandlesticks(): void {
        const candleCount: number = 70;
        const candles: CandleData[] = new Array<CandleData>(candleCount);
        let randomState: number = 0x6d2b79f5;
        let previousClose: number = 250;
        const nextRandom = (): number => {
            randomState = (randomState * 1664525 + 1013904223) >>> 0;
            return randomState / 4294967296;
        };

        for (let candleIndex: number = 0; candleIndex < candleCount; candleIndex++) {
            const gap: number = (nextRandom() - 0.5) * 10;
            const open: number = Math.max(60, Math.min(440, previousClose + gap));
            const directionalMove: number = (nextRandom() - 0.48) * 22;
            const close: number = Math.max(60, Math.min(440, open + directionalMove));
            const upperWick: number = 5 + nextRandom() * 14;
            const lowerWick: number = 5 + nextRandom() * 14;
            const high: number = Math.min(470, Math.max(open, close) + upperWick);
            const low: number = Math.max(30, Math.min(open, close) - lowerWick);
            candles[candleIndex] = {
                time: Date.UTC(2025, 0, 1) + candleIndex * 60_000,
                open,
                high,
                low,
                close,
            };
            previousClose = close;
        }
        this.setData(candles);
    }
}