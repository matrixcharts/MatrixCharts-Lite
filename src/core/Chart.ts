// src/core/Chart.ts
import type { IRenderer } from './IRenderer.js';
import { WebGL2Renderer } from '../renderers/WebGL2Renderer.js';
import { Canvas2DRenderer } from '../renderers/Canvas2DRenderer.js';
import { OHLCPyramid } from '../math/OHLCPyramid.js';
import { DEFAULT_CANDLE_SPACING_PX } from '../math/candlestickBodyWidth.js';
import {
    CANDLE_CLOSE,
    CANDLE_HIGH,
    CANDLE_LOW,
    CANDLE_OPEN,
    CANDLE_STRIDE,
    CANDLE_VOLUME,
    CANDLE_WIDTH,
    CANDLE_X,
} from '../math/candleLayout.js';
import { EventEmitter, ChartEvents } from './EventEmitter.js';
import type { CandleData } from './CandleData.js';
import type {
    CandleStyle,
    ChartOptions,
    ChartTheme,
    ResolvedCandleColors,
    ResolvedChartOptions,
} from './options.js';
import { mergeOptionPartials, resolveCandleColors, resolveOptions } from './options.js';
import { resolveChartContainer } from './resolveChartContainer.js';
import type {
    ChartClickEvent,
    CrosshairMoveEvent,
    Unsubscribe,
    VisibleRangeEvent,
} from './ChartEvents.js';
import {
    type ChartViewport,
    type LogicalRange,
    type PlotRect,
    type TimeRange,
    type VisibleRangeSnapshot,
    coordinateToIndex,
    coordinateToPrice,
    indexToCoordinate,
    isAtLiveEdgeOffset,
    isSameVisibleRange,
    liveEdgeOffsetX,
    nearestCandleIndex,
    nearestCandleIndexByTime,
    plotCentreX,
    plotRight,
    priceToCoordinate,
    visibleLogicalRange,
} from './coordinates.js';

/** Container size assumed before the first layout pass. */
const FALLBACK_CSS_WIDTH = 800;
const FALLBACK_CSS_HEIGHT = 500;

/** Pointer travel, in CSS pixels, that turns a press into a pan rather than a click. */
const CLICK_SLOP_PX = 4;

/**
 * Relative body width written into every source candle. The renderer treats it as
 * a weight that aggregation sums, never as pixels; actual body width comes from
 * `candlestickBodyWidthDevicePixels`, which reads the bar spacing instead.
 */
const DEFAULT_BODY_WIDTH_WEIGHT = 0.7;

/**
 * Volume for a candle, with an absent value read as 0. `validateCandle` has
 * already rejected a present-but-invalid volume, so the only question here is
 * whether there was one at all. Absent and genuine zero are deliberately
 * indistinguishable downstream: both mean nothing to draw.
 */
function candleVolume(candle: CandleData): number {
    return candle.volume ?? 0;
}

export class Chart {
    private container: HTMLElement;
    private emitter: EventEmitter<ChartEvents> = new EventEmitter();
    private canvasWrapper: HTMLDivElement;
    private resizeObserver: ResizeObserver;
    
    // Store your active renderers
    private renderers: IRenderer[] = [];
    /** Held directly rather than by position, since init order is not paint order. */
    private dataRenderer!: WebGL2Renderer;
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

    /**
     * Caller-supplied partials, accumulated across every applyOptions. Kept so a
     * theme change can re-seed from the new preset and still re-apply these.
     */
    private explicitOptions: ChartOptions;
    private resolvedOptions: ResolvedChartOptions;
    /** CSS colours parsed to vec4 once per apply, never per candle. */
    private candleColors: ResolvedCandleColors;

    // Crosshair state is owned by Chart, not by the UI layer, so the drawn
    // crosshair and the public crosshairMove event always agree.
    private crosshairX: number | null = null;
    private crosshairY: number | null = null;
    private crosshairIndex: number = -1;
    private crosshairCandle: CandleData | null = null;

    private crosshairHandlers: Set<(event: CrosshairMoveEvent) => void> = new Set();
    private clickHandlers: Set<(event: ChartClickEvent) => void> = new Set();
    private visibleRangeHandlers: Set<(event: VisibleRangeEvent) => void> = new Set();

    // Distinguishes a click from the end of a pan or pinch.
    private pressX: number = 0;
    private pressY: number = 0;
    private pressButton: number = 0;
    private pressMoved: boolean = false;
    /** Last raw pointer position in client coordinates, for viewport changes. */
    private pointerClientX: number = 0;
    private pointerClientY: number = 0;

    private lastReportedRange: VisibleRangeSnapshot | null = null;
    private scheduledRangeFrame: number | null = null;
    /**
     * A destroyed chart is unusable. Every public method throws a single stable
     * error rather than some throwing internal messages and others quietly
     * serving stale state, which is far harder to diagnose at an integration
     * boundary.
     */
    private destroyed: boolean = false;
    /** Guards against a handler re-entering its own event and looping forever. */
    private emittingCrosshair: boolean = false;
    private emittingVisibleRange: boolean = false;

