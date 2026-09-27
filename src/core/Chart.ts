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
    ResolvedPanes,
    Rgba,
} from './options.js';
import { mergeOptionPartials, parseCssColor, resolveCandleColors, resolveOptions } from './options.js';
import { resolveChartContainer } from './resolveChartContainer.js';
import {
    fitPaneTransform,
    paneRects,
    paneValueAt,
    visibleOverlayRange,
    PRICE_PANE,
} from './panes.js';
import type { PaneLayout } from './panes.js';
import {
    markerAnchorPrice,
    resolveMarkers,
    resolvePriceLines,
    resolveZones,
    type AnchorCandle,
    type MarkerSpec,
    type PlacedMarker,
    type PlacedZone,
    type PriceLineSpec,
    type ResolvedMarker,
    type ResolvedPriceLine,
    type ZoneSpec,
} from './decorations.js';
import type { VerticalTransform } from '../renderers/WebGLSeries.js';
import {
    fromScaleSpace,
    representableRange,
    toScaleSpace,
    type PriceScale,
} from './priceScale.js';
import {
    computeSlotOffsets,
    indexAtTime,
    resolveSessionBreaks,
    sizeSessionBreaks,
    slotAtIndex,
} from './sessionScale.js';
import {
    bucketOverlay,
    resolveOverlays,
    type OverlaySpec,
    type ResolvedOverlay,
} from './overlays.js';
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
    coordinateToSlot,
    coordinateToPrice,
    indexToCoordinate,
    isAtLiveEdgeOffset,
    isSameVisibleRange,
    liveEdgeOffsetX,
    nearestCandleIndex,
    nearestCandleIndexByTime,
    plotCentreX,
    plotRight,
    visibleLogicalRange,
} from './coordinates.js';

/** Container size assumed before the first layout pass. */
const FALLBACK_CSS_WIDTH = 800;
const FALLBACK_CSS_HEIGHT = 500;

/** Pointer travel, in CSS pixels, that turns a press into a pan rather than a click. */
const CLICK_SLOP_PX = 4;

/**
 * Bounds on the span multiplier one price-axis drag may apply.
 *
 * A drag is unbounded input — the pointer can leave the window — so the factor is
 * clamped rather than merely guarded. Clamping means the axis stops moving at the
 * limit and the gesture stays reversible: dragging back from the limit retraces the
 * range exactly, because every move is measured from the press baseline rather than
 * from the last frame. Rejecting instead would leave the axis stuck at whatever the
 * last accepted move produced, which is a worse thing to drag back out of.
 *
 * Ten-fold is generous for a single gesture and the bounds are not the interesting
 * part: a trader who wants forty-fold zooms in twice.
 */
