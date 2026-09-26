// src/core/Chart.ts
import type { IRenderer } from './IRenderer';
import { WebGL2Renderer } from '../renderers/WebGL2Renderer';
import { Canvas2DRenderer } from '../renderers/Canvas2DRenderer';
import { OHLCPyramid } from '../math/OHLCPyramid';
import { EventEmitter, ChartEvents } from './EventEmitter';
import type { CandleData } from './CandleData';
import type { ChartOptions } from './ChartOptions';

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
    private candlePyramid: OHLCPyramid = new OHLCPyramid();
    private displayedCandles: Float32Array = new Float32Array(0);
    private candleTimes: number[] = [];
    private followsLiveEdge: boolean = true;
    private scheduledViewportFrame: number | null = null;
    private readonly maxRetainedCandles: number;
    private pendingAppends: CandleData[] = [];
    private pendingLastUpdate: CandleData | null = null;
    private pendingReplace: boolean = false;

    constructor(containerId: string, options: ChartOptions = {}) {
        const maxRetainedCandles: number = options.maxRetainedCandles ?? 1_000_000;
        if (!Number.isSafeInteger(maxRetainedCandles) || maxRetainedCandles < 1) {
            throw new Error('MatrixCharts: maxRetainedCandles must be a positive safe integer.');
        }
        this.maxRetainedCandles = maxRetainedCandles;

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
        this.handleResize(this.canvasWrapper.clientWidth, this.canvasWrapper.clientHeight);
        this.bindEvents();
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
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
        
        this.cancelScheduledViewportUpdate();
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
        this.followsLiveEdge = this.isAtLiveEdge();
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
        this.followsLiveEdge = this.isAtLiveEdge();
        this.updateViewport();
    }

    public setData(candles: readonly CandleData[]): void {
        this.loadData(candles, false);
    }

    /** Replaces authoritative feed history while retaining the current time anchor when available. */
    public replaceData(candles: readonly CandleData[]): void {
        this.loadData(candles, true);
    }

    private loadData(candles: readonly CandleData[], preserveViewport: boolean): void {
        const previousCount: number = this.candlePyramid.candleCount;
        const previousFollowing: boolean = this.followsLiveEdge;
        const previousScale: number = this.scaleX;
        const anchorScreenX: number = (this.canvasWrapper.clientWidth || 800) / 2;
        const previousAnchorIndex: number = previousCount > 0
            ? Math.max(0, Math.min(previousCount - 1, Math.round((anchorScreenX - this.offsetX) / this.scaleX)))
            : 0;
        const anchorTime: number | null = previousCount > 0
            ? this.candleTimes[previousAnchorIndex]
            : null;

        this.cancelScheduledViewportUpdate();
        this.pendingAppends = [];
        this.pendingLastUpdate = null;
        this.pendingReplace = false;
        const retainedStart: number = Math.max(0, candles.length - this.maxRetainedCandles);
        const retainedLength: number = candles.length - retainedStart;
        const rawCandles: Float32Array = new Float32Array(retainedLength * 6);
        const times: number[] = new Array<number>(retainedLength);
        let previousTime: number = Number.NEGATIVE_INFINITY;

        for (let candleIndex: number = 0; candleIndex < candles.length; candleIndex++) {
            const candle: CandleData = candles[candleIndex];
            this.validateCandle(candle, previousTime, candleIndex);
            previousTime = candle.time;

            if (candleIndex < retainedStart) continue;

            const outputIndex: number = (candleIndex - retainedStart) * 6;
            rawCandles[outputIndex] = candleIndex - retainedStart;
            rawCandles[outputIndex + 1] = candle.open;
            rawCandles[outputIndex + 2] = candle.high;
            rawCandles[outputIndex + 3] = candle.low;
            rawCandles[outputIndex + 4] = candle.close;
            rawCandles[outputIndex + 5] = 0.7;
            times[candleIndex - retainedStart] = candle.time;
        }

        this.candlePyramid.reset(rawCandles);
        this.candleTimes = times;
        this.followsLiveEdge = true;

        if (preserveViewport && retainedLength > 0 && previousCount > 0) {
            this.scaleX = previousScale;
            if (previousFollowing) {
                const cssWidth: number = this.canvasWrapper.clientWidth || 800;
                this.offsetX = cssWidth - (retainedLength - 0.5) * this.scaleX;
                this.followsLiveEdge = true;
            } else if (anchorTime !== null) {
                const retainedIndex: number = this.findNearestDataIndex(candles, retainedStart, anchorTime);
                this.offsetX = anchorScreenX - retainedIndex * this.scaleX;
                this.followsLiveEdge = false;
            }
        } else if (retainedLength === 0) {
            this.offsetX = 0;
            this.scaleX = 1;
        } else {
            const cssWidth: number = this.canvasWrapper.clientWidth || 800;
            this.scaleX = Math.max(1e-4, Math.min(12, cssWidth / retainedLength));
            this.offsetX = cssWidth - (retainedLength - 0.5) * this.scaleX;
        }
        this.updateViewport();
    }

    private findNearestDataIndex(candles: readonly CandleData[], retainedStart: number, time: number): number {
        let low: number = retainedStart;
        let high: number = candles.length - 1;
        while (low < high) {
            const middle: number = Math.floor((low + high) / 2);
            if (candles[middle].time < time) low = middle + 1;
            else high = middle;
        }

        const upperIndex: number = low;
        const lowerIndex: number = Math.max(retainedStart, upperIndex - 1);
        const nearestIndex: number = Math.abs(candles[upperIndex].time - time) < Math.abs(candles[lowerIndex].time - time)
            ? upperIndex
            : lowerIndex;
        return nearestIndex - retainedStart;
    }

    public appendData(candle: CandleData): void {
        this.appendBatch([candle]);
    }

    /** Appends a chronological batch after validating every candle before mutation. */
    public appendBatch(candles: readonly CandleData[]): void {
        if (candles.length === 0) return;

        const currentCount: number = this.candlePyramid.candleCount;
        const pendingCount: number = this.pendingAppends.length;
        if (currentCount === 0 && pendingCount === 0) {
            this.setData(candles);
            return;
        }

        let previousTime: number = pendingCount > 0
            ? this.pendingAppends[pendingCount - 1].time
            : this.candleTimes[currentCount - 1];
        for (let index: number = 0; index < candles.length; index++) {
            const candle: CandleData = candles[index];
            this.validateCandle(candle, previousTime, currentCount + index);
            previousTime = candle.time;
        }

        for (let index: number = 0; index < candles.length; index++) {
            this.pendingAppends.push(candles[index]);
        }

        if (this.pendingAppends.length > this.maxRetainedCandles) {
            this.pendingAppends.splice(0, this.pendingAppends.length - this.maxRetainedCandles);
            this.pendingReplace = true;
            this.pendingLastUpdate = null;
        }
        this.scheduleViewportUpdate();
    }

    /** Replaces the current last candle; its timestamp must match exactly. */
    public updateLast(candle: CandleData): void {
        const currentCount: number = this.candlePyramid.candleCount;
        const pendingCount: number = this.pendingAppends.length;
        if (currentCount === 0 && pendingCount === 0) {
            throw new Error('MatrixCharts: Cannot update the last candle before data is set.');
        }
        const queuedLast: CandleData | undefined = pendingCount > 0
            ? this.pendingAppends[pendingCount - 1]
            : undefined;
        const lastTime: number = queuedLast?.time ?? this.candleTimes[currentCount - 1];
        if (candle.time !== lastTime) {
            throw new Error('MatrixCharts: updateLast() must use the timestamp of the current last candle.');
        }
        const previousTime: number = pendingCount > 1
            ? this.pendingAppends[pendingCount - 2].time
            : currentCount > 1
                ? this.candleTimes[currentCount - 2]
                : Number.NEGATIVE_INFINITY;
        this.validateCandle(candle, previousTime, currentCount + pendingCount - 1);

        if (pendingCount > 0) {
            this.pendingAppends[pendingCount - 1] = candle;
        } else {
            this.pendingLastUpdate = candle;
        }
        this.scheduleViewportUpdate();
    }

    private validateCandle(candle: CandleData, previousTime: number, index: number): void {
        const values: number[] = [candle.time, candle.open, candle.high, candle.low, candle.close];
        const floatValues: number[] = [candle.open, candle.high, candle.low, candle.close];
        if (
            !values.every(Number.isFinite) ||
            !floatValues.every((value: number): boolean => Number.isFinite(Math.fround(value))) ||
            Math.abs(candle.time) > 8.64e15 ||
            candle.time <= previousTime ||
            candle.high < Math.max(candle.open, candle.close) ||
            candle.low > Math.min(candle.open, candle.close) ||
            candle.high < candle.low
        ) {
            throw new Error(`MatrixCharts: Invalid or out-of-order OHLC candle at index ${index}.`);
        }
    }

    private isAtLiveEdge(): boolean {
        const candleCount: number = this.candlePyramid.candleCount;
        if (candleCount === 0) return true;
        const cssWidth: number = this.canvasWrapper.clientWidth || 800;
        const lastCandleScreenX: number = this.offsetX + (candleCount - 1) * this.scaleX;
        const edgeTolerance: number = Math.max(24, this.scaleX * 1.5);
        return lastCandleScreenX >= cssWidth - edgeTolerance && lastCandleScreenX <= cssWidth + edgeTolerance;
    }

    private scheduleViewportUpdate(): void {
        if (document.visibilityState === 'hidden') return;
        if (this.scheduledViewportFrame !== null) return;
        this.scheduledViewportFrame = requestAnimationFrame(() => {
            this.scheduledViewportFrame = null;
            this.updateViewport();
        });
    }

    private handleVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') {
            this.cancelScheduledViewportUpdate();
        } else if (
            this.pendingAppends.length > 0 ||
            this.pendingLastUpdate !== null ||
            this.pendingReplace
        ) {
            this.scheduleViewportUpdate();
        }
    };

    private cancelScheduledViewportUpdate(): void {
        if (this.scheduledViewportFrame === null) return;
        cancelAnimationFrame(this.scheduledViewportFrame);
        this.scheduledViewportFrame = null;
    }

    private flushPendingData(): void {
        if (this.pendingReplace) {
            const replacement: CandleData[] = this.pendingAppends;
            this.pendingAppends = [];
            this.pendingLastUpdate = null;
            this.pendingReplace = false;

            const rawCandles: Float32Array = new Float32Array(replacement.length * 6);
            const times: number[] = new Array<number>(replacement.length);
            for (let index: number = 0; index < replacement.length; index++) {
                const candle: CandleData = replacement[index];
                const outputIndex: number = index * 6;
                rawCandles[outputIndex] = index;
                rawCandles[outputIndex + 1] = candle.open;
                rawCandles[outputIndex + 2] = candle.high;
                rawCandles[outputIndex + 3] = candle.low;
                rawCandles[outputIndex + 4] = candle.close;
                rawCandles[outputIndex + 5] = 0.7;
                times[index] = candle.time;
            }
            this.candlePyramid.reset(rawCandles);
            this.candleTimes = times;
            if (this.followsLiveEdge) {
                const cssWidth: number = this.canvasWrapper.clientWidth || 800;
                this.offsetX = cssWidth - (replacement.length - 0.5) * this.scaleX;
            } else {
                this.offsetX = 0;
            }
            return;
        }

        const appends: CandleData[] = this.pendingAppends;
        const lastUpdate: CandleData | null = this.pendingLastUpdate;
        this.pendingAppends = [];
        this.pendingLastUpdate = null;

        if (appends.length === 0 && lastUpdate === null) return;

        const shouldFollow: boolean = this.followsLiveEdge;
        if (lastUpdate !== null) {
            const lastIndex: number = this.candlePyramid.candleCount - 1;
            this.candlePyramid.updateLast(
                lastIndex,
                lastUpdate.open,
                lastUpdate.high,
                lastUpdate.low,
                lastUpdate.close,
                0.7,
            );
        }

        const firstNewIndex: number = this.candlePyramid.candleCount;
        for (let index: number = 0; index < appends.length; index++) {
            const candle: CandleData = appends[index];
            this.candlePyramid.append(
                firstNewIndex + index,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                0.7,
            );
            this.candleTimes.push(candle.time);
        }

        const overflow: number = Math.max(0, this.candlePyramid.candleCount - this.maxRetainedCandles);
        if (overflow > 0) {
            this.candlePyramid.trimStart(overflow);
            this.candleTimes.splice(0, overflow);
            if (!shouldFollow) {
                this.offsetX = Math.min(this.offsetX + this.scaleX * overflow, 0);
            }
        }
        if (shouldFollow && appends.length > 0) {
            if (overflow > 0) {
                const cssWidth: number = this.canvasWrapper.clientWidth || 800;
                this.offsetX = cssWidth - (this.candlePyramid.candleCount - 0.5) * this.scaleX;
            } else {
                this.offsetX -= this.scaleX * appends.length;
            }
        }
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
        this.cancelScheduledViewportUpdate();
        this.flushPendingData();
        this.updateVisibleCandles();
        this.autoScaleY();
        // Broadcast the spatial update to all subscribed renderers without coupling
        this.emitter.emit('viewport', { 
            offsetX: this.offsetX, 
            offsetY: this.offsetY, 
            scaleX: this.scaleX, 
            scaleY: this.scaleY 
        });
        this.uploadVisibleCandles();
        this.redraw();
    }

    private updateVisibleCandles(): void {
        if (this.candlePyramid.candleCount === 0) {
            this.displayedCandles = new Float32Array(0);
        } else {
            let levelIndex: number = 0;
            while (
                levelIndex + 1 < this.candlePyramid.levelCount &&
                this.scaleX * Math.pow(2, levelIndex + 1) <= 3
            ) {
                levelIndex++;
            }

            const aggregationFactor: number = Math.pow(2, levelIndex);
            const level: Float32Array = this.candlePyramid.getLevelData(levelIndex);
            const levelCount: number = this.candlePyramid.getLevelCount(levelIndex);
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

    }

    private uploadVisibleCandles(): void {
        const dataRenderer: WebGL2Renderer = this.renderers[1] as WebGL2Renderer;
        dataRenderer.drawCandlesticks(
            this.displayedCandles,
            [0.1, 0.85, 0.55, 0.9],
            [0.95, 0.25, 0.35, 0.9],
        );
        this.emitter.emit('data', { ohlc: this.displayedCandles, times: this.candleTimes });
    }

    public destroy(): void {
        this.cancelScheduledViewportUpdate();
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
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