    /**
     * Mounts a chart into an existing element, or into `document.getElementById(container)`.
     * WebGL2 is required.
     *
     * Constructor options are the initial `applyOptions`. `maxRetainedCandles` is
     * accepted here only; every other field may be changed later.
     */
    constructor(container: HTMLElement | string, options: ChartOptions = {}) {
        // Resolved up front so a bad colour or precision throws before any DOM
        // or GPU resource is created.
        const initial: ResolvedChartOptions = resolveOptions(options);
        this.explicitOptions = mergeOptionPartials({}, options, 'constructor');
        this.resolvedOptions = initial;
        this.candleColors = resolveCandleColors(initial);
        this.maxRetainedCandles = initial.maxRetainedCandles;

        this.container = resolveChartContainer(container);

        // Layers are built and initialised while still detached from the document,
        // and the wrapper is only attached once every renderer is live. A browser
        // without WebGL2 therefore fails fast and leaves the caller's container
        // exactly as it was, instead of a half-mounted shell of empty canvases.
        this.canvasWrapper = document.createElement('div');
        this.canvasWrapper.style.position = 'relative';
        this.canvasWrapper.style.width = '100%';
        this.canvasWrapper.style.height = '100%';
        this.canvasWrapper.style.touchAction = 'none';
        this.canvasWrapper.style.backgroundColor = initial.layout.background;

        // Initialize layers
        const gridCanvas = this.createLayer(0);
        const dataCanvas = this.createLayer(1);
        const uiCanvas = this.createLayer(2);

        try {
            // Layer 1: GPU Data. Initialised first because WebGL2 is the hard
            // requirement, so the unsupported case costs one context attempt and
            // no Canvas2D work. Paint order still comes from the z-index.
            const dataRenderer = new WebGL2Renderer();
            dataRenderer.init(dataCanvas, this.emitter);
            this.dataRenderer = dataRenderer;
            this.renderers.push(dataRenderer);

            // Layer 0: Background Grid
            const gridRenderer = new Canvas2DRenderer(true);
            gridRenderer.init(gridCanvas, this.emitter);
            this.renderers.push(gridRenderer);

            // Layer 2: UI Overlay
            const uiRenderer = new Canvas2DRenderer(false);
            uiRenderer.init(uiCanvas, this.emitter);
            this.renderers.push(uiRenderer);
        } catch (error) {
            // Release whatever did come up before rethrowing. The wrapper was never
            // attached, so there is nothing in the caller's DOM to clean up.
            for (const renderer of this.renderers) {
                renderer.destroy();
            }
            this.renderers.length = 0;
            throw error;
        }

        this.container.appendChild(this.canvasWrapper);
        this.emitter.emit('options', initial);

        // Bind the resize observer to the wrapper
        this.resizeObserver = new ResizeObserver(() => {
            // The wrapper's own client size is the single source of truth, so the
            // entry payload is deliberately not used here.
            this.handleResize();
        });

        this.resizeObserver.observe(this.canvasWrapper);
        this.handleResize();
        this.bindEvents();
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    private createLayer(zIndex: number): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.transformOrigin = 'top left';
        // Every layer is transparent to the pointer. The wrapper is the single
        // input surface, so hit-testing lives in one place instead of being
        // duplicated per canvas.
        canvas.style.pointerEvents = 'none';
        canvas.style.zIndex = zIndex.toString();
        this.canvasWrapper.appendChild(canvas);
        return canvas;
    }

    private handleResize(): void {
        this.syncRendererSize();
        this.cancelScheduledViewportUpdate();
        this.updateViewport();
    }

    private lastSizedWidth: number = 0;
    private lastSizedHeight: number = 0;
    private lastSizedRatio: number = 0;

    /**
     * Sizes the renderer canvases to the wrapper when that has changed.
     *
     * This runs at the top of every viewport update as well as from the
     * ResizeObserver, so the backing store self-corrects on the next time the
     * chart renders even where ResizeObserver is late, throttled, or entirely
     * unavailable, such as a background tab or an embedded webview. The observer
     * stays the fast path; this is the safety net. Costs two number comparisons
     * per render.
     */
    private syncRendererSize(): void {
        const width: number = this.canvasWrapper.clientWidth;
        const height: number = this.canvasWrapper.clientHeight;
        if (width === 0 || height === 0) return;
        const ratio: number = window.devicePixelRatio || 1;
        if (
            width === this.lastSizedWidth &&
            height === this.lastSizedHeight &&
            ratio === this.lastSizedRatio
        ) {
            return;
        }
        this.lastSizedWidth = width;
        this.lastSizedHeight = height;
        this.lastSizedRatio = ratio;
        for (const renderer of this.renderers) {
            renderer.resize(width, height, ratio);
        }
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
        this.canvasWrapper.addEventListener('pointerleave', this.handlePointerLeave);
        this.canvasWrapper.addEventListener('wheel', this.handleWheel, { passive: false });
    }

    private handlePointerDown = (event: PointerEvent): void => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        // Record the press before capturing. Capture is best effort, so a stale
        // pointer id must not stop the chart from tracking press and pan.
        this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        this.pressX = event.clientX;
        this.pressY = event.clientY;
        this.pressButton = event.button;
        this.pressMoved = false;
        this.capturePointer(event.pointerId);