const AXIS_DRAG_MIN_FACTOR = 0.1;
const AXIS_DRAG_MAX_FACTOR = 10;

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
    /**
     * A drag of the price axis, which is a single-pointer gesture distinct from both
     * a pan and a pinch.
     *
     * The baseline is the pane's range in *scale* space at the moment of the press,
     * not the previous frame's range. Every move is measured from the press, so the
     * result is a function of where the drag started and where the pointer is now —
     * a chain of per-frame multiplications would accumulate float error over a long
     * drag and would make the gesture's result depend on the event rate. `paneHeight`
     * is the height the press was measured against, held for the same reason: a resize
     * mid-drag must not retroactively rescale a gesture already under way.
     */
    private priceAxisDrag: {
        pressY: number;
        paneHeight: number;
        baseLow: number;
        baseHigh: number;
    } | null = null;
    private offsetX: number = 0;
    private scaleX: number = 1;
    private offsetY: number = 0;
    private scaleY: number = 1;
    private candlePyramid: OHLCPyramid = new OHLCPyramid();
    private displayedCandles: Float32Array = new Float32Array(0);
    private candleTimes: number[] = [];
    private overlays: ResolvedOverlay[] = [];
    /**
     * The specs as last supplied, kept so a change to the pane count can
     * re-validate them. Resolved overlays alone are not enough for that, because
     * a pane index has already been resolved away by then.
     */
    private overlaySpecs: readonly OverlaySpec[] = [];
    /** Decorations, drawn on the UI layer rather than as series. */
    private priceLines: ResolvedPriceLine[] = [];
    private markers: ResolvedMarker[] = [];
    private zones: PlacedZone[] = [];
    /** Set by setPriceRange; null while the pane is free to fit the data. */
    private lockedPriceRange: [number, number] | null = null;
    /**
     * Reused each frame, so a log chart converts prices in place rather than
     * reallocating a full candle buffer on every animation frame.
     */
    private scaledCandleBuffer: Float32Array = new Float32Array(0);
    /**
     * Slot offset of every retained bar, or null when the series has no breaks.
     *
     * Rebuilt only when the data changes. Pan and zoom never touch it, which is
     * the reason the unit is slots: a per-bar table rebuilt on every wheel tick
     * would cost more than the candle pyramid, and a table in wall-clock deltas
     * would make the x transform a function of the viewport rather than of the data.
     */
    private slotOffsets: Float64Array | null = null;
    /**
     * Pane rects and vertical transforms for the current frame, in CSS pixels.
     * Recomputed with the viewport, because both depend on it.
     */
    private paneLayout: PaneLayout = { rects: [], transforms: [], empty: [] };
    private paneRects: PlotRect[] = [];
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
            // A press on the price axis owns the vertical scale; anywhere else it is a
            // pan. The two are mutually exclusive on purpose — a drag that started on
            // the axis must not also slide the series sideways, because the caller
            // asked for a price span and would silently get a moved one as well.
            if (this.isOnPriceAxis(event.clientX)) {
                this.beginPriceAxisDrag(event.clientY);
            } else {
                this.priceAxisDrag = null;
                this.isDragging = true;
                this.lastPointerX = event.clientX;
            }
        } else if (this.activePointers.size === 2) {
            // A second finger converts the gesture to a pinch, which is horizontal.
            // The axis drag is dropped rather than resumed, so lifting one finger
            // cannot re-apply a baseline captured before the pinch moved anything.
            this.priceAxisDrag = null;
            this.isDragging = false;
            this.pressMoved = true;
            this.resetPinchBaseline();
        }
    };

    /**
     * Whether a press at this client x landed on the price axis rather than the plot.
     *
     * The price axis is the left gutter, `layout.priceAxisWidth` wide, exactly as
     * `plotRect` reserves it. Read from the same option and the same rect, so the
     * hit region and the drawn gutter cannot drift apart — a hit test measuring the
     * canvas centre instead would claim the whole left half of the plot.
     */
    private isOnPriceAxis(clientX: number): boolean {
        const width: number = this.resolvedOptions.layout.priceAxisWidth;
        if (!(width > 0)) return false;
        const rect: DOMRect = this.canvasWrapper.getBoundingClientRect();
        return clientX - rect.left < width;
    }

    /**
     * Begins a price-axis drag, capturing the baseline it will be measured against.
     *
     * The baseline is the pane's current range in scale space. A press is recorded
     * even when the pane has no usable height or the chart has no vertical transform
     * yet; in that case `beginPriceAxisDrag` leaves the drag null and the press falls
     * through as an ordinary one, so a degenerate chart is inert rather than throwing
     * on a pointer event.
     */
    private beginPriceAxisDrag(clientY: number): void {
        this.priceAxisDrag = null;
        this.isDragging = false;
        const pane: PlotRect = this.pricePaneRect();
        if (!(pane.height > 0) || this.scaleY === 0) return;
        const transform: VerticalTransform = { scaleY: this.scaleY, offsetY: this.offsetY };
        const atTop: number = paneValueAt(transform, pane.y);
        const atBottom: number = paneValueAt(transform, pane.y + pane.height);
        this.priceAxisDrag = {
            pressY: clientY,
            paneHeight: pane.height,
            baseLow: Math.min(atTop, atBottom),
            baseHigh: Math.max(atTop, atBottom),
        };
    }

    /**
     * Maps the pointer's vertical travel onto a new price span and locks it.
     *
     * Dragging *down* expands and dragging *up* compresses, one pane height of travel
     * for a factor of two, measured from the press so the gesture is a function of
     * its endpoints rather than of how many events it took to get there. The scale is
     * applied about the centre of the range, which is the one point the gesture leaves
     * alone — a drag is about the span, and hinging at the centre keeps that true
     * wherever on the axis it was grabbed.
     *
     * The arithmetic is in scale space, so a log axis compresses by a ratio of log
     * rather than by a difference of price. That is the same reason `autoScaleY`
     * applies its padding there: ten percent of the visible span has to mean the same
     * thing on either axis, or a log pane's headroom would be in currency units.
     */
    private updatePriceAxisDrag(clientY: number): void {
        const drag = this.priceAxisDrag;
        if (drag === null) return;
        // Nothing happens until the press has actually travelled. Without this a
        // one-pixel twitch while clicking the axis rescales the pane by a fraction of
        // a percent *and locks it*, so brushing the axis would silently take the
        // vertical scale away from the caller. The same slop that separates a pan
        // from a click separates a drag from a click, for the same reason and with
        // the same constant — the press has to mean it.
        if (!this.pressMoved) return;
        const travel: number = 1 + (clientY - drag.pressY) / drag.paneHeight;
        const factor: number = Math.min(AXIS_DRAG_MAX_FACTOR, Math.max(AXIS_DRAG_MIN_FACTOR, travel));
        const centre: number = (drag.baseLow + drag.baseHigh) / 2;
        const span: number = (drag.baseHigh - drag.baseLow) * factor;
        const scale: PriceScale = this.priceScale();
        const low: number = fromScaleSpace(centre - span / 2, scale);
        const high: number = fromScaleSpace(centre + span / 2, scale);
        // The clamp above is on the multiplier, so this can still be reached from a
        // range that was already very wide or very narrow. A drag ignores a result it
        // cannot draw rather than throwing: the same contract `setPriceRange` enforces,
        // reached by returning instead, because a pointer move has no caller to report
        // to and throwing here would take the whole gesture down mid-drag.
        if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return;
        if (scale === 'log' && low <= 0) return;
        this.adoptLockedPriceRange([low, high]);
    }

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
        // After the pinch branch, so two pointers always mean pinch. A press on the
        // axis is a single-pointer gesture and the second finger already dropped it.
        if (this.priceAxisDrag !== null) {
            this.updatePriceAxisDrag(event.clientY);
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
            // The axis drag ends with the gesture that started it. Dropping the
            // baseline here is what stops a later press from measuring against a
            // range captured several gestures ago.
            this.priceAxisDrag = null;
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
        // The axis drag counts even though it leaves `isDragging` false: it is a
        // gesture in progress, and without this the crosshair would keep tracking
        // the pointer as hover while the price range is being dragged underneath it.
        return this.isDragging || this.activePointers.size >= 2 || this.priceAxisDrag !== null;
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
        this.setBarSpacingLive(nextScale);
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
        // A pane count change can invalidate an overlay's pane index, so the set is
        // re-validated against the new count before the options are adopted. Throwing
        // here leaves both the options and the overlays exactly as they were.
        const nextOverlays: ResolvedOverlay[] | null =
            nextResolved.panes.weights.length === previous.panes.weights.length
                ? null
                : this.resolveOverlaySpecs(nextResolved, this.overlaySpecs);
        this.explicitOptions = nextExplicit;
        this.resolvedOptions = nextResolved;
        this.candleColors = nextColors;
        if (nextOverlays !== null) this.overlays = nextOverlays;

        // Switching a gap off, or between collapsed and proportional, changes every
        // slot after the first break, so the table is rebuilt here. Not per frame and
        // not on pan or zoom — this is an options change and options change rarely.
        const gapsWere = previous.timeScale.sessionBreaks;
        const gapsAre = nextResolved.timeScale.sessionBreaks;
        if (
            gapsWere.enabled !== gapsAre.enabled ||
            gapsWere.mode !== gapsAre.mode ||
            gapsWere.maxWhitespaceRatio !== gapsAre.maxWhitespaceRatio
        ) {
            this.rebuildSlots();
        }

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

    /**
     * Adopts a bar spacing the user arrived at by interaction, and records it as their
     * configured choice.
     *
     * The explicit options are written as well as the resolved ones because
     * `applyOptions` rebuilds the resolved snapshot from the explicit pair. Syncing only
     * the resolved copy would leave the live scale correct until the next unrelated
     * `applyOptions` — a theme change, a colour — and then quietly revert it, which is
     * worse than never syncing at all because it looks like a rendering fault.
     *
     * The value recorded is the *effective* spacing, after clamping. Recording the
     * requested value instead would put the lie back for anyone who asks for a bar
     * spacing past `maxBarSpacing`, and that is precisely when a readout matters most.
     */
    private setBarSpacingLive(spacing: number): void {
        this.scaleX = spacing;
        this.resolvedOptions.timeScale.barSpacing = spacing;
        this.explicitOptions.timeScale = {
            ...(this.explicitOptions.timeScale ?? {}),
            barSpacing: spacing,
        };
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
            this.setBarSpacingLive(clamped);
            return;
        }

        if (this.followsLiveEdge) {
            this.setBarSpacingLive(clamped);
            this.offsetX = liveEdgeOffsetX(
                plotRight(this.viewport),
                this.slotOffsets,
                this.candlePyramid.candleCount,
                clamped,
            );
            return;
        }

        // Zoom about the middle of the plot, not of the canvas, so the bar under
        // the pointer stays put once the axes claim space at the edges.
        //
        // The anchor is a *slot*, not an index. This used to be exact by accident:
        // `coordinateToIndex` returned `(x - offsetX) / scaleX`, a fraction, so this
        // line was the algebraic inverse of `indexToCoordinate`. Once that lookup
        // started returning a whole bar index the identity broke in two ways at once —
        // the index is not a slot position, and a bar is positioned by its *centre*,
        // not its left edge. The result was every non-live-edge zoom sliding the
        // series sideways by half a bar plus every break before the centre, which on a
        // chart zoomed out over a week of sessions is most of a screen. `coordinateToSlot`
        // is exact with or without a table, so this is now correct by construction
        // rather than by coincidence.
        const centreX: number = plotCentreX(this.viewport);
        const centreSlot: number = coordinateToSlot(this.viewport, centreX);
        this.setBarSpacingLive(clamped);
        this.offsetX = centreX - centreSlot * clamped;
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
                price: this.coordinateToPrice(this.crosshairY as number),
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
                price: this.coordinateToPrice(y),
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
            slots: this.slotOffsets,
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

    /**
     * Replaces the chart's overlay series.
     *
     * Overlays are values supplied from outside the library, drawn on the candle
     * time index. There is no indicator maths here: an EMA, a band, or anything
     * else is computed elsewhere and arrives as plain points. Every point's
     * timestamp must match a candle exactly, and an unmatched one is rejected
     * rather than snapped to the nearest bar, because a line drawn half a bar out
     * of place is worse than one that refuses to draw.
     *
     * Passing an empty array removes every overlay. The whole set is replaced
     * rather than merged, so a call is idempotent and the chart's overlay state is
     * always exactly what was last supplied.
     */
    public setOverlays(overlays: readonly OverlaySpec[]): void {
        this.assertAlive();
        // Resolved before any mutation, so a rejected overlay leaves the chart as
        // it was rather than half-applied.
        const resolved: ResolvedOverlay[] = this.resolveOverlaySpecs(this.resolvedOptions, overlays);
        this.overlaySpecs = [...overlays];
        this.overlays = resolved;
        this.updateViewport();
    }

    /**
     * Validates and aligns overlay specs against the current options.
     *
     * Kept separate from `setOverlays` because the pane count can change under an
     * overlay: shrinking `panes.weights` can leave a supplied overlay naming a
     * pane that no longer exists, and that has to be caught rather than drawn on
     * whichever pane now occupies that index.
     */
    private resolveOverlaySpecs(
        options: ResolvedChartOptions,
        specs: readonly OverlaySpec[],
    ): ResolvedOverlay[] {
        return resolveOverlays(
            specs,
            this.candleTimes,
            (spec: OverlaySpec): Rgba => (
                spec.color === undefined
                    ? options.candlestick.lineColor
                    : parseCssColor(spec.color, `overlay ${spec.id}.color`)
            ),
            (spec: OverlaySpec, cssColor: string): Rgba => (
                parseCssColor(cssColor, `overlay ${spec.id} point color`)
            ),
            options.panes.weights.length,
        );
    }

    /** The overlay ids currently supplied, in the order they were given. */
    public getOverlayIds(): string[] {
        this.assertAlive();
        return this.overlays.map((overlay: ResolvedOverlay): string => overlay.id);
    }

    /**
     * Replaces the chart's price lines.
     *
     * A price line is a horizontal rule at a fixed price, optionally labelled on
     * the price axis and optionally titled at its left end. Like overlays, the whole
     * set is replaced rather than merged, so a call is idempotent, and the set is
     * validated before any of it is applied.
     *
     * Price lines are decorations rather than series: they have no volume, no
     * aggregation, and are not reduced by the pyramid. They are drawn on the UI
     * layer, under the crosshair.
     *
     * When two labels want the same strip of the price gutter, the caller's own
     * annotations win and the axis tick is dropped, because a reader can do without
     * a gridline label and not without the annotation they asked for.
     */
    public setPriceLines(lines: readonly PriceLineSpec[]): void {
        this.assertAlive();
        this.priceLines = resolvePriceLines(lines, (spec, cssColor) => (
            cssColor === undefined
                ? this.resolvedOptions.candlestick.lineColor
                : parseCssColor(cssColor, `price line ${spec.id} colour`)
        ));
        this.emitDecorations();
    }

    /**
     * Removes one price line by id. Returns whether it was there, so a caller can
     * tell a removal that happened from one that did not.
     */
    public removePriceLine(id: string): boolean {
        this.assertAlive();
        const before: number = this.priceLines.length;
        this.priceLines = this.priceLines.filter((line: ResolvedPriceLine): boolean => line.id !== id);
        if (this.priceLines.length === before) return false;
        this.emitDecorations();
        return true;
    }

    /** The price line ids currently drawn, in the order they were given. */
    public getPriceLineIds(): string[] {
        this.assertAlive();
        return this.priceLines.map((line: ResolvedPriceLine): string => line.id);
    }

    /**
     * Replaces the chart's series markers.
     *
     * A marker is an annotation at a `(time, price-ish)` location: above or below a
     * bar, or on its close. Times are snapped to the nearest candle, which is what
     * a marker placed between two bars means, and `getMarkers()` reports the
     * ordinal each one landed on.
     *
     * Markers are dropped entirely below four pixels per bar rather than shrunk. A
     * marker is a fixed number of pixels wide, so a screen full of them at two
     * pixels per bar is a smear, and an unreadable annotation is worse than an
     * absent one — the data is still readable through `getMarkers()`.
     */
    public setMarkers(markers: readonly MarkerSpec[]): void {
        this.assertAlive();
        this.markers = resolveMarkers(markers, this.candleTimes, (cssColor) => (
            cssColor === undefined
                ? this.resolvedOptions.candlestick.lineColor
                : parseCssColor(cssColor, 'marker colour')
        ));
        this.emitDecorations();
    }

    /**
     * The markers currently supplied, with the ordinal each timestamp snapped to
     * and the price each is drawn at.
     *
     * Present whether or not they are visible, so a caller can read positions at a
     * zoom where the markers themselves are suppressed. The price is the live one,
     * recomputed from the bar the marker landed on rather than fixed when
     * `setMarkers` was called, so it moves with a candle that is still updating.
     */
    public getMarkers(): PlacedMarker[] {
        this.assertAlive();
        return this.markersWithPrices();
    }

    /**
     * Replaces the chart's zones.
     *
     * A zone is a fixed price rectangle anchored to one candle and extending
     * right — an order block, a breaker, a fair-value gap, a session range. It is
     * candle-anchored rather than a band between two moving lines, because that is
     * what these are: a zone belongs to a specific bar and does not move with price.
     *
     * Supplying one `color` gives the conventional pairing: a low-alpha fill and a
     * firmer border in the same hue, decoupled so the zone has definition without
     * competing with the candles. Override `fill` or `border` to change either.
     *
     * A zone's `state` is the caller's to decide. When a zone stops mattering is an
     * analytical judgement about their own indicator, so the library renders what it
     * is told: `live` is a filled box with a solid border, and `mitigated` or
     * `invalidated` fade to a faint dashed outline rather than disappearing, so the
     * chart keeps its own history instead of resetting as the session runs.
     *
     * The zone's timestamp must match a candle **exactly**, unlike a marker's. A
     * marker is a point, so off by one bar is invisible; a zone's left edge is a
     * boundary, so snapping would displace the whole zone by a bar and quietly
     * change which bar it claims to be. A timestamp is taken rather than an ordinal
     * because ordinals shift under retention trimming and timestamps do not.
     */
    public setZones(zones: readonly ZoneSpec[]): void {
        this.assertAlive();
        this.zones = resolveZones(
            zones,
            this.candleTimes,
            (index: number): AnchorCandle => {
                const candle: CandleData | null = this.getCandleAt(index);
                return { high: candle?.high ?? 0, low: candle?.low ?? 0, close: candle?.close ?? 0 };
            },
            this.resolvedOptions.candlestick.lineColor,
            (cssColor: string, label: string): Rgba => parseCssColor(cssColor, label),
        );
        this.emitDecorations();
    }

    /**
     * The zone ids currently supplied, in the order they were given.
     *
     * This reports every zone, including any left undrawn because the chart was over
     * its drawing budget, so a caller can tell what is on the chart from what is not
     * rather than inferring it from a missing rectangle.
     */
    public getZoneIds(): string[] {
        this.assertAlive();
        return this.zones.map((zone: PlacedZone): string => zone.id);
    }

    /** Removes every zone. */
    public clearZones(): void {
        this.setZones([]);
    }

    /** Removes every marker. */
    public clearMarkers(): void {
        this.setMarkers([]);
    }

    /**
     * The newest candle's close and whether it closed up, or `null` with no data.
     * This is what the last-price tag is drawn from.
     */
    public getLastPrice(): { price: number; direction: 'up' | 'down' } | null {
        this.assertAlive();
        return this.lastPrice();
    }

    private lastPrice(): { price: number; direction: 'up' | 'down' } | null {
        const candle: CandleData | null = this.getLastCandle();
        if (candle === null || !Number.isFinite(candle.close)) return null;
        return { price: candle.close, direction: candle.close >= candle.open ? 'up' : 'down' };
    }

    private emitDecorations(redraw: boolean = true): void {
        this.emitter.emit('decorations', {
            priceLines: this.priceLines,
            markers: this.markersWithPrices(),
            zones: this.zones,
            lastPrice: this.lastPrice(),
        });
        // Decorations do not affect layout, so this repaints without redoing the
        // viewport work. Called with `false` from `updateViewport`, which is about
        // to redraw anyway.
        if (redraw) this.redraw();
    }

    /**
     * Markers with the price each one is drawn at, read from the bar it snapped to.
     *
     * Recomputed every frame rather than at `setMarkers` time, because a live candle
     * changes the high a marker above it is anchored to, and a marker pinned to a
     * stale high would drift away from the bar it is annotating.
     */
    private markersWithPrices(): PlacedMarker[] {
        if (this.markers.length === 0) return [];
        return this.markers.map((marker: ResolvedMarker): PlacedMarker => {
            const candle: CandleData | null = this.getCandleAt(marker.index);
            return {
                ...marker,
                price: candle === null
                    ? Number.NaN
                    : markerAnchorPrice(candle, marker.position),
            };
        });
    }

    /**
     * How many panes the chart has. Always at least 1, the price pane, and equal
     * to the length of `panes.weights`.
     */
    public getPaneCount(): number {
        this.assertAlive();
        return this.resolvedOptions.panes.weights.length;
    }

    /**
     * The price range the price pane is currently showing, low first.
     *
     * Prices, not scale-space values, whatever the scale is — this is the API a
     * caller reads to display the current range or to hand the same range to
     * another chart.
     */
    public getPriceRange(): [number, number] {
        this.assertAlive();
        const rect: PlotRect = this.pricePaneRect();
        if (rect.height <= 0 || this.scaleY === 0) {
            const last: CandleData | null = this.getLastCandle();
            const price: number = last === null ? 0 : last.close;
            return [price, price];
        }
        // Both ends of the pane, converted back out of scale space.
        //
        // Through `paneValueAt`, like `getPaneValueRange` and the axis renderer, rather
        // than through `offsetY` directly. This used to read `fromScaleSpace(offsetY)`
        // and `fromScaleSpace(offsetY + height * scaleY)`, which treats `offsetY` as a
        // scale-space value — but `offsetY` is the *pixel* at which scale-space zero
        // sits, and the transform is `y = offsetY + v * scaleY`. The two readings differ
        // by a factor of `scaleY` in the span and disagree outright on the position, so
        // a pane showing 106.6 to 111.6 reported -56732 to 13568, and a range set with
        // `setPriceRange([100, 200])` read back as -2184 to 1156. Nothing caught it
        // because no test called this: the vertical public API had none at all, while
        // the horizontal one it mirrors has had coverage for several phases.
        const transform: VerticalTransform = { scaleY: this.scaleY, offsetY: this.offsetY };
        const atTop: number = fromScaleSpace(paneValueAt(transform, rect.y), this.priceScale());
        const atBottom: number = fromScaleSpace(
            paneValueAt(transform, rect.y + rect.height),
            this.priceScale(),
        );
        return [Math.min(atTop, atBottom), Math.max(atTop, atBottom)];
    }

    /**
     * Sets the price range the price pane shows, and locks it.
     *
     * Locking is the point: a fit that runs every frame would undo this on the next
     * append. `priceScale.autoScale` goes false, so the range holds until a caller
     * turns it back on or calls `fitPriceRange`.
     */
    public setPriceRange(range: readonly [number, number]): void {
        this.assertAlive();
        if (!Array.isArray(range) || range.length !== 2) {
            throw new Error('MatrixCharts: setPriceRange expects [minimum, maximum].');
        }
        const minimum: number = range[0];
        const maximum: number = range[1];
        if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
            throw new Error('MatrixCharts: setPriceRange expects two finite prices.');
        }
        if (maximum <= minimum) {
            throw new Error(`MatrixCharts: setPriceRange expects a maximum above its minimum, got [${minimum}, ${maximum}].`);
        }
        const scale: PriceScale = this.priceScale();
        if (scale === 'log' && minimum <= 0) {
            throw new Error(`MatrixCharts: a log price scale cannot show a range starting at ${minimum}.`);
        }
        this.adoptLockedPriceRange([minimum, maximum]);
    }

    /**
     * Takes ownership of the price pane's vertical scale at a given range.
     *
     * The one place a price range becomes the locked one, so a caller's
     * `setPriceRange` and a drag of the price axis cannot disagree about what
     * "locked" means — in particular about `autoScale`, which has to go false in
     * *both* option objects. Writing only the resolved copy would let the next
     * unrelated `applyOptions` rebuild the resolved snapshot from the explicit pair
     * and hand the pane back to the auto-scaler, which is the same half-sync that
     * made `options().timeScale.barSpacing` disagree with the bars.
     *
     * It applies the range directly rather than going through `updateViewport`,
     * because a vertical change moves no bar: the viewport update would re-upload
     * the visible candles and re-emit the decorations for a change that touches
     * neither. The lock is still the single source of truth, because `autoScaleY`
     * re-applies this same range on every later frame — this is the fast path into
     * the state that path reads, not a second source of truth beside it.
     */
    private adoptLockedPriceRange(range: readonly [number, number]): void {
        this.lockedPriceRange = [range[0], range[1]];
        this.resolvedOptions.priceScale.autoScale = false;
        this.explicitOptions.priceScale = {
            ...(this.explicitOptions.priceScale ?? {}),
            autoScale: false,
        };
        this.applyPriceRange(range);
        this.refreshCrosshairAfterViewportChange();
        this.redraw();
    }

    /**
     * Unlocks the price pane and lets it fit the visible data again.
     *
     * Separate from `applyOptions({priceScale: {autoScale: true}})` only in
     * spelling: the range is forgotten either way, so the next frame is a fit.
     */
    public fitPriceRange(): void {
        this.assertAlive();
        this.lockedPriceRange = null;
        this.resolvedOptions.priceScale.autoScale = true;
        this.explicitOptions.priceScale = {
            ...(this.explicitOptions.priceScale ?? {}),
            autoScale: true,
        };
        this.updateViewport();
    }

    /**
     * Fits the horizontal axis to every retained candle.
     *
     * Only the horizontal axis: a vertical fit is what the pane already does on
     * every frame, so "fit content" that also touched the vertical would be a way of
     * saying "autoscale" and would silently unlock a pane the caller had locked. A
     * locked price range survives this.
     */
    /**
     * Slot position of a bar, or the bar's own ordinal when the series has no gaps.
     *
     * One function, because every place geometry needs an x — the candle records, the
     * overlay points, the zone and marker edges — needs the same conversion. Five call
     * sites each deciding for themselves is five chances to draw something half a bar
     * off, and on a gapped chart a half-bar error is invisible.
     */
    private slotX(ordinalIndex: number): number {
        return this.slotOffsets === null ? ordinalIndex : slotAtIndex(this.slotOffsets, ordinalIndex);
    }

    /**
     * Recomputes the slot table from the current times.
     *
     * Called when the data changes and when the gap options do, and never on pan or
     * zoom. That is the reason slots are the unit rather than pixels or wall-clock
     * deltas: a per-bar table rebuilt on every wheel tick would cost more than the
     * candle pyramid does, and a table in deltas would make the x transform a
     * function of the viewport instead of of the data.
     *
     * No breaks gets null rather than an identity table, so the common case allocates
     * nothing and takes the exact path that shipped for six phases.
     */
    /**
     * Overlay points with their x in slot space, and on the price pane their value
     * in scale space. Non-price panes are left alone: they stay linear whatever the
     * price pane is set to, and an RSI on a log axis has no reading.
     */
    private slotOverlayPoints(points: Float32Array, stride: 2 | 6): Float32Array {
        const convertValue: boolean = this.priceScale() === 'log';
        if (this.slotOffsets === null && !convertValue) return points;
        const out: Float32Array = new Float32Array(points.length);
        out.set(points);
        const scale: PriceScale = this.priceScale();
        for (let i = 0; i < points.length; i += stride) {
            out[i] = this.slotX(points[i]);
            if (convertValue) out[i + 1] = toScaleSpace(points[i + 1], scale);
        }
        return out;
    }

    private rebuildSlots(): void {
        const gaps = this.resolvedOptions.timeScale.sessionBreaks;
        const times: readonly number[] = this.candleTimes;
        if (!gaps.enabled || times.length < 2) {
            this.slotOffsets = null;
            return;
        }
        const resolved = resolveSessionBreaks(times, {
            mode: gaps.mode,
            maxWhitespaceRatio: gaps.maxWhitespaceRatio,
        });
        const breaks = sizeSessionBreaks(times, resolved);
        if (breaks.length === 0) {
            this.slotOffsets = null;
            return;
        }
        this.slotOffsets = computeSlotOffsets(times, breaks);
    }


    public fitContent(): void {
        this.assertAlive();
        const count: number = this.candlePyramid.candleCount;
        if (count === 0) return;
        // Whatever the current bar spacing, the whole series has to land inside the
        // plot. `clampBarSpacing` applies the configured minimum and maximum, so a
        // series of two bars is not blown up past `maxBarSpacing`.
        const plot: PlotRect = this.viewport.plot;
        const spacing: number = this.clampBarSpacing(plot.width / count);
        this.setBarSpacingLive(spacing);
        this.offsetX = liveEdgeOffsetX(plotRight(this.viewport), this.slotOffsets, count, spacing);
        this.followsLiveEdge = true;
        this.updateViewport();
    }

    /**
     * Returns to the live edge, re-arming the follow that a pan switches off.
     *
     * Separate from setting the range by hand because the latch is the part a
     * caller cannot see: a chart that has been panned keeps the old offset and looks
     * frozen at the new one, and the only way back is this.
     */
    public scrollToRealtime(): void {
        this.assertAlive();
        const count: number = this.candlePyramid.candleCount;
        if (count === 0) return;
        this.offsetX = liveEdgeOffsetX(plotRight(this.viewport), this.slotOffsets, count, this.scaleX);
        this.followsLiveEdge = true;
        this.updateViewport();
    }

    /** Whether the chart is currently following the newest candle. */
    public isAtRealtime(): boolean {
        this.assertAlive();
        return this.followsLiveEdge;
    }

    /**
     * The value range currently shown in a pane, low first, or `null` for a pane
     * that does not exist or has nothing on screen to scale to.
     *
     * Pane 0 reports the price range. Any other pane reports the range of the
     * values drawn in it, which is the range its axis is labelled from, so a
     * caller labelling its own pane is reading the same numbers the chart is
     * drawing rather than recomputing them.
     */
    public getPaneValueRange(pane: number): [number, number] | null {
        this.assertAlive();
        const index: number = Math.trunc(pane);
        if (index < 0 || index >= this.paneLayout.rects.length) return null;
        if (this.paneLayout.rects[index].height <= 0) return null;
        const transform: VerticalTransform = this.paneLayout.transforms[index];
        const rect: PlotRect = this.paneLayout.rects[index];
        const top: number = paneValueAt(transform, rect.y);
        const bottom: number = paneValueAt(transform, rect.y + rect.height);
        return [Math.min(top, bottom), Math.max(top, bottom)];
    }

    /**
     * The value of one overlay at a candle index, or `null` when the overlay does
     * not cover that candle — including the bars before an indicator's warm-up.
     * Read at full resolution, so this is the caller's own value rather than a
     * reduced one.
     */
    public getOverlayValueAt(id: string, index: number): number | null {
        this.assertAlive();
        const overlay = this.overlays.find((entry: ResolvedOverlay): boolean => entry.id === id);
        if (!overlay) return null;
        if (!Number.isInteger(index) || index < 0 || index >= overlay.values.length) return null;
        if (index < overlay.firstIndex || index > overlay.lastIndex) return null;
        return overlay.values[index];
    }

    /** Newest retained candle, or `null` when the chart has no data. */
    public getLastCandle(): CandleData | null {
        this.assertAlive();
        return this.getCandleAt(this.candlePyramid.candleCount - 1);
    }

    /** Screen x of a candle index, measured from the canvas's left edge. */
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
        // `indexAtTime`, not the ordinal-snapping `nearestCandleIndexByTime`. Once a
        // break is in the series those disagree, and the ordinal one is the wrong
        // answer for a caller holding a timestamp: a time inside an overnight gap has
        // no ordinal of its own, and the bar the ordinal search lands on depends on
        // where the gap happens to fall in the count rather than on the clock.
        const index: number = indexAtTime(this.candleTimes, time);
        if (index < 0 || index >= this.candleTimes.length) return null;
        return this.indexToCoordinate(index);
    }

    /** Screen y of a price. */
    public priceToCoordinate(price: number): number {
        this.assertAlive();
        return this.offsetY + toScaleSpace(price, this.priceScale()) * this.scaleY;
    }

    /**
     * Price at a screen y on the price pane, honouring the scale and the inversion.
     *
     * The inverse of `priceToCoordinate`. A y outside the pane is still converted
     * rather than clamped: a crosshair dragged above the chart has a price, and it
     * is a real one.
     */
    public coordinateToPrice(coordinateY: number): number {
        this.assertAlive();
        return fromScaleSpace((coordinateY - this.offsetY) / this.scaleY, this.priceScale());
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
        this.rebuildSlots();
        this.followsLiveEdge = true;

        if (preserveViewport && retainedLength > 0 && previousCount > 0) {
            this.scaleX = previousScale;
            if (previousFollowing) {
                this.offsetX = liveEdgeOffsetX(
                    plotRight(this.viewport),
                    this.slotOffsets,
                    retainedLength,
                    this.scaleX,
                );
                this.followsLiveEdge = true;
            } else if (anchorTime !== null) {
                const retainedIndex: number = this.findNearestDataIndex(candles, retainedStart, anchorTime);
                // The anchor is a *slot*, not an ordinal. Using the ordinal here slides
                // the pinned bar sideways by the total width of every break before it,
                // so a reload that added one overnight gap would visibly move the chart
                // under a pointer that never moved.
                this.offsetX = anchorScreenX - this.slotX(retainedIndex) * this.scaleX;
                this.followsLiveEdge = false;
            }
        } else if (retainedLength === 0) {
            this.offsetX = 0;
            // Through the setter, like every other place the scale moves. A bare
            // assignment here left `options().timeScale.barSpacing` reporting the
            // spacing the chart was *constructed* with while the chart sat at 1, and
            // the next `setData` put it at the default instead — so a readout bound
            // to the option disagreed with the bars on every load. See the reset
            // below; this is the same defect on the empty series.
            this.setBarSpacingLive(1);
        } else {
            // This is the reset `setData` performs, and it goes through the setter for
            // the same reason. Assigning `scaleX` directly meant the resolved and
            // explicit options kept the construction-time bar spacing while the chart
            // rendered at the default: a chart built with `barSpacing: 12` reported 12
            // and drew 14. A zoom readout lies about zoom level by 17%, and a toolbar
            // button that scales the *reported* spacing inherits the error on its very
            // first press, before any zoom has happened to correct it.
            this.setBarSpacingLive(DEFAULT_CANDLE_SPACING_PX);
            this.offsetX = liveEdgeOffsetX(
                plotRight(this.viewport),
                this.slotOffsets,
                retainedLength,
                this.scaleX,
            );
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
            this.slotOffsets,
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
        // A slot rather than an ordinal. The shader transform is
        // `x * scaleX + offsetX`, which is affine in whatever it is handed, so a
        // slot makes the series respect the breaks with no new uniform, no second
        // program and no branch. On an unbroken series a slot *is* the ordinal.
        target[offset + CANDLE_X] = this.slotX(ordinalIndex);
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
            this.rebuildSlots();
            if (this.followsLiveEdge) {
                this.offsetX = liveEdgeOffsetX(
                    plotRight(this.viewport),
                    this.slotOffsets,
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
                    this.slotOffsets,
                    this.candlePyramid.candleCount,
                    this.scaleX,
                );
            } else {
                // Shifted in slots, not in bars. The first bar of a new session sits
                // more than one slot after its predecessor, so shifting by the bar
                // count leaves the pinned bar half a slot short of where it was - a
                // slow drift, one half-slot per session, that only shows up in a feed
                // left running across a close. — a slow drift,
            // one half-slot per session, that only shows up in a feed left running
            // across a close.
                this.offsetX -= this.scaleX * (
                    slotAtIndex(this.slotOffsets, this.candleTimes.length - 1)
                    - slotAtIndex(this.slotOffsets, firstNewIndex - 1)
                );
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
    /**
     * The scale the price pane is drawn on.
     *
     * A property of the price pane alone: a pane holding something that is not a
     * price stays linear, because a log axis has no reading for a bounded oscillator
     * and a tradable increment means nothing on one.
     */
    private priceScale(): PriceScale {
        return this.resolvedOptions.priceScale.mode;
    }

    private autoScaleY(): void {
        // Locked panes keep whatever range they were given. This is the condition the
        // option exists to introduce, and it is why the fit is a method rather than
        // inlined into the viewport update: a fit that runs unconditionally every
        // frame cannot be skipped, and therefore cannot be locked.
        if (!this.resolvedOptions.priceScale.autoScale && this.lockedPriceRange !== null) {
            this.applyPriceRange(this.lockedPriceRange);
            return;
        }
        if (this.displayedCandles.length === 0) return;

        // Fitted to the price pane rather than the whole plot, so a pane below it
        // does not squash the candles. With one pane the two are the same rect and
        // this is the behaviour that shipped before panes existed.
        const pricePane: PlotRect = this.pricePaneRect();
        const scale: PriceScale = this.priceScale();

        let maxHigh = Number.NEGATIVE_INFINITY;
        let minLow = Number.POSITIVE_INFINITY;
        const count: number = this.displayedCandles.length / CANDLE_STRIDE;
        for (let i: number = 0; i < count; i++) {
            const offset: number = i * CANDLE_STRIDE;
            maxHigh = Math.max(maxHigh, this.displayedCandles[offset + CANDLE_HIGH]);
            minLow = Math.min(minLow, this.displayedCandles[offset + CANDLE_LOW]);
        }

        // A log axis has no position for a zero or negative price, so those bars are
        // excluded from the fit rather than clamped into it. Clamping the fit would
        // put the floor in the range and crush every real price into the top pixel.
        const range: [number, number] | null = representableRange(minLow, maxHigh, scale);
        if (range === null) return;

        // Padding is applied in scale space, so a log pane's headroom is a ratio of
        // log rather than a number of price units. Ten percent of the visible span
        // means the same thing on either axis.
        const low: number = toScaleSpace(range[0], scale);
        const high: number = toScaleSpace(range[1], scale);
        const span: number = high - low;
        const padding: number = span === 0
            ? Math.max(Math.abs(high) * 0.1, 1)
            : span * 0.1;
        const paddedMin = low - padding;
        const paddedMax = high + padding;

        // Fitted to the price pane, so the highest and lowest visible candle land
        // inside the pane rather than inside the canvas.
        //
        // The two offsets below look like a sign slip and are not: they are the
        // same equation solved for each direction. With `scaleY = -magnitude` a
        // value at `v` sits at `y = offsetY - v * magnitude`, so putting the lowest
        // padded value on the pane's bottom edge gives
        // `offsetY = bottom + v * magnitude`. Inverting the axis flips `scaleY`'s
        // sign, and the offset has to flip with it or the transform is not an
        // inverse of itself — which renders an empty chart with an axis reading
        // around minus a hundred, on a series trading at a hundred and six.
        this.applyVerticalFit(paddedMin, paddedMax, pricePane);
    }

    /**
     * Sets the price pane's vertical transform from a padded value range, honouring
     * the inversion. One place, so the fit and the locked range cannot disagree
     * about the sign convention.
     */
    private applyVerticalFit(low: number, high: number, pane: PlotRect): void {
        const span: number = high - low;
        if (!(span > 0)) return;
        const magnitude: number = pane.height / span;
        this.scaleY = this.resolvedOptions.priceScale.inverted ? magnitude : -magnitude;
        this.offsetY = this.resolvedOptions.priceScale.inverted
            ? pane.y - low * magnitude
            : pane.y + pane.height + low * magnitude;
    }

    /** Establishes the pane's transform from a price range, without padding. */
    private applyPriceRange(range: readonly [number, number]): void {
        const scale: PriceScale = this.priceScale();
        this.applyVerticalFit(
            toScaleSpace(range[0], scale),
            toScaleSpace(range[1], scale),
            this.pricePaneRect(),
        );
    }

    /** The price pane's rect: pane 0 of the current layout, or the whole plot. */
    private pricePaneRect(): PlotRect {
        const rects: PlotRect[] = this.paneRects;
        return rects.length > 0 ? rects[PRICE_PANE] : this.viewport.plot;
    }

    /**
     * The layout for the current frame: one rect per declared pane, and a
     * vertical transform for each.
     *
     * Pane 0 keeps the viewport's price scale so the price axis, the candles, and
     * every price-derived coordinate are untouched. Every other pane is fitted to
     * the values actually on screen in it, which is what stops an RSI drawn
     * against the price range from being a flat line along one price level.
     */
    private computePaneLayout(): PaneLayout {
        const options: ResolvedPanes = this.resolvedOptions.panes;
        const rects: PlotRect[] = paneRects(
            this.viewport.plot,
            options.weights,
            options.separatorHeight,
        );
        const transforms: VerticalTransform[] = [];
        const empty: boolean[] = [];

        const logical: LogicalRange = this.displayedLogicalRange();
        for (let index = 0; index < rects.length; index++) {
            if (index === PRICE_PANE) {
                // The price scale lives on the viewport, which the read API and the
                // crosshair already use; the panes table only has to agree with it.
                transforms.push({ scaleY: this.scaleY, offsetY: this.offsetY });
                empty.push(false);
                continue;
            }
            let minimum: number = Number.POSITIVE_INFINITY;
            let maximum: number = Number.NEGATIVE_INFINITY;
            for (const overlay of this.overlays) {
                if (!overlay.visible || overlay.pane !== index) continue;
                const range: [number, number] | null = visibleOverlayRange(
                    overlay.values,
                    overlay.firstIndex,
                    overlay.lastIndex,
                    logical.from,
                    logical.to,
                );
                if (range === null) continue;
                minimum = Math.min(minimum, range[0]);
                maximum = Math.max(maximum, range[1]);
            }
            const hasValues: boolean = minimum <= maximum;
            transforms.push(fitPaneTransform(rects[index], minimum, maximum));
            empty.push(!hasValues);
        }

        return { rects, transforms, empty };
    }

    /**
     * The visible candle range as a half-open interval, computed from the same
     * transform the candles are drawn with. Reading it off the displayed slice
     * would work at full resolution and be wrong at every aggregated level.
     */
    private displayedLogicalRange(): LogicalRange {
        return visibleLogicalRange(this.viewport, this.candlePyramid.candleCount);
    }

    private updateViewport(): void {
        this.cancelScheduledViewportUpdate();
        // Self-heal the backing store before anything reads it, so a container
        // that resized without notifying us still renders at the right size.
        this.syncRendererSize();
        this.flushPendingData();
        this.updateVisibleCandles();
        this.autoScaleY();
        this.paneRects = paneRects(
            this.viewport.plot,
            this.resolvedOptions.panes.weights,
            this.resolvedOptions.panes.separatorHeight,
        );
        this.paneLayout = this.computePaneLayout();
        // Broadcast the spatial update to all subscribed renderers without coupling
        this.emitter.emit('viewport', {
            offsetX: this.offsetX,
            offsetY: this.offsetY,
            scaleX: this.scaleX,
            slots: this.slotOffsets,
            scaleY: this.scaleY,
            plot: this.viewport.plot,
            panes: this.paneLayout,
        });
        this.uploadVisibleCandles();
        // The last-price tag is derived from the newest candle, so it has to follow
        // every append; emitting it here is what makes it track the live edge
        // instead of showing the price as of the last explicit call.
        this.emitDecorations(false);
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

    /**
     * The factor the candle pyramid is currently drawing at, captured while the
     * level is chosen so overlays reduce to the very same buckets. Zero until the
     * first pass, which is harmless because there is nothing to draw then.
     */
    private overlayAggregationFactor: number = 1;

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
            this.overlayAggregationFactor = aggregationFactor;
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

    /**
     * The candle records as the renderer should see them.
     *
     * On a linear axis this is the slice itself, with nothing copied. On a log axis
     * the four price fields are replaced by their logs and the record is otherwise
     * untouched — `CANDLE_X` is an index, `CANDLE_WIDTH` is a pixel count and
     * `CANDLE_VOLUME` is not a price at all, so converting any of them would be a
     * silent corruption rather than a scaling.
     *
     * This is where the whole of log scale lives. The renderer's geometry code is
     * unchanged and knows nothing about scale, because it never receives a price.
     */
    private scaledCandles(): Float32Array {
        if (this.priceScale() === 'linear') return this.displayedCandles;
        const source: Float32Array = this.displayedCandles;
        // Reused across frames: a log chart reallocating a full candle buffer every
        // animation frame is exactly the cost this phase is meant to be avoiding.
        if (this.scaledCandleBuffer.length !== source.length) {
            this.scaledCandleBuffer = new Float32Array(source.length);
        }
        const out: Float32Array = this.scaledCandleBuffer;
        out.set(source);
        const scale: PriceScale = this.priceScale();
        for (let offset = 0; offset < source.length; offset += CANDLE_STRIDE) {
            for (const field of [CANDLE_OPEN, CANDLE_HIGH, CANDLE_LOW, CANDLE_CLOSE]) {
                out[offset + field] = toScaleSpace(source[offset + field], scale);
            }
        }
        return out;
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
            this.dataRenderer.drawCandlesticks(this.scaledCandles(), {
                colors: this.candleColors,
                style,
                wickVisible: this.resolvedOptions.candlestick.wickVisible,
                borderVisible: this.resolvedOptions.candlestick.borderVisible,
                baselinePrice: this.baselinePrice(),
            });
        }
        this.uploadVisibleVolume();
        this.uploadVisibleOverlays();
        this.emitter.emit('data', { times: this.candleTimes });
    }

    /**
     * Uploads every overlay, reduced to the same buckets as the candles.
     *
     * `aggregationFactor` is the factor the candle pyramid is currently drawing at,
     * so an overlay point lands on exactly the same x as the candle it belongs to.
     * Reducing them independently would let the two drift apart as the chart zooms,
     * which reads as the overlay lagging the price rather than as a bug.
     */
    private uploadVisibleOverlays(): void {
        const active = new Set<string>();
        if (this.overlays.length === 0 || this.displayedCandles.length === 0) {
            this.dataRenderer.retainOverlays(active);
            return;
        }
        const factor: number = this.overlayAggregationFactor;
        const sourceCount: number = this.candlePyramid.candleCount;
        for (const overlay of this.overlays) {
            if (!overlay.visible) continue;
            active.add(overlay.id);
            const bucketed = bucketOverlay(
                overlay.values,
                factor,
                sourceCount,
                overlay.firstIndex,
                overlay.lastIndex,
                overlay.pointColors,
            );
            // An overlay on the price pane is measured in prices, so it needs the
            // same conversion the candles got. One on any other pane is left alone:
            // those panes stay linear whatever the price pane is set to.
            // The x goes through the same conversion the candles' did, and both
            // conversions happen in one pass: a stride of 6 interleaves
            // [x, value, r, g, b, a], and converting a colour channel because the
            // stride was misread is silent. An overlay is read against the candle it
            // annotates, so leaving its x in ordinal space puts it half a bar off —
            // invisible until it diverges far enough to look like it lags the price.
            const points: Float32Array = this.slotOverlayPoints(
                bucketed.points,
                bucketed.stride,
            );
            // A pane below the price one has its own scale, so an overlay there is
            // read against its own axis rather than the price axis. Pane 0 passes
            // null and shares the price transform with the candles.
            this.dataRenderer.drawOverlay(
                overlay.id,
                points,
                bucketed.stride,
                overlay.color,
                overlay.pane === PRICE_PANE ? null : this.paneLayout.transforms[overlay.pane],
                overlay.pane,
            );
        }
        this.dataRenderer.retainOverlays(active);
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
        const scale: PriceScale = this.priceScale();
        for (let i = 0; i < count; i++) {
            const offset: number = i * CANDLE_STRIDE;
            points[i * 2] = this.displayedCandles[offset + CANDLE_X];
            points[i * 2 + 1] = toScaleSpace(this.displayedCandles[offset + CANDLE_CLOSE], scale);
        }
        const lineColor = this.resolvedOptions.candlestick.lineColor;
        this.dataRenderer.drawLine(points, lineColor);

        if (style === 'area') {
            // The fill runs to the bottom of the plot, which is the lowest price
            // the axis can show, so the area never invents a scale of its own. On a
            // log axis that floor is the lowest representable price, not zero, and
            // zero has no position to fill down to.
            const plot: PlotRect = this.viewport.plot;
            this.dataRenderer.drawArea(
                points,
                this.resolvedOptions.candlestick.areaFillColor,
                toScaleSpace(
                    fromScaleSpace(coordinateToPrice(this.viewport, plot.y + plot.height), scale),
                    scale,
                ),
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
        const price: number | null = configured !== null
            ? configured
            : (this.displayedCandles.length === 0 ? null : this.displayedCandles[CANDLE_CLOSE]);
        if (price === null) return null;
        // The baseline is compared against the candle records, which are in scale
        // space, so it has to be too. Log is monotonic, so "above the baseline" means
        // the same thing on both sides of the conversion.
        return toScaleSpace(price, this.priceScale());
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