        if (this.activePointers.size === 1) {
            this.isDragging = true;
            this.lastPointerX = event.clientX;
        } else if (this.activePointers.size === 2) {
            this.isDragging = false;
            this.pressMoved = true;
            this.resetPinchBaseline();
        }
    };

    /**
     * Pointer capture keeps a drag alive when the pointer leaves the chart. It
     * throws for a pointer the browser no longer considers active, and that must
     * degrade to "no capture" rather than break the gesture, because the events
     * still reach the wrapper by bubbling.
     */
    private capturePointer(pointerId: number): void {
        try {
            this.canvasWrapper.setPointerCapture(pointerId);
        } catch {
            // Intentionally ignored; bubbling still delivers pointerup here.
        }
    }

    private handlePointerMove = (event: PointerEvent): void => {
        this.pointerClientX = event.clientX;
        this.pointerClientY = event.clientY;
        // Hover tracking is independent of the buttons: the crosshair has to
        // follow the pointer before any press, which is the common case.
        if (!this.isInteracting()) {
            this.updateCrosshair(event.clientX, event.clientY);
        }

        if (!this.activePointers.has(event.pointerId)) return;
        this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (
            Math.abs(event.clientX - this.pressX) > CLICK_SLOP_PX ||
            Math.abs(event.clientY - this.pressY) > CLICK_SLOP_PX
        ) {
            this.pressMoved = true;
        }

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
        const wasSinglePointer: boolean = this.activePointers.size === 1;
        this.activePointers.delete(event.pointerId);

        if (this.activePointers.size === 1) {
            const remainingPointer: { x: number; y: number } | undefined = this.activePointers.values().next().value;
            this.isDragging = true;
            this.lastPointerX = remainingPointer?.x ?? 0;
            this.lastPinchDistance = 0;
            this.pressMoved = true;
        } else if (this.activePointers.size === 0) {
            this.isDragging = false;
            this.lastPinchDistance = 0;
            // A press that never travelled is a click; one that travelled was a pan.
            if (wasSinglePointer && !this.pressMoved) {
                this.emitClick(event.clientX, event.clientY, this.pressButton);
            }
            this.pressMoved = false;
        } else {
            this.resetPinchBaseline();
        }

        // Touch and pen have no hover state, so the crosshair must not linger
        // after the contact lifts.
        if (event.pointerType === 'mouse') {
            this.updateCrosshair(event.clientX, event.clientY);
        } else {
            this.clearCrosshair();
        }
    };

    private handlePointerLeave = (): void => {
        if (this.isInteracting()) return;
        this.clearCrosshair();
    };

    /** A drag or pinch is under way, so pointer movement is not hover. */
    private isInteracting(): boolean {
        return this.isDragging || this.activePointers.size >= 2;
    }

    private handleWheel = (event: WheelEvent): void => {
        event.preventDefault();

        const requestedFactor: number = event.deltaY > 0 ? 0.9 : 1.1;
        const rect: DOMRect = this.canvasWrapper.getBoundingClientRect();
        const mouseX: number = event.clientX - rect.left;
        this.zoomAt(requestedFactor, mouseX);
    };

    private zoomAt(requestedFactor: number, anchorX: number): void {
        const previousScale: number = this.scaleX;
        const nextScale: number = this.clampBarSpacing(previousScale * requestedFactor);
        if (nextScale === previousScale) return;
        const appliedFactor: number = nextScale / previousScale;
        this.scaleX = nextScale;
        this.offsetX = anchorX - (anchorX - this.offsetX) * appliedFactor;
        this.followsLiveEdge = this.isAtLiveEdge();
        this.updateViewport();
    }

    public setData(candles: readonly CandleData[]): void {
        this.assertAlive();
        this.loadData(candles, false);
    }

    public setTheme(theme: ChartTheme): void {
        this.assertAlive();
        this.applyOptions({ theme });
    }

    // --- Runtime options --------------------------------------------------------

    /**
     * Merges a partial over the current options and re-resolves. Throws
     * `MatrixCharts: ...` before mutating anything if a value is invalid.
     *
     * A `theme` change re-seeds every color from that theme's preset and then
     * re-applies any colour or setting the caller set explicitly, so an override
     * survives a theme switch. `maxRetainedCandles` is rejected here; it is
     * constructor-only in v1 because changing it rebuilds the retained pyramid
     * under a live viewport.
     */
    public applyOptions(partial: ChartOptions): void {
        this.assertAlive();
        if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
            throw new Error(`MatrixCharts: applyOptions expects an options object, received ${String(partial)}.`);
        }
        // Resolve before mutating so a throw leaves the chart untouched.
        const nextExplicit: ChartOptions = mergeOptionPartials(this.explicitOptions, partial);
        const nextResolved: ResolvedChartOptions = resolveOptions(nextExplicit, this.resolvedOptions.theme);
        const nextColors: ResolvedCandleColors = resolveCandleColors(nextResolved);

        const previous: ResolvedChartOptions = this.resolvedOptions;
        const previousSpacing: number = this.scaleX;
        this.explicitOptions = nextExplicit;
        this.resolvedOptions = nextResolved;
        this.candleColors = nextColors;

        this.canvasWrapper.style.backgroundColor = nextResolved.layout.background;

        if (nextResolved.timeScale.barSpacing !== previous.timeScale.barSpacing) {
            this.applyBarSpacing(nextResolved.timeScale.barSpacing, previousSpacing);
        }
        if (
            nextResolved.timeScale.minBarSpacing !== previous.timeScale.minBarSpacing ||
            nextResolved.timeScale.maxBarSpacing !== previous.timeScale.maxBarSpacing
        ) {
            // Re-clamp against the new bounds in case the current zoom is now illegal.
            this.scaleX = this.clampBarSpacing(this.scaleX);
        }

        this.emitter.emit('options', nextResolved);
        this.updateViewport();
    }

    /** Fully resolved options. The returned object is a fresh, immutable snapshot. */
    public options(): Readonly<ResolvedChartOptions> {
        this.assertAlive();
        return this.resolvedOptions;
    }

    private clampBarSpacing(spacing: number): number {
        const { minBarSpacing, maxBarSpacing } = this.resolvedOptions.timeScale;
        return Math.max(minBarSpacing, Math.min(maxBarSpacing, spacing));
    }

    /**
     * Sets bar spacing while holding the view still: a live-following chart stays
     * pinned to the newest bar, anything else keeps the bar under the viewport
     * centre where it was.
     */
    private applyBarSpacing(nextSpacing: number, previousSpacing: number): void {
        const clamped: number = this.clampBarSpacing(nextSpacing);
        if (previousSpacing <= 0 || clamped === previousSpacing) {
            this.scaleX = clamped;
            return;
        }

        if (this.followsLiveEdge) {
            this.scaleX = clamped;
            this.offsetX = liveEdgeOffsetX(plotRight(this.viewport), this.candlePyramid.candleCount, clamped);
            return;
        }

        // Zoom about the middle of the plot, not of the canvas, so the bar under
        // the pointer stays put once the axes claim space at the edges.
        const centreX: number = plotCentreX(this.viewport);
        const centreIndex: number = coordinateToIndex(this.viewport, centreX);
        this.scaleX = clamped;
        this.offsetX = centreX - centreIndex * clamped;
        this.followsLiveEdge = this.isAtLiveEdge();
    }

    // --- Public API ------------------------------------------------------------

    /** Throws if `destroy()` has run. Called by every public entry point. */
    private assertAlive(): void {
        if (this.destroyed) {
            throw new Error('MatrixCharts: This chart has been destroyed.');
        }
    }

    // --- User events ------------------------------------------------------------
    // Handlers are held in Sets and iterated over a copy, so subscribing or
    // unsubscribing from inside a handler is safe and cannot skip a listener.

    /** Fires as the pointer moves over the chart, and once when it leaves. */
    public subscribeCrosshairMove(handler: (event: CrosshairMoveEvent) => void): Unsubscribe {
        this.assertAlive();
        this.crosshairHandlers.add(handler);
        return () => { this.crosshairHandlers.delete(handler); };
    }

    /** Fires on a press and release that did not turn into a pan or pinch. */
    public subscribeClick(handler: (event: ChartClickEvent) => void): Unsubscribe {
        this.assertAlive();
        this.clickHandlers.add(handler);
        return () => { this.clickHandlers.delete(handler); };
    }

    /**
     * Fires when the visible candle range or bar spacing changes, at most once
     * per animation frame. A drag that stays inside one bar's width is silent.
     */
    public subscribeVisibleRangeChange(handler: (event: VisibleRangeEvent) => void): Unsubscribe {
        this.assertAlive();
        this.visibleRangeHandlers.add(handler);
        return () => { this.visibleRangeHandlers.delete(handler); };
    }

    private emitCrosshair(): void {
        // Re-entrancy guard: a handler that calls back into the chart (applyOptions,
        // setData) must not be able to drive an unbounded emission loop.
        if (this.emittingCrosshair) return;
        this.emittingCrosshair = true;
        try {
            this.dispatchCrosshair();
        } finally {
            this.emittingCrosshair = false;
        }
    }

    private dispatchCrosshair(): void {
        const payload: ChartEvents['crosshair'] = {
            x: this.crosshairX,
            y: this.crosshairY,
            time: this.crosshairCandle ? this.crosshairCandle.time : null,
            candle: this.crosshairCandle,
        };
        this.emitter.emit('crosshair', payload);
        if (this.crosshairHandlers.size === 0) return;
        const event: CrosshairMoveEvent = this.crosshairCandle
            ? {
                x: this.crosshairX as number,
                y: this.crosshairY as number,
                index: this.crosshairIndex,
                time: this.crosshairCandle.time,
                price: coordinateToPrice(this.viewport, this.crosshairY as number),
                candle: this.crosshairCandle,
            }
            : { x: null, y: null, index: -1, time: null, price: null, candle: null };
        for (const handler of Array.from(this.crosshairHandlers)) handler(event);
    }

    private updateCrosshair(clientX: number, clientY: number): void {
        const rect: DOMRect = this.canvasWrapper.getBoundingClientRect();
        const x: number = clientX - rect.left;
        const y: number = clientY - rect.top;
        const index: number = this.coordinateToNearestIndex(x);
        const candle: CandleData | null = index < 0 ? null : this.getCandleAt(index);

        if (!candle) {
            this.clearCrosshair();
            return;
        }

        // The crosshair snaps to the bar it points at; the price line keeps
        // following the pointer so the price readout tracks the cursor.
        const snappedX: number = this.indexToCoordinate(index);
        if (this.crosshairX === snappedX && this.crosshairY === y && this.crosshairIndex === index) {
            return;
        }
        this.crosshairX = snappedX;
        this.crosshairY = y;
        this.crosshairIndex = index;
        this.crosshairCandle = candle;
        this.emitCrosshair();
    }

    private clearCrosshair(): void {
        if (this.crosshairX === null && this.crosshairY === null && this.crosshairCandle === null) return;
        this.crosshairX = null;
        this.crosshairY = null;
        this.crosshairIndex = -1;
        this.crosshairCandle = null;
        this.emitCrosshair();
    }

    private emitClick(clientX: number, clientY: number, button: number): void {
        if (this.clickHandlers.size === 0) return;
        const rect: DOMRect = this.canvasWrapper.getBoundingClientRect();
        const x: number = clientX - rect.left;
        const y: number = clientY - rect.top;
        const index: number = this.coordinateToNearestIndex(x);
        const candle: CandleData | null = index < 0 ? null : this.getCandleAt(index);
        const event: ChartClickEvent = candle
            ? {
                x: this.indexToCoordinate(index),
                y,
                index,
                time: candle.time,
                price: coordinateToPrice(this.viewport, y),
                candle,
                button,
            }
            : { x: null, y: null, index: -1, time: null, price: null, candle: null, button };
        for (const handler of Array.from(this.clickHandlers)) handler(event);
    }

    // --- Public read API -------------------------------------------------------
    // All synchronous, all CSS pixels relative to the container's top-left, and
    // none of them copy the series. They read the same geometry the renderer
    // draws with, so a value here always matches what is on screen.

    /** Current plot geometry. Internal; exposed for the renderer and tests. */
    private get viewport(): ChartViewport {
        const cssWidth: number = this.canvasWrapper.clientWidth || FALLBACK_CSS_WIDTH;
        const cssHeight: number = this.canvasWrapper.clientHeight || FALLBACK_CSS_HEIGHT;
        return {
            offsetX: this.offsetX,
            offsetY: this.offsetY,
            scaleX: this.scaleX,
            scaleY: this.scaleY,
            cssWidth,
            cssHeight,
            plot: this.plotRect(cssWidth, cssHeight),
        };
    }

    /**
     * The region series are drawn into: the canvas less the gutters reserved for
     * the price axis on the left and the time axis along the bottom. Every
     * consumer derives from this, so the transform, the live edge, the visible
     * range, and the vertical fit cannot each invent their own idea of where the
     * plot ends.
     *
     * A gutter larger than the canvas collapses the plot to nothing rather than
     * inverting it, because an inverted rect would flip the price axis and make
     * every reported range meaningless.
     */
    private plotRect(cssWidth: number, cssHeight: number): PlotRect {
        const { priceAxisWidth, timeAxisHeight } = this.resolvedOptions.layout;
        const width: number = Math.max(0, cssWidth - priceAxisWidth);
        const height: number = Math.max(0, cssHeight - timeAxisHeight);
        return { x: priceAxisWidth, y: 0, width, height };
    }

    /** CSS pixels per candle index. */
    public getBarSpacing(): number {
        this.assertAlive();
        return this.scaleX;
    }

    /**
     * Visible candle indices as a half-open range: `from` through `to - 1`.
     * Partial bars at either edge are included, and `from === to` means the
     * series is empty or fully scrolled out of view.
     */
    public getVisibleLogicalRange(): LogicalRange {
        this.assertAlive();
        return visibleLogicalRange(this.viewport, this.candlePyramid.candleCount);
    }

    /**
     * Epoch milliseconds of the first and last visible candles, both inclusive,
     * or `null` when no candle is visible. Closed sessions are not interpolated,
     * so the span can be wider than the elapsed visible time.
     */
    public getVisibleTimeRange(): TimeRange | null {
        this.assertAlive();
        const { from, to } = this.getVisibleLogicalRange();
        if (to <= from) return null;
        const first: CandleData | null = this.getCandleAt(from);
        const last: CandleData | null = this.getCandleAt(to - 1);
        if (!first || !last) return null;
        return { from: first.time, to: last.time };
    }

    /** Number of candles retained in chart memory. */
    public getCandleCount(): number {
        this.assertAlive();
        return this.candlePyramid.candleCount;
    }

    /**
     * Retained candle at a zero-based ordinal index, or `null` when the index is
     * out of range. Prices come back at float32 precision, matching what the
     * renderer draws, so they may differ from the doubles that were passed in.
     */
    public getCandleAt(index: number): CandleData | null {
        this.assertAlive();
        const candleCount: number = this.candlePyramid.candleCount;
        if (!Number.isInteger(index) || index < 0 || index >= candleCount) return null;
        const time: number | undefined = this.candleTimes[index];
        if (time === undefined) return null;

        const level: Float32Array = this.candlePyramid.getLevelData(0);
        const offset: number = index * CANDLE_STRIDE;
        const volume: number = level[offset + CANDLE_VOLUME];
        return {
            time,
            open: level[offset + CANDLE_OPEN],
            high: level[offset + CANDLE_HIGH],
            low: level[offset + CANDLE_LOW],
            close: level[offset + CANDLE_CLOSE],
            // Reported only when there is something to report, so a series with no
            // volume does not grow a field of zeroes that reads like real data.
            ...(volume > 0 ? { volume } : {}),
        };
    }

    /** Newest retained candle, or `null` when the chart has no data. */
    public getLastCandle(): CandleData | null {
        this.assertAlive();
        return this.getCandleAt(this.candlePyramid.candleCount - 1);
    }

    /** Screen x of a candle index. */
    public indexToCoordinate(index: number): number {
        this.assertAlive();
        return indexToCoordinate(this.viewport, index);
    }

    /** Fractional candle index at a screen x. Not clamped to the series. */
    public coordinateToIndex(coordinateX: number): number {
        this.assertAlive();
        return coordinateToIndex(this.viewport, coordinateX);
    }

    /** Index of the candle nearest a screen x, or -1 when the chart has no data. */
    public coordinateToNearestIndex(coordinateX: number): number {
        this.assertAlive();
        return nearestCandleIndex(this.viewport, coordinateX, this.candlePyramid.candleCount);
    }

    /**
     * Timestamp of the candle nearest a screen x, or `null` when the chart has no
     * data. Snaps to a real candle time and never interpolates through a gap.
     */
    public coordinateToTime(coordinateX: number): number | null {
        this.assertAlive();
        const index: number = this.coordinateToNearestIndex(coordinateX);
        return index < 0 ? null : this.getCandleAt(index)?.time ?? null;
    }

    /**
     * Screen x of the candle whose timestamp is nearest `time`, or `null` when
     * the chart has no data. Inverse of `coordinateToTime` up to snapping.
     */
    public timeToCoordinate(time: number): number | null {
        this.assertAlive();
        const index: number = nearestCandleIndexByTime(
            this.candleTimes.length,
            time,
            (candidate: number): number => this.candleTimes[candidate],
        );
        return index < 0 ? null : this.indexToCoordinate(index);
    }

    /** Screen y of a price. */
    public priceToCoordinate(price: number): number {
        this.assertAlive();
        return priceToCoordinate(this.viewport, price);
    }

    /** Price at a screen y, using the current auto-fitted vertical scale. */
    public coordinateToPrice(coordinateY: number): number {
        this.assertAlive();
        return coordinateToPrice(this.viewport, coordinateY);
    }

    /** Replaces authoritative feed history while retaining the current time anchor when available. */
    public replaceData(candles: readonly CandleData[]): void {
        this.assertAlive();
        this.loadData(candles, true);
    }

    private loadData(candles: readonly CandleData[], preserveViewport: boolean): void {
        const previousCount: number = this.candlePyramid.candleCount;
        const previousFollowing: boolean = this.followsLiveEdge;
        const previousScale: number = this.scaleX;
        const anchorScreenX: number = plotCentreX(this.viewport);
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
        const rawCandles: Float32Array = new Float32Array(retainedLength * CANDLE_STRIDE);
        const times: number[] = new Array<number>(retainedLength);
        let previousTime: number = Number.NEGATIVE_INFINITY;

        for (let candleIndex: number = 0; candleIndex < candles.length; candleIndex++) {
            const candle: CandleData = candles[candleIndex];
            this.validateCandle(candle, previousTime, candleIndex);
            previousTime = candle.time;

            if (candleIndex < retainedStart) continue;

            const retainedIndex: number = candleIndex - retainedStart;
            this.writeCandleRecord(rawCandles, retainedIndex, retainedIndex, candle);
            times[retainedIndex] = candle.time;
        }

        this.candlePyramid.reset(rawCandles);
        this.candleTimes = times;
        this.followsLiveEdge = true;

        if (preserveViewport && retainedLength > 0 && previousCount > 0) {
            this.scaleX = previousScale;
            if (previousFollowing) {
                this.offsetX = liveEdgeOffsetX(plotRight(this.viewport), retainedLength, this.scaleX);
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
            this.scaleX = DEFAULT_CANDLE_SPACING_PX;
            this.offsetX = liveEdgeOffsetX(plotRight(this.viewport), retainedLength, this.scaleX);
        }
        this.updateViewport();
    }

    private findNearestDataIndex(candles: readonly CandleData[], retainedStart: number, time: number): number {
        return nearestCandleIndexByTime(
            candles.length,
            time,
            (index: number): number => candles[index].time,
            retainedStart,
        ) - retainedStart;
    }

    public appendData(candle: CandleData): void {
        this.assertAlive();
        this.appendBatch([candle]);
    }

    /** Appends a chronological batch after validating every candle before mutation. */
    public appendBatch(candles: readonly CandleData[]): void {
        this.assertAlive();
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
        this.assertAlive();
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
        // Volume is optional, so it is only checked when it was actually supplied.
        // A present-but-invalid volume is a data error, not a missing field, and
        // is rejected here rather than being quietly drawn as zero.
        const volumeSupplied: boolean = candle.volume !== undefined;
        if (
            !values.every(Number.isFinite) ||
            !floatValues.every((value: number): boolean => Number.isFinite(Math.fround(value))) ||
            (volumeSupplied && (
                !Number.isFinite(candle.volume) ||
                !Number.isFinite(Math.fround(candle.volume as number)) ||
                (candle.volume as number) < 0
            )) ||
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
        return isAtLiveEdgeOffset(
            this.offsetX,
            this.scaleX,
            this.candlePyramid.candleCount,
            plotRight(this.viewport),
        );
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

    /**
     * Writes one interleaved candle record into a source buffer. Every ingest
     * path funnels through here so the record layout is defined in exactly one
     * place; a channel added to `CandleData` is appended here once rather than at
     * each of the call sites.
     */
    private writeCandleRecord(
        target: Float32Array,
        recordIndex: number,
        ordinalIndex: number,
        candle: CandleData,
    ): void {
        const offset: number = recordIndex * CANDLE_STRIDE;
        target[offset + CANDLE_X] = ordinalIndex;
        target[offset + CANDLE_OPEN] = candle.open;
        target[offset + CANDLE_HIGH] = candle.high;
        target[offset + CANDLE_LOW] = candle.low;
        target[offset + CANDLE_CLOSE] = candle.close;
        target[offset + CANDLE_WIDTH] = DEFAULT_BODY_WIDTH_WEIGHT;
        target[offset + CANDLE_VOLUME] = candleVolume(candle);
    }

    private flushPendingData(): void {
        if (this.pendingReplace) {
            const replacement: CandleData[] = this.pendingAppends;
            this.pendingAppends = [];
            this.pendingLastUpdate = null;
            this.pendingReplace = false;

            const rawCandles: Float32Array = new Float32Array(replacement.length * CANDLE_STRIDE);
            const times: number[] = new Array<number>(replacement.length);
            for (let index: number = 0; index < replacement.length; index++) {
                const candle: CandleData = replacement[index];
                this.writeCandleRecord(rawCandles, index, index, candle);
                times[index] = candle.time;
            }
            this.candlePyramid.reset(rawCandles);
            this.candleTimes = times;
            if (this.followsLiveEdge) {
                this.offsetX = liveEdgeOffsetX(
                    plotRight(this.viewport),
                    replacement.length,
                    this.scaleX,
                );
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
                DEFAULT_BODY_WIDTH_WEIGHT,
                candleVolume(lastUpdate),
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
                DEFAULT_BODY_WIDTH_WEIGHT,
                candleVolume(candle),
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
                this.offsetX = liveEdgeOffsetX(
                    plotRight(this.viewport),
                    this.candlePyramid.candleCount,
                    this.scaleX,
                );
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

    /**
     * Fits the vertical scale to the visible candles. The fit uses the highs and
     * lows of the pyramid level actually being drawn, so it matches what is on
     * screen, and it fills the whole plot height; there is no plot rect yet, so
     * "plot" is currently the entire canvas.
     */
    private autoScaleY(): void {
        if (this.displayedCandles.length === 0) return;

        const plot: PlotRect = this.viewport.plot;
        const plotBottom: number = plot.y + plot.height;

        let maxHigh = Number.NEGATIVE_INFINITY;
        let minLow = Number.POSITIVE_INFINITY;
        const count: number = this.displayedCandles.length / CANDLE_STRIDE;
        for (let i: number = 0; i < count; i++) {
            const offset: number = i * CANDLE_STRIDE;
            maxHigh = Math.max(maxHigh, this.displayedCandles[offset + CANDLE_HIGH]);
            minLow = Math.min(minLow, this.displayedCandles[offset + CANDLE_LOW]);
        }

        // Add 10% padding to top and bottom
        const priceRange = maxHigh - minLow;
        const padding = priceRange === 0
            ? Math.max(Math.abs(maxHigh) * 0.1, 1)
            : priceRange * 0.1;

        const paddedMin = minLow - padding;
        const paddedMax = maxHigh + padding;

        // Fitted to the plot rect, so the highest and lowest visible candle land
        // inside the plot rather than inside the canvas.
        this.scaleY = -plot.height / (paddedMax - paddedMin);
        this.offsetY = plotBottom - paddedMin * this.scaleY;
    }

    private updateViewport(): void {
        this.cancelScheduledViewportUpdate();
        // Self-heal the backing store before anything reads it, so a container
        // that resized without notifying us still renders at the right size.
        this.syncRendererSize();
        this.flushPendingData();
        this.updateVisibleCandles();
        this.autoScaleY();
        // Broadcast the spatial update to all subscribed renderers without coupling
        this.emitter.emit('viewport', {
            offsetX: this.offsetX,
            offsetY: this.offsetY,
            scaleX: this.scaleX,
            scaleY: this.scaleY,
            plot: this.viewport.plot,
        });
        this.uploadVisibleCandles();
        // A pan, zoom, or feed append moves the bars under a stationary pointer,
        // so the crosshair has to be recomputed before the redraw that shows it.
        this.refreshCrosshairAfterViewportChange();
        this.redraw();
        this.scheduleVisibleRangeChange();
    }

    private refreshCrosshairAfterViewportChange(): void {
        if (this.crosshairCandle === null) return;
        if (this.isInteracting()) return;
        this.updateCrosshair(this.pointerClientX, this.pointerClientY);
    }

    /**
     * Coalesces range notifications to one per frame. updateViewport runs from
     * pointer handlers that can fire faster than the display, and from a rAF
     * callback during feed flushes; both collapse to a single event.
     */
    private scheduleVisibleRangeChange(): void {
        if (this.visibleRangeHandlers.size === 0) return;
        if (this.scheduledRangeFrame !== null) return;
        // A range change caused from inside a range handler is not re-notified.
        // Without this, a handler that restyles the chart on every notification
        // would schedule a fresh frame forever.
        if (this.emittingVisibleRange) return;
        this.scheduledRangeFrame = requestAnimationFrame(() => {
            this.scheduledRangeFrame = null;
            this.emitVisibleRangeChange();
        });
    }

    private cancelScheduledVisibleRangeChange(): void {
        if (this.scheduledRangeFrame === null) return;
        cancelAnimationFrame(this.scheduledRangeFrame);
        this.scheduledRangeFrame = null;
    }

    private emitVisibleRangeChange(): void {
        if (this.visibleRangeHandlers.size === 0) return;
        if (this.emittingVisibleRange) return;
        const logical: LogicalRange = this.getVisibleLogicalRange();
        const barSpacing: number = this.scaleX;
        if (isSameVisibleRange(this.lastReportedRange, logical, barSpacing)) return;
        this.lastReportedRange = { logical, barSpacing };
        const event: VisibleRangeEvent = {
            logical,
            time: this.getVisibleTimeRange(),
            barSpacing,
        };
        this.emittingVisibleRange = true;
        try {
            for (const handler of Array.from(this.visibleRangeHandlers)) handler(event);
        } finally {
            this.emittingVisibleRange = false;
        }
    }

    private updateVisibleCandles(): void {
        const viewport: ChartViewport = this.viewport;
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
            const visibleMinX: number = coordinateToIndex(viewport, viewport.plot.x);
            const visibleMaxX: number = coordinateToIndex(
                viewport,
                viewport.plot.x + viewport.plot.width,
            );
            const startBucket: number = Math.max(0, Math.floor(visibleMinX / aggregationFactor) - 1);
            const endBucket: number = Math.min(
                levelCount,
                Math.ceil(visibleMaxX / aggregationFactor) + 2,
            );
            this.displayedCandles = endBucket > startBucket
                ? level.slice(startBucket * CANDLE_STRIDE, endBucket * CANDLE_STRIDE)
                : new Float32Array(0);
        }

    }

    private uploadVisibleCandles(): void {
        // Colours were parsed to vec4 when the options were applied, so this
        // per-frame path only copies four precomputed channels.
        const style: CandleStyle = this.resolvedOptions.candlestick.style;
        if (style === 'line' || style === 'area') {
            // These styles plot a single price per bar, so they are line geometry
            // rather than candle geometry. The candle series is cleared so a
            // previous style's bodies do not linger behind the line.
            this.dataRenderer.clearCandlesticks();
            this.uploadVisibleClose(style);
        } else {
            this.dataRenderer.drawCandlesticks(this.displayedCandles, {
                colors: this.candleColors,
                style,
                wickVisible: this.resolvedOptions.candlestick.wickVisible,
                borderVisible: this.resolvedOptions.candlestick.borderVisible,
                baselinePrice: this.baselinePrice(),
            });
        }
        this.uploadVisibleVolume();
        this.emitter.emit('data', { times: this.candleTimes });
    }

    /**
     * Uploads the close price as a polyline, and as an area fill beneath it.
     *
     * The two styles share the same points, so the fill edge and the stroke edge
     * are the same numbers and cannot drift apart.
     */
    private uploadVisibleClose(style: CandleStyle): void {
        const count: number = this.displayedCandles.length / CANDLE_STRIDE;
        if (count < 2) {
            this.dataRenderer.clearLine();
            this.dataRenderer.clearArea();
            return;
        }
        const points = new Float32Array(count * 2);
        for (let i = 0; i < count; i++) {
            const offset: number = i * CANDLE_STRIDE;
            points[i * 2] = this.displayedCandles[offset + CANDLE_X];
            points[i * 2 + 1] = this.displayedCandles[offset + CANDLE_CLOSE];
        }
        const lineColor = this.resolvedOptions.candlestick.lineColor;
        this.dataRenderer.drawLine(points, lineColor);

        if (style === 'area') {
            // The fill runs to the bottom of the plot, which is the lowest price
            // the axis can show, so the area never invents a scale of its own.
            const plot: PlotRect = this.viewport.plot;
            this.dataRenderer.drawArea(
                points,
                this.resolvedOptions.candlestick.areaFillColor,
                coordinateToPrice(this.viewport, plot.y + plot.height),
            );
        } else {
            this.dataRenderer.clearArea();
        }
    }

    /**
     * The reference price for the baseline style: the configured one, or the close
     * of the first visible candle. Defaulting to a real close keeps the line on
     * screen, where a caller-chosen price far outside the fitted range would draw
     * nothing at all.
     */
    private baselinePrice(): number | null {
        if (this.resolvedOptions.candlestick.style !== 'baseline') return null;
        const configured: number | null = this.resolvedOptions.candlestick.baselinePrice;
        if (configured !== null) return configured;
        if (this.displayedCandles.length === 0) return null;
        return this.displayedCandles[CANDLE_CLOSE];
    }

    /**
     * Fits the histogram to the bottom of the plot and uploads it.
     *
     * The volume scale is its own: bars are measured against the largest volume
     * on screen, so a volume spike cannot stretch the price axis. The region is
     * the bottom `heightRatio` of the plot for now; when volume gets its own pane
     * this becomes that pane's height and nothing else about the scaling changes.
     */
    private uploadVisibleVolume(): void {
        const volume = this.resolvedOptions.volume;
        if (!volume.visible || this.displayedCandles.length === 0) {
            this.dataRenderer.clearHistogram();
            return;
        }

        const plot: PlotRect = this.viewport.plot;
        const regionHeight: number = plot.height * volume.heightRatio;
        if (regionHeight <= 0) {
            this.dataRenderer.clearHistogram();
            return;
        }

        // Scanned twice: once for the peak, once to draw. The slice is already
        // bounded by the visible window, so this is over the bars on screen only.
        let peak = 0;
        const count: number = this.displayedCandles.length / CANDLE_STRIDE;
        for (let i: number = 0; i < count; i++) {
            const value: number = this.displayedCandles[i * CANDLE_STRIDE + CANDLE_VOLUME];
            if (value > peak) peak = value;
        }
        if (!(peak > 0)) {
            // Nothing to draw. An all-zero series would otherwise render a row of
            // zero-height bars, which is a different thing from "no volume".
            this.dataRenderer.clearHistogram();
            return;
        }

        // Bars occupy the bottom of the plot, growing upward, so the price axis
        // keeps the full height and the histogram reads as a strip beneath it.
        const scaleY: number = -(regionHeight * 0.92) / peak;
        const baseline: number = plot.y + plot.height;
        const offsetY: number = baseline - 0 * scaleY;
        this.dataRenderer.drawHistogram(
            this.displayedCandles,
            volume.colors,
            scaleY,
            offsetY,
        );
    }

    public destroy(): void {
        // Idempotent: teardown code often runs from more than one place.
        if (this.destroyed) return;
        this.cancelScheduledViewportUpdate();
        this.cancelScheduledVisibleRangeChange();
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        this.canvasWrapper.removeEventListener('pointerdown', this.handlePointerDown);
        this.canvasWrapper.removeEventListener('pointermove', this.handlePointerMove);
        this.canvasWrapper.removeEventListener('pointerup', this.handlePointerEnd);
        this.canvasWrapper.removeEventListener('pointercancel', this.handlePointerEnd);
        this.canvasWrapper.removeEventListener('lostpointercapture', this.handlePointerEnd);
        this.canvasWrapper.removeEventListener('pointerleave', this.handlePointerLeave);
        this.canvasWrapper.removeEventListener('wheel', this.handleWheel);
        // Drop every subscriber so a destroyed chart cannot call back into
        // application code, and so handlers are not retained by this instance.
        this.crosshairHandlers.clear();
        this.clickHandlers.clear();
        this.visibleRangeHandlers.clear();
        this.lastReportedRange = null;
        this.emittingCrosshair = false;
        this.emittingVisibleRange = false;
        this.resizeObserver.disconnect();
        for (const renderer of this.renderers) {
            renderer.destroy();
        }
        this.renderers.length = 0;
        this.destroyed = true;
        // Remove only the wrapper this chart created. Wiping the container would
        // take any legend, toolbar, or other markup the caller put there with it.
        this.canvasWrapper.remove();
    }
}
