// src/core/Chart.ts
import type { IRenderer, IOverlayHost } from './IRenderer.js';
// The concrete renderers are reached through `rendererFactory`, not imported here: the
// factory is the single place that decides what a layer is, which is what lets a headless
// test stand one in without this file knowing.
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
import { measureDynamicPriceAxisWidth, mergeOptionPartials, parseCssColor, resolveCandleColors, resolveOptions } from './options.js';
import { createRenderer } from './rendererFactory.js';
import type { IDataRenderer } from './IDataRenderer.js';
import { Canvas2DDataRenderer } from '../renderers/Canvas2DDataRenderer.js';
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
    bucketCentreSlot,
    computeSlotOffsets,
    indexAtTime,
    resolveSessionBreaks,
    sizeSessionBreaksWithScale,
    slotAtIndex,
    totalSlots,
    modalInterval,
} from './sessionScale.js';
import {
    appendOverlayValue,
    bucketOverlay,
    growOverlayValues,
    resolveOverlays,
    trimOverlayStart,
    type OverlayPoint,
    type OverlaySpec,
    type ResolvedOverlay,
} from './overlays.js';
import type {
    ChartClickEvent,
    CrosshairMoveEvent,
    DrawingOrderInteractionEvent,
    Unsubscribe,
    VisibleRangeEvent,
    PaneRangeEvent,
    HitTestResult,
} from './ChartEvents.js';
import type { ChartViewState } from './viewState.js';
import type { LineSeriesHandle, LineSeriesOptions } from './series.js';
import type {
    DrawingPoint,
    DrawingType,
    EditableDrawing,
    DragHandle,
    OrderSide,
    OrderSpec,
    OrderStatus,
    ResolvedOrder,
} from './tradingTools.js';
import {
    canTransitionOrder,
    createDrawingFromGesture,
    createOrderFromDrawing,
    getDrawingHandles,
    validateDrawings,
    type DrawingOrderEvent,
    type DrawingOrderHitResult,
    type DrawPointProjector,
    type DragState,
} from './drawingOrderModel.js';
import { incrementalSlotUpdateWithScale, type SlotTableUpdate } from './incrementalSlots.js';
import type { OverlayPainter, PointerClaimHandler } from './paint.js';
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
    slotToCoordinate,
    isAtLiveEdgeOffset,
    isSameVisibleRange,
    clampOffsetX,
    liveEdgeOffsetX,
    slotForIndex,
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

/**
 * A drawing detached from the chart's own copy.
 *
 * Points are cloned as well as the drawing, because a drawing handed to a caller
 * and kept would otherwise share its `points` array with the live one: `points` is
 * a mutable reference, and a spread copies the reference rather than the array.
 * So does `getDrawings()`, and so does every drawing published to a
 * `subscribeDrawingOrderEvents` subscriber.
 */
function cloneDrawing(drawing: EditableDrawing): EditableDrawing {
    return { ...drawing, points: drawing.points.map((point) => ({ ...point })) };
}

export class Chart {
    private container: HTMLElement;
    private emitter: EventEmitter<ChartEvents> = new EventEmitter();
    private canvasWrapper: HTMLDivElement;
    private dataCanvas!: HTMLCanvasElement;
    private resizeObserver: ResizeObserver;
    
    // Store your active renderers
    private renderers: IRenderer[] = [];
    /**
     * The UI layer, held for the caller's paint callback.
     *
     * Separate from `renderers` because the painter has to reach a method that is
     * not on `IRenderer` — `setOverlayPainter` is specific to the layer that owns a
     * transparent 2D context. Held as a separate field rather than found in the array
     * so the role is explicit, and so a test double that implements `IRenderer` alone
     * is a compile error here instead of a painter that silently does nothing.
     */
    private uiRenderer: (IRenderer & IOverlayHost) | null = null;
    /** Held directly rather than by position, since init order is not paint order. */
    /**
     * The layer that draws the series, held as the contract Chart actually holds with it
     * rather than as the concrete renderer. See `IDataRenderer` for why the ten GPU draw
     * calls need a name of their own.
     */
    private dataRenderer!: IDataRenderer;
    private isDragging: boolean = false;
    private lastPointerX: number = 0;
    private lastPointerY: number = 0;
    private activePointers: Map<number, { x: number; y: number }> = new Map();
    /**
     * The pointer id of a press a caller's claim handler took, or `null`.
     *
     * Kept out of `activePointers` on purpose: that map is what a pan and a pinch are
     * built from, and a claimed press in it would let a second finger start a pinch
     * underneath the caller's own drag.
     */
    private claimedPointerId: number | null = null;
    private pointerClaimHandler: PointerClaimHandler | null = null;
    /** Last reported claim-handler error, so a throwing handler is not reported per press. */
    private lastPointerClaimError: string | null = null;
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
    private paneSeparatorDrag: { index: number; startY: number; startWeights: number[] } | null = null;
    private priceAxisDrag: {
        pane: number;
        pressY: number;
        paneHeight: number;
        baseLow: number;
        baseHigh: number;
    } | null = null;
    private orderDrag: { id: string } | null = null;
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
    private orders: ResolvedOrder[] = [];
    private orderHandlers: Set<(orders: readonly ResolvedOrder[]) => void> = new Set();
    /** Editable drawings with drag handles. */
    private drawings: EditableDrawing[] = [];
    /** Drawing/order interaction event handlers. */
    private drawingOrderHandlers: Set<(event: DrawingOrderInteractionEvent) => void> = new Set();
    /** The drag operation currently in progress. */
    private activeDrag: DragState | null = null;
    /** The drawing type currently being created. */
    private creatingDrawingType: DrawingType | null = null;
    /**
     * The range each pane has been locked to, by pane index. Absent means that pane
     * fits its own data.
     *
     * A map rather than an array because the pane count is not fixed: it changes with
     * `panes.weights`, and an index-keyed array would need resizing on every such
     * change. Entries for indices that no longer exist are pruned when the count drops,
     * so shrinking the layout does not leave a range waiting to reappear if it is grown
     * again.
     *
     * Pane 0's entry is what `setPriceRange` writes and what `autoScaleY` re-applies;
     * every other entry is honoured where that pane's transform is built. The two are
     * the same kind of state in two places only because pane 0's transform lives on the
     * viewport — which the read API and the crosshair already use — while a lower pane's
     * exists only in the pane table.
     */
    private lockedPaneRanges: Map<number, [number, number]> = new Map();
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
    /**
     * Cached `modalInterval(this.candleTimes)`, or null when it must be re-derived.
     *
     * Null means "not yet computed", which is distinct from a computed 0 — a series
     * whose bars all share a timestamp has a real modal interval of 0, and
     * conflating the two would re-derive it on every frame forever, which is the
     * cost this field exists to remove.
     */
    private cachedModalInterval: number | null = null;
    /**
     * The budget scale the current slot table's break widths are under.
     *
     * Only meaningful in `proportional` mode, and only read by the incremental
     * append path. A full rebuild derives the scale from the timestamps and knows
     * it; an incremental append recovers the widths of breaks already in the table
     * by reading the steps between adjacent offsets, and those steps are scaled
     * values. Without carrying the factor forward, each append treats the previous
     * append's capped widths as raw and caps them again, and the gaps decay
     * geometrically until the chart stops showing session breaks at all.
     */
    private slotBreakScale: number = 1;
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
    private crosshairTime: number | null = null;

    private crosshairHandlers: Set<(event: CrosshairMoveEvent) => void> = new Set();
    private clickHandlers: Set<(event: ChartClickEvent) => void> = new Set();
    private visibleRangeHandlers: Set<(event: VisibleRangeEvent) => void> = new Set();
    private paneRangeHandlers: Set<(event: PaneRangeEvent) => void> = new Set();
    /** What each pane was last reported as showing, so the event is silent when it did not move. */
    private lastReportedPaneRanges: Map<number, [number, number]> = new Map();

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
    private scheduledPaneRangeFrame: number | null = null;
    /**
     * A destroyed chart is unusable. Every public method throws a single stable
     * error rather than some throwing internal messages and others quietly
     * serving stale state, which is far harder to diagnose at an integration
     * boundary.
     */
    private destroyed: boolean = false;
    /** A lost WebGL context pauses data uploads until the browser restores it. */
    private dataContextLost: boolean = false;
    /** Guards against a handler re-entering its own event and looping forever. */
    private emittingCrosshair: boolean = false;
    private emittingVisibleRange: boolean = false;
    private emittingPaneRange: boolean = false;

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
        this.dataCanvas = dataCanvas;
        const uiCanvas = this.createLayer(2);

        try {
            // Layer 1: GPU Data. Initialised first because WebGL2 is the hard
            // requirement, so the unsupported case costs one context attempt and
            // no Canvas2D work. Paint order still comes from the z-index.
            //
            // Built through the factory so a headless test can supply a recorder in
            // place of the GPU without Chart knowing, and so this stays the only place
            // that decides what a layer is. The factory constructs; the `init` calls
            // below are Chart's, because handing over the canvas and the emitter is
            // lifecycle and lifecycle is not the factory's to own.
            let dataRenderer = createRenderer('data');
            try {
                dataRenderer.init(dataCanvas, this.emitter);
            } catch (error: unknown) {
                dataRenderer.destroy();
                if (!(error instanceof Error) || error.message !== 'MatrixCharts: WebGL2 is required.') throw error;
                dataRenderer = new Canvas2DDataRenderer();
                dataRenderer.init(dataCanvas, this.emitter);
            }
            this.dataRenderer = dataRenderer;
            this.renderers.push(dataRenderer);

            // Layer 0: Background Grid
            const gridRenderer = createRenderer('grid');
            gridRenderer.init(gridCanvas, this.emitter);
            this.renderers.push(gridRenderer);

            // Layer 2: UI Overlay
            const uiRenderer = createRenderer('ui');
            uiRenderer.init(uiCanvas, this.emitter);
            this.renderers.push(uiRenderer);
            this.uiRenderer = uiRenderer;
        } catch (error) {
            // Release whatever did come up before rethrowing. The wrapper was never
            // attached, so there is nothing in the caller's DOM to clean up.
            for (const renderer of this.renderers) {
                renderer.destroy();
            }
            this.renderers.length = 0;
            throw error;
        }

        this.dataCanvas.addEventListener('webglcontextlost', this.handleDataContextLost);
        this.dataCanvas.addEventListener('webglcontextrestored', this.handleDataContextRestored);

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

    private handleDataContextLost = (event: Event): void => {
        event.preventDefault();
        this.dataContextLost = true;
    };

    private handleDataContextRestored = (): void => {
        if (this.destroyed || !this.dataContextLost) return;

        const previous: IDataRenderer = this.dataRenderer;
        previous.destroy();
        const restored: IDataRenderer = createRenderer('data');
        restored.init(this.dataCanvas, this.emitter);
        const index: number = this.renderers.indexOf(previous);
        if (index >= 0) this.renderers[index] = restored;
        this.dataRenderer = restored;
        this.dataContextLost = false;

        // The retained model is authoritative. Replaying the normal viewport path
        // regenerates candles, overlays, and optional series without retaining a
        // second CPU copy solely for GPU recovery.
        this.emitter.emit('options', this.resolvedOptions);
        this.updateViewport();
    };

    private handleResize(): void {
        this.syncRendererSize();
        this.cancelScheduledViewportUpdate();
        this.updateViewport();
    }

    private lastSizedWidth: number = 0;
    private lastSizedHeight: number = 0;
    private lastSizedRatio: number = 0;

    /**
     * Bounds the view after a **pan gesture** moved it.
     *
     * Called from the drag and the pinch, and from nowhere else. That scoping is the
     * design, twice over.
     *
     * *Not* the zooms. A zoom is anchored on the bar under the pointer, so it cannot
     * throw the view anywhere the user is not already pointing. There is no fling to
     * prevent, and clamping it would pull the anchored bar out from under the cursor —
     * which is the property the interaction harness asserts twice, and which is worth
     * more than the fling the clamp would have prevented.
     *
     * *Not* the data paths either. The bound moves whenever the series does, so clamping
     * in `updateViewport` would pull a chart the caller has taken over sideways every time
     * a bar printed. The user did not move it; the slack around it did. A viewport someone
     * has panned is theirs, and the feed appending is not a reason to move it.
     *
     * The one case that can leave a view genuinely out of bounds — retention trimming
     * under a panned chart — corrects itself on the next gesture.
     */
    private clampView(): void {
        const plot: PlotRect = this.viewport.plot;
        this.offsetX = clampOffsetX(
            this.offsetX,
            plot.x,
            plot.width,
            this.scaleX,
            this.slotOffsets,
            this.candlePyramid.candleCount,
        );
    }

    /**
     * Whether this chart has ever measured a non-zero container.
     *
     * The distinction that `clientWidth || FALLBACK` cannot make on its own: zero
     * before the first measurement is "not ready", and zero afterwards is "collapsed".
     */
    private hasBeenSized(): boolean {
        return this.lastSizedWidth > 0 || this.lastSizedHeight > 0;
    }

    /** Whether the container is right now measuring zero in either axis. */
    private containerIsZero(): boolean {
        return this.canvasWrapper.clientWidth === 0 || this.canvasWrapper.clientHeight === 0;
    }

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

    /**
     * Registers a handler offered every press before the chart decides what the gesture
     * is. Return `true` to take the press.
     *
     * The engine owns the pointer surface — a press in the plot pans, a press in the
     * gutter scales that pane — and that is right for a chart and wrong for a drawing
     * tool. A trend line dragged by its own handle is not a pan, and a tool that cannot
     * say so has to stop the engine's events from reaching it, which means the tool and
     * the chart each hold half of one gesture. The failure is visible: the series slides
     * while a drawing moves, or a drawing moves and the series does not.
     *
     * A claimed press is the caller's from the release down. The chart does not pan, zoom,
     * scale a pane, or drag an order for the rest of the gesture, and it reports no click
     * for it — a press that travelled far enough to be a pan is not also a click, and here
     * the caller is reporting its own gesture through its own means. The crosshair does
     * not track the pointer as a hover while the press is outstanding, because a pointer
     * placing a drawing is not hovering the chart.
     *
     * The claim ends on release, cancel, or lost capture, whichever the browser delivers,
     * and it cannot outlive its gesture: an unended claim would leave the chart unable to
     * pan for the rest of the session, which is why the release path is the first thing
     * `handlePointerEnd` does.
     *
     * `pointerCount` is the number of presses already down, and **excludes a press this
     * handler has already claimed** — a claimed press is deliberately kept out of the set
     * a pinch is built from, so a second finger during a claimed drag cannot become one.
     * A handler that wants to decline a second finger tracks its own outstanding claim
     * and treats the next press as a second.
     *
     * Throwing is reported once per distinct error and the press is **not** claimed, so
     * the chart still pans. A handler that fails must not leave a chart that cannot be
     * moved.
     *
     * Pass `null` to unregister. Dropped on `destroy()`, as every other handler is.
     */
    public setPointerClaimHandler(handler: PointerClaimHandler | null): void {
        this.assertAlive();
        if (handler !== null && typeof handler !== 'function') {
            throw new Error('MatrixCharts: setPointerClaimHandler requires a function or null.');
        }
        this.pointerClaimHandler = handler;
        // A handler replacing another mid-gesture cannot take over a press that is
        // already outstanding, so the outstanding claim is dropped rather than left
        // pointing at a handler the caller has replaced. The chart is then pannable
        // again immediately, which is the safe direction to fail in.
        this.claimedPointerId = null;
    }

    /**
     * Repaints every layer from the state the chart already holds, now.
     *
     * Every layer is cleared and re-rendered, so a painter registered with
     * `setOverlayPainter` is called again — which is the point. A caller whose own model
     * changed, and which the engine knows nothing about, otherwise has no way to get its
     * change on screen: `setOverlayPainter` deliberately emits no frame, so undo, a
     * reload, a deleted drawing and an edited one all leave the last frame standing until
     * a pan, a zoom, or a pointer move happens to repaint. This is what the paint seam's
     * documentation already told callers to call, and it was not reachable.
     *
     * **This repaints, it does not recompute.** The visible candle slice, the vertical fit
     * and the viewport are left exactly as they are, so this is the right call after
     * changing something the chart did not store, and the wrong call after changing
     * something it did — `setData`, `applyOptions`, `setVisibleLogicalRange` and the rest
     * recompute and repaint on their own.
     *
     * Emits no event. Nothing about the chart's state changed, so there is nothing for a
     * subscriber to be told; a caller repainting their own layer is not a viewport
     * change.
     */
    public redraw(): void {
        this.assertAlive();
        // The collapsed-container rule, as everywhere else. Feeding is not skipped on
        // this path — there is none — but painting a frame into a container that is sized
        // and now measuring zero is exactly what the fallback geometry exists to avoid,
        // and the last frame is better than an 800x500 one crammed into a sliver.
        if (this.hasBeenSized() && this.containerIsZero()) return;
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

    /**
     * Hit-tests the native 'MC' brand watermark badge in the bottom-left corner
     * of the plot rect.
     */
    private isWatermarkHit(localX: number, localY: number): boolean {
        if (!this.resolvedOptions.watermark.visible) return false;
        const width = this.canvasWrapper.clientWidth;
        const height = this.canvasWrapper.clientHeight;
        const plot = this.plotRect(width, height);
        if (plot.width < 100 || plot.height < 60) return false;
        const size = 24;
        const padding = 10;
        const x = plot.x + padding;
        const y = plot.y + plot.height - size - padding;
        // Hit box with generous 4px padding for easy clicking
        return localX >= x - 4 && localX <= x + size + 4 && localY >= y - 4 && localY <= y + size + 4;
    }

    private handlePointerDown = (event: PointerEvent): void => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const rect = this.canvasWrapper.getBoundingClientRect();
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        if (this.isWatermarkHit(localX, localY)) {
            if (typeof window !== 'undefined') {
                window.open('https://github.com/matrixcharts/MatrixCharts-Lite', '_blank', 'noopener,noreferrer');
            }
            return;
        }
        // A caller gets first refusal on every press, before the chart decides what the
        // gesture is. This is the only point a drawing tool can say "mine" — every other
        // gesture decision here is already made by the time a press has been recorded.
        if (this.offerPointerClaim(event)) return;

        // Record the press before capturing. Capture is best effort, so a stale
        // pointer id must not stop the chart from tracking press and pan.
        this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        this.pressX = event.clientX;
        this.pressY = event.clientY;
        this.pressButton = event.button;
        this.pressMoved = false;
        this.capturePointer(event.pointerId);

        if (this.activePointers.size === 1) {
            // Three outcomes, not two, and the middle one is the point of this shape.
            //
            // A press in the price pane's gutter owns the vertical scale and a press in
            // the plot pans, and those two are mutually exclusive on purpose: a drag
            // that started on the axis must not also slide the series sideways, because
            // the caller asked for a price span and would silently get a moved one too.
            //
            // A press in a *lower* pane's gutter is the third case and does nothing at
            // all. Falling through to the pan would have been the easy way to write
            // this and it is wrong twice over: dragging beside an RSI or a MACD would
            // slide the series sideways, which is not what a vertical drag should ever
            // do, and it would do it for a pane that has no vertical gesture of its
            // own yet. Sub-pane scaling is not wired up, so the honest answer is that
            // the gesture does not exist there — and the one thing it must never become
            // is a way to reach up and stretch the price chart from the bottom of the
            // screen, which is what treating the whole gutter as the price axis did.
            if (this.isInPriceAxisGutter(event.clientX)) {
                this.priceAxisDrag = null;
                const pane: number | null = this.paneAtClientY(event.clientY);
                if (pane !== null) {
                    this.beginPaneAxisDrag(pane, event.clientY);
                } else {
                    this.isDragging = false;
                }
            } else {
                this.priceAxisDrag = null;
                const rect = this.canvasWrapper.getBoundingClientRect();
                const separatorIndex = this.separatorAtRow(event.clientY - rect.top, 2);
                if (separatorIndex !== null) {
                    this.paneSeparatorDrag = {
                        index: separatorIndex,
                        startY: event.clientY,
                        startWeights: [...this.resolvedOptions.panes.weights]
                    };
                    this.isDragging = true;
                    this.orderDrag = null;
                } else {
                    const hit = this.hitTest(event.clientX - rect.left, event.clientY - rect.top);
                    if (hit?.kind === 'order' && hit.status === 'working') {
                        this.orderDrag = { id: hit.id };
                        this.isDragging = false;
                    } else {
                        this.orderDrag = null;
                        this.isDragging = true;
                        this.lastPointerX = event.clientX;
                        this.lastPointerY = event.clientY;
                    }
                }
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
     * Whether a press at this client x is in the price axis gutter rather than the plot.
     *
     * The gutter is the left strip, `layout.priceAxisWidth` wide, exactly as `plotRect`
     * reserves it. Read from the same option and the same rect, so the hit region and
     * the drawn gutter cannot drift apart — a hit test measuring the canvas centre
     * instead would claim the whole left half of the plot.
     *
     * This is deliberately only the horizontal question. Whether the press is in the
     * *price pane's* rows is asked separately, because the two answers are not the same
     * and conflating them is what made a drag beside a lower pane stretch the price
     * chart.
     */
    private isInPriceAxisGutter(clientX: number): boolean {
        const { priceAxisWidth, priceAxisPosition = 'left' } = this.resolvedOptions.layout;
        if (!(priceAxisWidth > 0)) return false;
        const rect: DOMRect = this.canvasWrapper.getBoundingClientRect();
        const relX = clientX - rect.left;
        if (priceAxisPosition === 'right') {
            return relX >= rect.width - priceAxisWidth && relX <= rect.width;
        }
        if (priceAxisPosition === 'both') {
            return (relX >= 0 && relX < priceAxisWidth) || (relX >= rect.width - priceAxisWidth && relX <= rect.width);
        }
        return relX >= 0 && relX < priceAxisWidth;
    }

    /**
     * Whether a client y falls inside the price pane's own rows.
     *
     * Half-open, `[pane.y, pane.y + pane.height)`, so a press on the pixel below the
     * last row is already outside it. That matters because `paneRects` leaves the
     * `separatorHeight` band between two panes belonging to *neither* — the boundaries
     * are snapped to whole pixels precisely so two panes cannot both claim a separator.
     * A drag that began on the divider is therefore inert, which is the only safe
     * answer for a band that is not part of any pane.
     */
    /**
     * The pane whose rows contain this client y, or `null` when the press is on a
     * divider or outside every pane.
     *
     * Half-open per pane, `[pane.y, pane.y + pane.height)`, so a press on the pixel
     * below a pane's last row is already outside it. That matters because `paneRects`
     * leaves the `separatorHeight` band between two panes belonging to *neither* — the
     * boundaries are snapped to whole pixels precisely so two panes cannot both claim a
     * separator. A drag that begins on the divider is therefore inert, which is the only
     * safe answer for a band that is not part of any pane.
     *
     * This is the routing rule: the gutter is shared by every pane, and the row under the
     * pointer decides which one a vertical drag belongs to. A drag beside a MACD pane
     * scales the MACD pane, and a price pane a hundred rows higher is not involved.
     */
    private paneAtClientY(clientY: number): number | null {
        const rect: DOMRect = this.canvasWrapper.getBoundingClientRect();
        return this.paneAtRow(clientY - rect.top);
    }

    /**
     * The pane whose rows contain this y, or `null` for a divider or outside every pane.
     *
     * Half-open per pane, `[pane.y, pane.y + pane.height)`, so a press on the pixel
     * below a pane's last row is already outside it. That matters because `paneRects`
     * leaves the `separatorHeight` band between two panes belonging to *neither* — the
     * boundaries are snapped to whole pixels precisely so two panes cannot both claim a
     * separator. A drag that begins on the divider is therefore inert, which is the only
     * safe answer for a band that is not part of any pane.
     *
     * The row lookup itself, shared by the drag's routing and by
     * `getPaneAtCoordinate`. Two copies of "which pane is this" is the arrangement that
     * produced every divider bug worth having: the drag would own one rounding rule and
     * the caller's double-click another, and the two would disagree on exactly the
     * pixels nobody tested.
     */
    private separatorAtRow(y: number, slop: number = 0): number | null {
        const rects: PlotRect[] = this.paneRects;
        const separatorHeight: number = this.resolvedOptions.panes.separatorHeight;
        if (!(separatorHeight > 0)) return null;
        for (let i = 0; i < rects.length - 1; i++) {
            const pane = rects[i];
            const sepTop = pane.y + pane.height;
            const sepBottom = sepTop + separatorHeight;
            if (y >= sepTop - slop && y < sepBottom + slop) return i;
        }
        return null;
    }

    private updatePaneSeparatorDrag(clientY: number): void {
        const drag = this.paneSeparatorDrag;
        if (drag === null) return;
        const delta: number = clientY - drag.startY;
        
        const plot: PlotRect = this.viewport.plot;
        const count: number = drag.startWeights.length;
        const separators: number = Math.max(0, count - 1);
        const separatorTotal: number = this.resolvedOptions.panes.separatorHeight * separators;
        const available: number = Math.max(0, plot.height - separatorTotal);
        if (available <= 0) return;
        
        let totalWeight = 0;
        for (let i = 0; i < drag.startWeights.length; i++) {
            totalWeight += drag.startWeights[i];
        }
        
        const heights = drag.startWeights.map(w => (w / totalWeight) * available);
        const minHeight = 20;
        let actualDelta = delta;
        
        if (heights[drag.index] + actualDelta < minHeight) {
            actualDelta = minHeight - heights[drag.index];
        }
        if (heights[drag.index + 1] - actualDelta < minHeight) {
            actualDelta = heights[drag.index + 1] - minHeight;
        }
        
        heights[drag.index] += actualDelta;
        heights[drag.index + 1] -= actualDelta;
        
        const newWeights = heights.map(h => h / available);
        this.resolvedOptions.panes.weights = newWeights;
        this.handleResize();
    }

    private paneAtRow(y: number): number | null {
        const rects: PlotRect[] = this.paneRects;
        for (let index = 0; index < rects.length; index++) {
            const pane: PlotRect = rects[index];
            if (!(pane.height > 0)) continue;
            if (y >= pane.y && y < pane.y + pane.height) return index;
        }
        return null;
    }

    /**
     * The pane at a point, or `null` when the point is on a divider or outside the plot.
     *
     * CSS pixels relative to the container's top-left, like every other coordinate in
     * the read API. `x` is checked against the plot's width so a point off the side of
     * the chart is `null` rather than quietly answered from its y alone, but the gutter
     * and the plot are deliberately treated alike: they share rows, and that is why a
     * drag in the gutter scales the same pane a click in the plot belongs to.
     *
     * This exists so a caller can route a gesture of its own to the right pane. A
     * double-click on an oscillator's axis that means "fit this pane" needs the pane
     * index, and the only way to get one without this is to reimplement `paneRects` in
     * application code — including its `Math.round(weight / total * available)` and its
     * last-pane-takes-the-remainder rule. Those are exactly the details that produce an
     * off-by-one, and freezing them into an integrator's source is how the chart's own
     * routing and the caller's quietly stop agreeing.
     *
     * The x bound is the canvas width, not the plot's: the gutter and the plot are one
     * surface with rows either side, and a caller asking "which pane is this axis in"
     * must get the same answer from x = 4 as from x = 400. That is also what makes the
     * time-axis strip the one region that answers `null` by y alone.
     */
    public getPaneAtCoordinate(x: number, y: number): number | null {
        this.assertAlive();
        const plot: PlotRect = this.viewport.plot;
        if (x < 0 || x > plot.x + plot.width) return null;
        return this.paneAtRow(y);
    }

    /**
     * Begins a vertical drag of one pane's axis, capturing the baseline it is measured
     * against.
     *
     * The baseline is that pane's current range in *scale* space — prices through the
     * price scale for pane 0, the indicator's own values for anything else. Capturing it
     * per pane rather than assuming pane 0 is what lets the same arithmetic serve both,
     * since a linear pane's scale space is its value space and a log pane's is not.
     *
     * A press on a pane with no usable height or no transform yet leaves the drag null,
     * so a degenerate chart is inert rather than throwing on a pointer event.
     */
    private beginPaneAxisDrag(pane: number, clientY: number): void {
        this.priceAxisDrag = null;
        this.isDragging = false;
        const rect: PlotRect | undefined = this.paneRects[pane];
        const transform: VerticalTransform | null = this.paneTransform(pane);
        if (rect === undefined || !(rect.height > 0) || transform === null) return;
        if (transform.scaleY === 0) return;
        const atTop: number = paneValueAt(transform, rect.y);
        const atBottom: number = paneValueAt(transform, rect.y + rect.height);
        this.priceAxisDrag = {
            pane,
            pressY: clientY,
            paneHeight: rect.height,
            baseLow: Math.min(atTop, atBottom),
            baseHigh: Math.max(atTop, atBottom),
        };
    }

    /**
     * Maps the pointer's vertical travel onto a new span for the dragged pane, and locks
     * that pane to it.
     *
     * Dragging *down* expands and dragging *up* compresses, one pane height of travel
     * for a factor of two, measured from the press so the gesture is a function of its
     * endpoints rather than of how many events it took to get there. The scale is applied
     * about the centre of the range, which is the one point the gesture leaves alone — a
     * drag is about the span, and hinging at the centre keeps that true wherever on the
     * axis it was grabbed.
     *
     * The arithmetic is in scale space, so pane 0's log axis compresses by a ratio of
     * log rather than by a difference of price. That is the same reason `autoScaleY`
     * applies its padding there: ten percent of the visible span has to mean the same
     * thing on either axis, or a log pane's headroom would be in currency units. An
     * indicator pane is linear and comes through `paneValueToScale` unchanged.
     */
    private updatePaneAxisDrag(clientY: number): void {
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
        const pane: number = drag.pane;
        const low: number = this.paneScaleToValue(pane, centre - span / 2);
        const high: number = this.paneScaleToValue(pane, centre + span / 2);
        // The clamp above is on the multiplier, so this can still be reached from a
        // range that was already very wide or very narrow. A drag ignores a result it
        // cannot draw rather than throwing: the same contract `setPriceRange` enforces,
        // reached by returning instead, because a pointer move has no caller to report
        // to and throwing here would take the whole gesture down mid-drag.
        if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return;
        if (pane === PRICE_PANE && this.priceScale() === 'log' && low <= 0) return;
        this.adoptLockedPaneRange(pane, [low, high]);
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
            const rect = this.canvasWrapper.getBoundingClientRect();
            const localX = event.clientX - rect.left;
            const localY = event.clientY - rect.top;
            if (this.isWatermarkHit(localX, localY)) {
                this.canvasWrapper.style.cursor = 'pointer';
                this.canvasWrapper.title = 'MatrixCharts-Lite (GitHub)';
            } else if (this.separatorAtRow(localY) !== null) {
                this.canvasWrapper.style.cursor = 'ns-resize';
                this.canvasWrapper.title = '';
                this.clearCrosshair();
            } else {
                this.canvasWrapper.style.cursor = '';
                this.canvasWrapper.title = '';
                this.updateCrosshair(event.clientX, event.clientY);
            }
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
        if (this.paneSeparatorDrag !== null) {
            this.updatePaneSeparatorDrag(event.clientY);
            return;
        }
        // After the pinch branch, so two pointers always mean pinch. A press on the
        // axis is a single-pointer gesture and the second finger already dropped it.
        if (this.priceAxisDrag !== null) {
            this.updatePaneAxisDrag(event.clientY);
            return;
        }
        if (this.orderDrag !== null) {
            const rect = this.canvasWrapper.getBoundingClientRect();
            const price = this.coordinateToPrice(event.clientY - rect.top);
            this.orders = this.orders.map((order) => order.id === this.orderDrag?.id ? { ...order, price } : order);
            this.emitDecorations();
            this.emitOrders();
            return;
        }
        if (!this.isDragging) return;

        const deltaX: number = event.clientX - this.lastPointerX;
        const deltaY: number = event.clientY - this.lastPointerY;
        this.lastPointerX = event.clientX;
        this.lastPointerY = event.clientY;
        this.offsetX += deltaX;
        this.panPricePane(deltaY);
        // Bounded before the latch is read, so `followsLiveEdge` describes where the
        // view actually ended up rather than where an unbounded drag would have put it.
        this.clampView();
        this.followsLiveEdge = this.isAtLiveEdge();
        this.updateViewport();
    };

    /** Translates the price range with a plot drag, preserving its span. */
    private panPricePane(deltaY: number): void {
        if (deltaY === 0) return;
        if (!(this.resolvedOptions.layout.priceAxisWidth > 0)) return;
        const rect: PlotRect = this.pricePaneRect();
        const transform: VerticalTransform | null = this.paneTransform(PRICE_PANE);
        if (transform === null || !(rect.height > 0) || transform.scaleY === 0) return;

        const top: number = paneValueAt(transform, rect.y);
        const bottom: number = paneValueAt(transform, rect.y + rect.height);
        // Screen Y grows downward while price grows upward. Negating the pixel
        // delta makes the drawn series follow the pointer: dragging up moves a
        // fixed price up on screen instead of reversing the gesture.
        const shift: number = -deltaY / transform.scaleY;
        const low: number = this.paneScaleToValue(PRICE_PANE, Math.min(top, bottom) + shift);
        const high: number = this.paneScaleToValue(PRICE_PANE, Math.max(top, bottom) + shift);
        if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return;
        if (this.priceScale() === 'log' && low <= 0) return;
        this.adoptLockedPaneRange(PRICE_PANE, [low, high]);
    }

    private handlePointerEnd = (event: PointerEvent): void => {
        // A claimed press ends here and goes no further. It is not in `activePointers`,
        // so the pan/pinch bookkeeping below has nothing to do, and the crosshair is
        // refreshed exactly as it is after any other release.
        if (this.claimedPointerId === event.pointerId) {
            this.claimedPointerId = null;
            if (event.pointerType === 'mouse') {
                this.updateCrosshair(event.clientX, event.clientY);
            } else {
                this.clearCrosshair();
            }
            return;
        }

        // **Idempotence guard, and not an optimisation.** `handlePointerEnd` is bound to three
        // events — `pointerup`, `pointercancel` and `lostpointercapture` — and in a real
        // browser the last of those fires *after* a completed `pointerup`, because the chart
        // took pointer capture on the way down and the capture is released on the way up.
        // So every pointer release arrives twice, and the second one used to run the whole
        // teardown again.
        //
        // For a library people build their own tools on, this is the highest-severity defect
        // that can ship: a drawing tool draws twice per click, a "place order" button fires
        // twice, and the developer blames this engine rather than their own code. Every click
        // a user makes on the chart arrives at the caller's `subscribeClick` **twice**.
        //
        // It went unnoticed for the life of the library because `lostpointercapture` never fires
        // in the headless harness, which dispatches only what a test names — so 501 passing
        // tests and a real browser disagreed, and the tests were the wrong one. `tests/
        // PointerRelease.test.cjs` now dispatches the capture-lost event explicitly, because a
        // harness gap that hides a bug is a bug in the harness.
        //
        // A pointer the chart is not tracking is a notification about a gesture that has
        // already been dealt with, so it is dropped.
        if (!this.activePointers.has(event.pointerId)) return;

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
            this.paneSeparatorDrag = null;
            this.priceAxisDrag = null;
            this.orderDrag = null;
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

    /**
     * Offers a press to the caller's claim handler, and begins a claimed gesture if it
     * takes it.
     *
     * Returned `true` means the claim was accepted and the chart will not pan, zoom,
     * scale a pane, or drag an order for the rest of this gesture. The press is not
     * recorded in `activePointers` at all, so the whole of `handlePointerMove` and
     * `handlePointerEnd` see a chart with no gesture in progress — which is what keeps
     * a tool from having to remember to un-set something, and what keeps a chart from
     * being left mid-pan when a tool's drag ends.
     *
     * A second finger is deliberately **not** a claim. A claim is for a press a caller
     * recognises as its own; a pinch is two presses arriving at once, and letting a
     * handler claim only one of them produces a half-pan. The caller gets
     * `pointerCount` so it can decline, and the whole-gesture pinch path stays the
     * engine's.
     */
    private offerPointerClaim(event: PointerEvent): boolean {
        const handler = this.pointerClaimHandler;
        if (handler === null) return false;
        let claimed: boolean;
        try {
            claimed = handler({
                clientX: event.clientX,
                clientY: event.clientY,
                button: event.button,
                pointerType: event.pointerType,
                pointerId: event.pointerId,
                /** Presses already down, so a handler can decline to claim a second. */
                pointerCount: this.activePointers.size,
                event,
            });
        } catch (error) {
            // A throwing handler must not leave the chart unable to pan, which would be a
            // far worse failure than the one that was being handled.
            this.reportPointerClaimError(error);
            return false;
        }
        if (!claimed) return false;

        // A claimed press still captures the pointer, so the caller keeps receiving moves
        // and the release even if the pointer leaves the chart. That is best effort in the
        // same way the pan path's capture is, and bubbling still delivers pointerup.
        this.capturePointer(event.pointerId);
        // Deliberately **not** added to `activePointers`. That set is what a pan and a
        // pinch are built from, and a second finger landing during a claimed drag would
        // find two pointers in it and start a pinch underneath the tool. Tracked by id
        // instead, so the only thing the chart knows about a claimed press is that one is
        // outstanding.
        this.claimedPointerId = event.pointerId;
        // A claimed press is in progress, which is what stops the crosshair reading the
        // pointer as a hover over the chart while it is placing a drawing.
        this.pressMoved = true;
        return true;
    }

    /** A drag or pinch is under way, so pointer movement is not hover. */
    private isInteracting(): boolean {
        // The axis drag counts even though it leaves `isDragging` false: it is a
        // gesture in progress, and without this the crosshair would keep tracking
        // the pointer as hover while the price range is being dragged underneath it.
        // A claimed press counts for the same reason: the pointer is driving a caller's
        // gesture, and the crosshair should not read it as a hover over the chart.
        return this.isDragging || this.activePointers.size >= 2 || this.priceAxisDrag !== null
            || this.paneSeparatorDrag !== null || this.claimedPointerId !== null;
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
        // Deliberately not clamped. The anchor is the bar under the pointer, so a zoom
        // cannot move the view somewhere the user is not already pointing — there is no
        // fling to prevent here, and clamping would only pull the anchored bar back out
        // from under the cursor, which is the one thing a zoom must never do.
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
        // A pane that no longer exists cannot hold a range, and a lock left behind for
        // one would silently come back if the layout were grown again. Dropped with the
        // pane rather than kept, so what is locked is always what is on screen.
        const nextPaneCount: number = nextResolved.panes.weights.length;
        if (nextPaneCount !== previous.panes.weights.length) {
            for (const index of Array.from(this.lockedPaneRanges.keys())) {
                if (index >= nextPaneCount) this.lockedPaneRanges.delete(index);
            }
            if (this.resolvedOptions.volume.pane >= nextPaneCount) {
                this.resolvedOptions.volume.pane = 0;
            }
        }

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

    /**
     * Fires when a pane's vertical range changes, at most once per animation frame and
     * not at all for a pane whose range did not change.
     *
     * Covers every path that moves a pane: a drag of the axis gutter, `setPriceRange`,
     * `setPaneRange`, `fitPaneRange`, and the auto-fit itself when a new candle falls
     * outside the range. The last of those matters as much as the first — a readout that
     * only heard about deliberate changes would be wrong the moment a bar printed
     * outside them, and would be wrong in exactly the way this engine has twice been
     * wrong already: a number on screen that the chart is not using.
     */
    public subscribePaneRangeChange(handler: (event: PaneRangeEvent) => void): Unsubscribe {
        this.assertAlive();
        this.paneRangeHandlers.add(handler);
        // Deliver the current state on the next frame, so a readout mounted after the
        // chart is already drawn starts from the truth rather than blank. A component
        // that subscribed and then waited would otherwise show nothing until the first
        // append, which on a quiet instrument is a long time.
        this.schedulePaneRangeChange();
        return () => { this.paneRangeHandlers.delete(handler); };
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
        const scope: { pane: number | null; value: number | null } = this.crosshairPaneScope();
        const payload: ChartEvents['crosshair'] = {
            x: this.crosshairX,
            y: this.crosshairY,
            time: this.crosshairTime,
            candle: this.crosshairCandle,
            pane: scope.pane,
            value: scope.value,
        };
        this.emitter.emit('crosshair', payload);
        if (this.crosshairHandlers.size === 0) return;
        const event: CrosshairMoveEvent = this.crosshairCandle
            ? {
                x: this.crosshairX as number,
                y: this.crosshairY as number,
                index: this.crosshairIndex,
                time: this.crosshairTime as number,
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
        
        let index: number = this.coordinateToNearestIndex(x);
        let candle: CandleData | null = index < 0 ? null : this.getCandleAt(index);
        let snappedX: number;
        let time: number | null = candle ? candle.time : null;

        const slot = this.coordinateToSlot(x);
        const candleCount = this.candlePyramid.candleCount;
        const lastSlot = candleCount > 0 ? slotForIndex(this.slotOffsets, candleCount - 1, candleCount) : -1;
        
        if (slot < -0.5 || (candleCount > 0 && slot > lastSlot + 0.5)) {
            // Out of bounds: snap to the nearest slot instead of clamping to the first/last candle.
            const roundedSlot = Math.round(slot);
            snappedX = slotToCoordinate(this.viewport, roundedSlot);
            index = -1;
            candle = null;

            if (candleCount > 0) {
                // Cached, not derived. This is on the pointer-move path and outside
                // the series, so it runs on every mouse move over the chart's
                // whitespace — deriving the interval here was an O(n log n) sort of
                // the whole retained series per pointer event.
                const interval = this.modalInterval();
                if (interval > 0) {
                    if (roundedSlot > lastSlot) {
                        const lastCandle = this.getCandleAt(candleCount - 1);
                        if (lastCandle) {
                            time = lastCandle.time + (roundedSlot - lastSlot) * interval;
                        }
                    } else if (roundedSlot < 0) {
                        const firstCandle = this.getCandleAt(0);
                        if (firstCandle) {
                            time = firstCandle.time + roundedSlot * interval;
                        }
                    }
                }
            }
        } else {
            // The crosshair snaps to the bar it points at; the price line keeps
            // following the pointer so the price readout tracks the cursor.
            snappedX = this.indexToCoordinate(index);
        }
        if (this.crosshairX === snappedX && this.crosshairY === y && this.crosshairIndex === index) {
            return;
        }
        this.crosshairX = snappedX;
        this.crosshairY = y;
        this.crosshairIndex = index;
        this.crosshairCandle = candle;
        this.crosshairTime = time;
        this.emitCrosshair();
    }

    private clearCrosshair(): void {
        if (this.crosshairX === null && this.crosshairY === null && this.crosshairCandle === null) return;
        this.crosshairX = null;
        this.crosshairY = null;
        this.crosshairIndex = -1;
        this.crosshairCandle = null;
        this.crosshairTime = null;
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
        const { priceAxisWidth, timeAxisHeight, priceAxisPosition = 'left' } = this.resolvedOptions.layout;
        let x = 0;
        let width = cssWidth;
        if (priceAxisPosition === 'right') {
            x = 0;
            width = Math.max(0, cssWidth - priceAxisWidth);
        } else if (priceAxisPosition === 'both') {
            x = priceAxisWidth;
            width = Math.max(0, cssWidth - 2 * priceAxisWidth);
        } else {
            x = priceAxisWidth;
            width = Math.max(0, cssWidth - priceAxisWidth);
        }
        const height: number = Math.max(0, cssHeight - timeAxisHeight);
        return { x, y: 0, width, height };
    }

    /**
     * The region the series is drawn into, in CSS pixels from the container's top left.
     *
     * Not the canvas. The canvas is the canvas plus a price gutter on the left and a time
     * gutter along the bottom, so `x = 0` is inside the price labels rather than at the
     * first bar — and a caller placing a drawing, clamping one to the plot, or hit-testing
     * against the data needs to know where the data starts, not where the element does.
     *
     * Returned as a copy, since a caller holding the live object could otherwise move the
     * plot by writing to it. Zero width or height means the container is collapsed, and
     * the same "not measured yet" caveat as everywhere else applies.
     */
    public getPlotRect(): PlotRect {
        this.assertAlive();
        const plot: PlotRect = this.viewport.plot;
        return { x: plot.x, y: plot.y, width: plot.width, height: plot.height };
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

    /** Captures the user-owned viewport and pane ranges for persistence or linking. */
    public getViewState(): ChartViewState {
        this.assertAlive();
        const paneRanges: Array<{ pane: number; range: readonly [number, number] }> = [];
        for (let pane = 1; pane < this.getPaneCount(); pane++) {
            const range = this.getPaneValueRange(pane);
            if (range !== null) paneRanges.push({ pane, range });
        }
        return {
            logical: this.getVisibleLogicalRange(),
            barSpacing: this.getBarSpacing(),
            priceRange: this.getPriceRange(),
            paneRanges,
            atRealtime: this.isAtRealtime(),
        };
    }

    /** Restores a previously captured viewport and pane state. */
    public setViewState(state: ChartViewState): void {
        this.assertAlive();
        if (!state || !Number.isFinite(state.logical.from) || !Number.isFinite(state.logical.to)) {
            throw new Error('MatrixCharts: setViewState expects a finite logical range.');
        }
        if (!Number.isFinite(state.barSpacing) || state.barSpacing <= 0) {
            throw new Error('MatrixCharts: setViewState expects a positive bar spacing.');
        }
        this.applyOptions({ timeScale: { barSpacing: state.barSpacing } });
        this.setVisibleLogicalRange(state.logical);
        if (state.priceRange[1] > state.priceRange[0]) this.setPriceRange(state.priceRange);
        for (const entry of state.paneRanges) {
            if (entry.pane > 0 && entry.pane < this.getPaneCount() && entry.range[1] > entry.range[0]) {
                this.setPaneRange(entry.pane, entry.range);
            }
        }
        if (state.atRealtime) this.scrollToRealtime();
    }

    /**
     * Places the view on a logical candle range, the counterpart to
     * `getVisibleLogicalRange`.
     *
     * A range in, a view out: both the position and the bar spacing are set, because
     * honouring a range that does not happen to fit at the current spacing is impossible
     * and quietly showing a different range than the one asked for is worse than useless.
     * That makes this a complete view description, so a caller can persist
     * `getVisibleLogicalRange()` and restore it here — the gap that made a saved view
     * unreproducible, since the getter had no counterpart.
     *
     * **A range past the data is honoured, and that is the point.** `from` may be below
     * zero and `to` above the candle count, and the space out there is real: it is drawn,
     * it is hit-testable, and a drawing anchored to it stays put. A tool that projects
     * forward, or a caller laying out a panel with room beside the series, needs somewhere
     * to put that room, and a viewport that cannot be moved is a viewport the caller does
     * not own. Outside the series the index axis continues at one bar per slot, so `to:
     * count + 50` is fifty bar-widths of space past the newest candle.
     *
     * The one thing it will not do is exceed the same bound a drag is held to — half a
     * plot of slack past the data at either end. Two rules that disagreed would mean a
     * view you could ask for and then lose on the first drag, so there is one rule, and
     * this is where to change it. A request beyond it is honoured as far as the bound
     * allows rather than rejected.
     *
     * The range is also limited by `minBarSpacing`/`maxBarSpacing`: a two-bar range in a
     * wide plot cannot be honoured, because bars have a maximum size, and the result is
     * the closest view those limits allow. Exactly as `fitContent` behaves.
     *
     * Throws on a non-finite or empty range, matching `setPriceRange`. A degenerate range
     * is a caller bug, and a silent no-op would look like the chart ignoring the request.
     */
    public setVisibleLogicalRange(range: LogicalRange): void {
        this.assertAlive();
        const { from, to } = range;
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
            throw new Error('MatrixCharts: setVisibleLogicalRange expects two finite indices.');
        }
        if (to <= from) {
            throw new Error(`MatrixCharts: setVisibleLogicalRange expects a "to" above its "from", got {from: ${from}, to: ${to}}.`);
        }
        const count: number = this.candlePyramid.candleCount;
        // Nothing to place a range against, and a collapsed container has no plot to fill.
        if (count === 0) return;
        const plot: PlotRect = this.viewport.plot;
        if (!(plot.width > 0)) return;

        // Slots, not indices, because a break between two of the requested bars is drawn
        // as whitespace and has to be included in the width the range is fitted to. Using
        // indices here would silently squeeze a gapped range to fit the plot.
        //
        // Both edges are placed half a slot inside the bars they frame. That is the same
        // half-bar inset the live edge parks the newest candle with, and it is what makes
        // the range stable to read back: an edge placed exactly on a bar's left edge sits
        // on the boundary the getter's `from` and `to` are defined against, and there
        // float decides which side it falls, so a range asked for as 40..80 came back as
        // 40..81 on a chart with a session break in it.
        const fromLeft: number = slotForIndex(this.slotOffsets, from, count);
        const lastLeft: number = slotForIndex(this.slotOffsets, to - 1, count);
        // Zero only when the request is a single bar, where `plot.width / 0` is Infinity
        // and `clampBarSpacing` turns that into the maximum bar spacing — one bar, as big
        // as a bar is allowed to be, which is the right reading of a one-bar request.
        const next: number = this.clampBarSpacing(plot.width / (lastLeft - fromLeft));
        this.setBarSpacingLive(next);
        this.offsetX = plot.x - (fromLeft + 0.5) * next;
        // Bounded like a drag, so an ask and a gesture cannot disagree about how far the
        // view may go — see the note above on why there is one bound and not two.
        this.clampView();
        this.followsLiveEdge = this.isAtLiveEdge();
        this.updateViewport();
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
     * Records one indicator value against a candle. O(1), whatever the series length.
     *
     * This is the live-feed counterpart to `setOverlays`. That method re-validates
     * every point of every overlay and reallocates a full-length buffer, so feeding it
     * one new value per tick costs a reallocation and a pass over the whole series per
     * tick — on a 10,000-bar chart, more than a frame budget per value. This writes one
     * slot and extends the window.
     *
     * The timestamp must be a real candle's. Snapping to the nearest would let a
     * misaligned indicator look right, which is the same rule `setOverlays` enforces
     * and for the same reason.
     *
     * This does **not** add the candle. A caller receiving a bar calls `appendData`
     * and then this, in that order, and a caller that appends several bars can call
     * this once per bar.
     *
     * @param id    The overlay's id, as supplied to `setOverlays`.
     * @param time  The candle's timestamp.
     * @param value The indicator's value there.
     * @param color Optional CSS colour for this point, overriding the overlay's.
     * @returns The candle ordinal the value was written to, or -1 if it was rejected.
     */
    public appendOverlayValue(
        id: string,
        time: number,
        value: number,
        color?: string,
    ): number {
        this.assertAlive();
        const overlay: ResolvedOverlay | undefined = this.overlays.find(
            (entry: ResolvedOverlay): boolean => entry.id === id,
        );
        if (overlay === undefined) {
            throw new Error(`MatrixCharts: No overlay has id ${JSON.stringify(id)}.`);
        }
        const ordinal: number = this.overlayOrdinalFor(overlay, time);
        if (ordinal < 0) return -1;
        let rgba: Rgba | undefined;
        if (color !== undefined) {
            rgba = parseCssColor(color, '');
        }
        appendOverlayValue(overlay, ordinal, value, rgba);
        this.updateViewport();
        return ordinal;
    }

    /**
     * Records many indicator values at once, with one viewport update.
     *
     * `appendOverlayValue` recomputes the viewport per call, which is the right shape
     * for a live feed — one new bar, one new value — and the wrong shape for a catch-up
     * after a reconnect or a replay, where a thousand bars arrive in one tick. Doing it
     * per value there is a thousand full viewport recomputations to reach one frame.
     *
     * The window is extended from the first value to the last, so a series with a gap
     * in the middle is reduced across that gap — which is what a `LINE_STRIP` draws
     * anyway, and what `setOverlays` does with the same points. Split the call if the
     * gap matters.
     *
     * @param id     The overlay's id.
     * @param points `{ time, value }` pairs, ascending by time.
     * @param color  Optional CSS colour for every point in the batch.
     * @returns How many values were written.
     */
    public appendOverlayValues(
        id: string,
        points: readonly OverlayPoint[],
        color?: string,
    ): number {
        this.assertAlive();
        const overlay: ResolvedOverlay | undefined = this.overlays.find(
            (entry: ResolvedOverlay): boolean => entry.id === id,
        );
        if (overlay === undefined) {
            throw new Error(`MatrixCharts: No overlay has id ${JSON.stringify(id)}.`);
        }
        if (points.length === 0) return 0;
        const rgba: Rgba | undefined = color !== undefined ? parseCssColor(color, '') : undefined;
        let written = 0;
        for (const point of points) {
            const ordinal: number = this.overlayOrdinalFor(overlay, point.time);
            if (ordinal < 0) continue;
            appendOverlayValue(overlay, ordinal, point.value, rgba);
            written++;
        }
        // Once, not once per value.
        this.updateViewport();
        return written;
    }

    /**
     * Revises a value already recorded against a candle. O(1).
     *
     * The other half of the live feed: a forming candle is revised many times before
     * it closes, and each revision is a new value for the same bar. It is deliberately
     * a separate method rather than an argument to `appendOverlayValue`, because the
     * two have different failure modes — a revision is expected to land on a bar the
     * overlay already covers, and an append is expected to extend the window — and one
     * method that silently does either is one nobody can reason about.
     *
     * @returns The ordinal revised, or -1 if the overlay does not cover that candle.
     */
    public updateOverlayValue(
        id: string,
        time: number,
        value: number,
        color?: string,
    ): number {
        this.assertAlive();
        const overlay: ResolvedOverlay | undefined = this.overlays.find(
            (entry: ResolvedOverlay): boolean => entry.id === id,
        );
        if (overlay === undefined) {
            throw new Error(`MatrixCharts: No overlay has id ${JSON.stringify(id)}.`);
        }
        const ordinal: number = this.overlayOrdinalFor(overlay, time);
        if (ordinal < 0) return -1;
        if (ordinal < overlay.firstIndex || ordinal > overlay.lastIndex) {
            // Not covered. Writing it anyway would extend the window across a gap the
            // indicator never produced a value for, and the line would be drawn through
            // a stretch the caller has said nothing about.
            return -1;
        }
        if (color !== undefined) {
            if (overlay.pointColors === null) {
                overlay.pointColors = new Float32Array(overlay.values.length * 4);
            }
            overlay.pointColors.set(parseCssColor(color, ''), ordinal * 4);
        }
        growOverlayValues(overlay, ordinal + 1);
        overlay.values[ordinal] = value;
        this.updateViewport();
        return ordinal;
    }

    /**
     * The ordinal a timestamp names, or -1.
     *
     * An exact match only, for the same reason `resolveOverlays` insists on one: a
     * value landing on a bar the caller did not mean is a defect that looks correct.
     */
    private overlayOrdinalFor(overlay: ResolvedOverlay, time: number): number {
        if (!Number.isFinite(time)) {
            throw new Error(`MatrixCharts: Overlay ${JSON.stringify(overlay.id)} was given a non-finite time.`);
        }
        const count: number = this.candlePyramid.candleCount;
        if (count === 0) return -1;
        const times: readonly number[] = this.candleTimes;
        let low = 0;
        let high = count - 1;
        while (low <= high) {
            const middle = (low + high) >>> 1;
            if (times[middle] === time) return middle;
            if (times[middle] < time) low = middle + 1;
            else high = middle - 1;
        }
        return -1;
    }

    /** Adds a managed line series using the chart's validated overlay pipeline. */
    public addSeries(options: LineSeriesOptions): LineSeriesHandle {
        this.assertAlive();
        if (typeof options.id !== 'string' || options.id.trim().length === 0) {
            throw new Error('MatrixCharts: A series needs a non-empty string id.');
        }
        if (this.overlaySpecs.some((spec: OverlaySpec): boolean => spec.id === options.id)) {
            throw new Error(`MatrixCharts: Series id ${JSON.stringify(options.id)} is already in use.`);
        }
        const initial: OverlaySpec = {
            id: options.id,
            points: [],
            color: options.color,
            pane: options.pane,
            visible: options.visible,
        };
        this.setOverlays([...this.overlaySpecs, initial]);
        let removed: boolean = false;
        const update = (change: (spec: OverlaySpec) => OverlaySpec): void => {
            this.assertAlive();
            if (removed) throw new Error(`MatrixCharts: Series ${JSON.stringify(options.id)} has been removed.`);
            const current: OverlaySpec | undefined = this.overlaySpecs.find(
                (spec: OverlaySpec): boolean => spec.id === options.id,
            );
            if (current === undefined) {
                throw new Error(`MatrixCharts: Series ${JSON.stringify(options.id)} is no longer attached.`);
            }
            this.setOverlays(this.overlaySpecs.map((spec: OverlaySpec): OverlaySpec => (
                spec.id === options.id ? change(spec) : spec
            )));
        };
        return {
            id: options.id,
            setData: (points: readonly OverlayPoint[]): void => update((spec): OverlaySpec => ({ ...spec, points })),
            setVisible: (visible: boolean): void => update((spec): OverlaySpec => ({ ...spec, visible })),
            remove: (): void => {
                if (removed) return;
                this.assertAlive();
                this.setOverlays(this.overlaySpecs.filter((spec: OverlaySpec): boolean => spec.id !== options.id));
                removed = true;
            },
        };
    }

    /** Adds an editable drawing backed by the managed line-series pipeline. */
    public addDrawing(options: LineSeriesOptions & { points?: readonly DrawingPoint[] }): LineSeriesHandle {
        const handle = this.addSeries(options);
        if (options.points !== undefined) handle.setData(options.points);
        return handle;
    }

    /** Replaces working orders shown as interactive price lines. */
    public setOrders(orders: readonly OrderSpec[]): void {
        this.assertAlive();
        const seen = new Set<string>();
        this.orders = orders.map((order): ResolvedOrder => {
            if (typeof order.id !== 'string' || order.id.trim().length === 0 || seen.has(order.id)) {
                throw new Error('MatrixCharts: Order ids must be non-empty and unique.');
            }
            if (order.side !== 'buy' && order.side !== 'sell') throw new Error(`MatrixCharts: Order ${order.id} has an invalid side.`);
            if (!Number.isFinite(order.price) || !Number.isFinite(order.quantity) || order.quantity <= 0) {
                throw new Error(`MatrixCharts: Order ${order.id} has invalid price or quantity.`);
            }
            const status: OrderStatus = order.status ?? 'working';
            if (!['working', 'filled', 'cancelled', 'rejected'].includes(status)) throw new Error(`MatrixCharts: Order ${order.id} has an invalid status.`);
            seen.add(order.id);
            return { ...order, status };
        });
        this.emitDecorations();
        this.emitOrders();
    }

    public getOrders(): ResolvedOrder[] { this.assertAlive(); return this.orders.map((order) => ({ ...order })); }
    /**
     * Moves an order to a new status.
     *
     * The transition is checked, not just the membership. `ORDER_TRANSITIONS`
     * declares `filled`, `cancelled`, and `rejected` terminal, and this method used
     * to validate only that the requested status was one of the four names — so a
     * filled order could be handed back to `working`, and a cancelled one to
     * `filled`. The state machine existed, was tested, and was not consulted from
     * here; the only place it ran was inside `transitionOrder`, which nothing in
     * this class calls.
     *
     * Terminal orders are left alone rather than throwing, because the caller that
     * observes a rejection usually has a stale view of the order and an illegal
     * transition there is a race, not a programming error to crash a trading
     * screen over.
     */
    public updateOrderStatus(id: string, status: OrderStatus): void {
        this.assertAlive();
        if (!['working', 'filled', 'cancelled', 'rejected'].includes(status)) throw new Error(`MatrixCharts: Order ${id} has an invalid status.`);
        const order = this.orders.find((entry) => entry.id === id);
        if (!order) return;
        // Same status is not a transition. A terminal order re-sent its own status
        // is the common case — a feed replaying a snapshot — and must be a no-op
        // rather than being refused as illegal.
        if (order.status === status) return;
        if (!canTransitionOrder(order.status, status)) return;
        order.status = status;
        this.emitDecorations();
        this.emitOrders();
    }
    public subscribeOrders(handler: (orders: readonly ResolvedOrder[]) => void): Unsubscribe {
        this.assertAlive();
        this.orderHandlers.add(handler);
        handler(this.getOrders());
        return () => this.orderHandlers.delete(handler);
    }
    private emitOrders(): void {
        const orders = this.getOrders();
        for (const handler of Array.from(this.orderHandlers)) handler(orders);
    }

    // --- drawings ---------------------------------------------------------------

    /**
     * Replaces all editable drawings.
     *
     * Validated before anything is replaced, so a refused call leaves the existing
     * set exactly as it was. Every other bulk-ingest method on this class already
     * worked that way; this one did not, which meant a drawing with a NaN anchor
     * entered the store and then failed every projection and every hit test
     * invisibly.
     */
    public setDrawings(drawings: readonly EditableDrawing[]): void {
        this.assertAlive();
        this.drawings = validateDrawings(drawings);
        this.emitDrawings();
    }

    /**
     * Returns all editable drawings.
     *
     * Cloned, and so is every drawing handed to a `subscribeDrawingOrderEvents`
     * subscriber. Those two were inconsistent: `getDrawings()` deep-copied each
     * drawing and its points, while the create/select/deselect events passed the
     * live instance out of `this.drawings` by reference. A subscriber could
     * therefore write `drawing.points[0].value = 999` and move a drawing on screen
     * without going through any API, with no `redraw()` and no notification — and
     * a caller holding that object kept it usable after `deleteDrawing`.
     */
    public getDrawings(): EditableDrawing[] {
        this.assertAlive();
        return this.drawings.map(cloneDrawing);
    }

    /** Returns drag handles for a specific drawing. */
    public getDrawingHandles(id: string): DragHandle[] {
        this.assertAlive();
        const drawing = this.drawings.find(d => d.id === id);
        if (!drawing) return [];
        return getDrawingHandles(drawing);
    }

    /** Starts creating a drawing of the given type. Call on pointer down. */
    public beginDrawingCreate(type: DrawingType, point: DrawingPoint): void {
        this.assertAlive();
        this.creatingDrawingType = type;
        this.activeDrag = {
            target: 'create',
            id: '',
            startPoint: point,
            currentPoint: point,
            createStart: point,
        };
    }

    /**
     * Updates the drawing creation drag. Call on pointer move.
     *
     * `assertAlive()` here and in the two below is load-bearing rather than
     * ceremonial. These three mutate state and publish to subscribers, and they
     * were the only public drawing methods without the guard. On a destroyed chart
     * they still pushed into the drawing array and still invoked live handlers,
     * which is precisely the callback-after-destroy the rest of the API refuses.
     * A gesture is asynchronous by nature — pointer down, moves, up — so a chart
     * torn down mid-gesture lands here by ordinary use, not by misuse.
     */
    public updateDrawingCreate(point: DrawingPoint): void {
        this.assertAlive();
        if (this.activeDrag === null || this.activeDrag.target !== 'create') return;
        if (this.creatingDrawingType === null) return;
        this.activeDrag.currentPoint = point;
    }

    /** Completes the drawing creation. Call on pointer up. */
    public finishDrawingCreate(id: string): EditableDrawing | null {
        this.assertAlive();
        if (this.activeDrag === null || this.activeDrag.target !== 'create') return null;
        if (this.creatingDrawingType === null) return null;
        const drawing = createDrawingFromGesture(
            this.creatingDrawingType,
            this.activeDrag.createStart ?? this.activeDrag.startPoint,
            this.activeDrag.currentPoint,
            id,
        );
        this.creatingDrawingType = null;
        this.activeDrag = null;
        if (drawing) {
            this.drawings.push(drawing);
            this.emitDrawings();
            // Cloned, not the instance just pushed. See `cloneDrawing`.
            this.emitDrawingOrderEvent({ type: 'drawing-create', id, time: Date.now(), drawing: cloneDrawing(drawing) });
        }
        return drawing;
    }

    /** Cancels the drawing creation. */
    public cancelDrawingCreate(): void {
        this.assertAlive();
        this.creatingDrawingType = null;
        this.activeDrag = null;
    }

    /** Selects a drawing by id. */
    public selectDrawing(id: string): void {
        this.assertAlive();
        const drawing = this.drawings.find(d => d.id === id);
        if (!drawing) return;
        drawing.selected = true;
        this.emitDrawings();
        this.emitDrawingOrderEvent({ type: 'drawing-select', id, time: Date.now(), drawing: cloneDrawing(drawing) });
    }

    /** Deselects all drawings. */
    public deselectAllDrawings(): void {
        this.assertAlive();
        for (const drawing of this.drawings) {
            if (drawing.selected) {
                drawing.selected = false;
                this.emitDrawingOrderEvent({ type: 'drawing-deselect', id: drawing.id, time: Date.now(), drawing: cloneDrawing(drawing) });
            }
        }
        this.emitDrawings();
    }

    /** Deletes a drawing by id. */
    public deleteDrawing(id: string): boolean {
        this.assertAlive();
        const index = this.drawings.findIndex(d => d.id === id);
        if (index < 0) return false;
        this.drawings.splice(index, 1);
        this.emitDrawings();
        this.emitDrawingOrderEvent({ type: 'drawing-delete', id, time: Date.now() });
        return true;
    }

    /** Creates an order from a horizontal-line or trend-line drawing. */
    public createOrderFromDrawing(drawingId: string, side: OrderSide, orderId: string, quantity: number = 1): boolean {
        this.assertAlive();
        const drawing = this.drawings.find(d => d.id === drawingId);
        if (!drawing) return false;
        const order = createOrderFromDrawing(drawing, side, orderId, quantity);
        if (!order) return false;
        this.setOrders([...this.orders, order]);
        this.emitDrawingOrderEvent({
            type: 'order-create',
            id: orderId,
            time: Date.now(),
            side,
            price: order.price,
            quantity,
            status: 'working',
        });
        return true;
    }

    /** Subscribes to drawing/order interaction events. */
    public subscribeDrawingOrderEvents(handler: (event: DrawingOrderInteractionEvent) => void): Unsubscribe {
        this.assertAlive();
        this.drawingOrderHandlers.add(handler);
        return () => this.drawingOrderHandlers.delete(handler);
    }

    private emitDrawings(): void {
        this.redraw();
    }

    private emitDrawingOrderEvent(event: DrawingOrderEvent): void {
        if (this.drawingOrderHandlers.size === 0) return;
        const payload: DrawingOrderInteractionEvent = {
            type: event.type,
            id: event.id,
            time: event.time,
            detail: event,
        };
        for (const handler of Array.from(this.drawingOrderHandlers)) handler(payload);
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
            priceLines: this.priceLinesWithOrders(),
            markers: this.markersWithPrices(),
            zones: this.zones,
            lastPrice: this.lastPrice(),
        });
        // Decorations do not affect layout, so this repaints without redoing the
        // viewport work. Called with `false` from `updateViewport`, which is about
        // to redraw anyway.
        if (redraw) this.redraw();
    }

    private priceLinesWithOrders(): ResolvedPriceLine[] {
        const orderLines: ResolvedPriceLine[] = this.orders.map((order): ResolvedPriceLine => ({
            id: `order:${order.id}`,
            price: order.price,
            color: parseCssColor(order.color ?? (order.side === 'buy' ? '#1ad98c' : '#f24059'), `order ${order.id} color`),
            lineWidth: order.status === 'working' ? 2 : 1,
            lineStyle: order.status === 'working' ? 'solid' : 'dashed',
            axisLabelVisible: true,
            title: order.label ?? `${order.side} ${order.quantity}`,
            axisLabelColor: null,
        }));
        return [...this.priceLines, ...orderLines];
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
        // Both ends of the pane, converted back out of scale space, through
        // `getPaneValueRange` — the one reader behind every pane's range, including the
        // range event.
        //
        // It used to be spelled out here, and this method used `offsetY` where the
        // transform is `y = offsetY + v * scaleY`, so it read scale-space zero's *pixel*
        // as if it were a scale-space value: a pane showing 106.6 to 111.6 reported
        // -56732 to 13568, and `setPriceRange([100, 200])` read back as -2184 to 1156.
        // A second copy of "what does the price pane show" is how that happened, and the
        // third reader is now the same function rather than another spelling of it.
        const range: [number, number] | null = (rect.height > 0 && this.scaleY !== 0)
            ? this.getPaneValueRange(PRICE_PANE)
            : null;
        if (range !== null) return range;
        // No usable pane: a collapsed plot, or a pane table that has not been built yet.
        const last: CandleData | null = this.getLastCandle();
        const price: number = last === null ? 0 : last.close;
        return [price, price];
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
        this.adoptLockedPaneRange(PRICE_PANE, [minimum, maximum]);
    }

    /**
     * Sets the range a pane shows, and locks that pane to it.
     *
     * The general form of `setPriceRange`, and the one the price axis drag uses for
     * whichever pane the pointer was over. Pane 0's values are prices and go through the
     * price scale, so a log chart rejects a non-positive low; every other pane's values
     * are indicator readings and are taken as they are, because that pane is drawn
     * linear whatever the price pane is set to.
     */
    public setPaneRange(pane: number, range: readonly [number, number]): void {
        this.assertAlive();
        const index: number = this.requirePaneIndex(pane, 'setPaneRange');
        if (!Array.isArray(range) || range.length !== 2) {
            throw new Error('MatrixCharts: setPaneRange expects [minimum, maximum].');
        }
        const minimum: number = range[0];
        const maximum: number = range[1];
        if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
            throw new Error('MatrixCharts: setPaneRange expects two finite values.');
        }
        if (maximum <= minimum) {
            throw new Error(`MatrixCharts: setPaneRange expects a maximum above its minimum, got [${minimum}, ${maximum}].`);
        }
        if (index === PRICE_PANE && this.priceScale() === 'log' && minimum <= 0) {
            throw new Error(`MatrixCharts: a log price scale cannot show a range starting at ${minimum}.`);
        }
        this.adoptLockedPaneRange(index, [minimum, maximum]);
    }

    /** A pane index that exists, or the documented error naming the call that asked. */
    private requirePaneIndex(pane: number, caller: string): number {
        if (!Number.isInteger(pane) || pane < 0 || pane >= this.paneLayout.rects.length) {
            throw new Error(
                `MatrixCharts: ${caller} was given pane ${pane}; this chart has `
                + `${this.paneLayout.rects.length} pane${this.paneLayout.rects.length === 1 ? '' : 's'}.`,
            );
        }
        return pane;
    }

    /**
     * Takes ownership of one pane's vertical scale at a given range.
     *
     * The one place a range becomes a locked one, so a caller's `setPriceRange`, a
     * caller's `setPaneRange` and a drag of the axis cannot disagree about what "locked"
     * means — in particular about `autoScale`, which has to go false in *both* option
     * objects. Writing only the resolved copy would let the next unrelated
     * `applyOptions` rebuild the resolved snapshot from the explicit pair and hand the
     * pane back to the auto-scaler, which is the same half-sync that made
     * `options().timeScale.barSpacing` disagree with the bars.
     *
     * It applies the range and broadcasts the frame rather than going through
     * `updateViewport`, because a vertical change moves no bar: the full path would
     * re-slice the visible candles and re-upload them for a change that touches
     * neither, and this runs on every pointermove of a drag. What it must not skip is
     * the broadcast — see `emitViewportFrame`. The lock is still the single source of
     * truth either way, since the fit re-applies this same range on every later frame;
     * this is the fast path into the state that path reads, not a second source of
     * truth beside it.
     */
    private adoptLockedPaneRange(pane: number, range: readonly [number, number]): void {
        this.lockedPaneRanges.set(pane, [range[0], range[1]]);
        // Only pane 0's lock touches the options, and only pane 0's lock needs to.
        //
        // A lower pane's lives in the map, which `applyOptions` does not rebuild, so it
        // survives a theme change for free. Pane 0's has to go false in *both* option
        // objects, because `applyOptions` rebuilds the resolved snapshot from the
        // explicit pair — writing only the resolved copy would let the next unrelated
        // `applyOptions` hand the price pane back to the auto-scaler, which is the same
        // half-sync that made `options().timeScale.barSpacing` disagree with the bars.
        if (pane === PRICE_PANE) {
            this.resolvedOptions.priceScale.autoScale = false;
            this.explicitOptions.priceScale = {
                ...(this.explicitOptions.priceScale ?? {}),
                autoScale: false,
            };
            // Pane 0's transform is the viewport's, so it has to be moved here. A lower
            // pane's is built in `computePaneLayout` from the lock, which
            // `emitViewportFrame` is about to call — so for those the lock alone is the
            // whole update.
            this.applyPriceRange(range);
        }
        this.emitViewportFrame();
        // The last-price tag and the price lines are positioned from the pane layout,
        // so they move with the broadcast above and are re-emitted for the same reason
        // `updateViewport` re-emits them.
        this.emitDecorations(false);
        this.refreshCrosshairAfterViewportChange();
        this.redraw();
        // Scheduled rather than emitted, because this runs on every pointer move of a
        // drag and `updateViewport` is deliberately not on that path.
        this.schedulePaneRangeChange();
    }

    /**
     * Unlocks the price pane and lets it fit the visible data again.
     *
     * Separate from `applyOptions({priceScale: {autoScale: true}})` only in
     * spelling: the range is forgotten either way, so the next frame is a fit.
     */
    public fitPriceRange(): void {
        this.assertAlive();
        this.fitPaneRange(PRICE_PANE);
    }

    /**
     * Unlocks one pane and lets it fit its own values again.
     *
     * The counterpart to `setPaneRange`, and the only way back from a drag. A pane
     * nobody can un-drag is a pane a single historical spike can flatten for good, which
     * is the reason the gesture exists in the first place.
     */
    public fitPaneRange(pane: number): void {
        this.assertAlive();
        const index: number = this.requirePaneIndex(pane, 'fitPaneRange');
        this.lockedPaneRanges.delete(index);
        // Only pane 0's release touches the options, for the same reason its lock did.
        // Releasing a MACD pane leaves the price pane's auto-scale exactly as it was,
        // which is the whole point of the locks being per pane.
        if (index === PRICE_PANE) {
            this.resolvedOptions.priceScale.autoScale = true;
            this.explicitOptions.priceScale = {
                ...(this.explicitOptions.priceScale ?? {}),
                autoScale: true,
            };
        }
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
        const barBase: number = this.candlePyramid.getLevelBase(0);
        if (this.slotOffsets === null && !convertValue) return points;
        const out: Float32Array = new Float32Array(points.length);
        out.set(points);
        const scale: PriceScale = this.priceScale();
        const factor: number = this.overlayAggregationFactor;
        const sourceCount: number = this.candlePyramid.candleCount;
        for (let i = 0; i < points.length; i += stride) {
            // The same conversion the candles' x went through, from the same **absolute**
            // bucket index, so an overlay lands on the candle it annotates rather than
            // near it. `bucketOverlay` emits absolute indices and the base is supplied
            // here rather than folded in there, so the two cannot disagree about which
            // grid they are on — which after a history trim is a whole bucket of drift.
            out[i] = bucketCentreSlot(
                this.slotOffsets,
                points[i],
                factor,
                sourceCount,
                barBase,
            );
            if (convertValue) out[i + 1] = toScaleSpace(points[i + 1], scale);
        }
        return out;
    }

    private rebuildSlots(): void {
        const gaps = this.resolvedOptions.timeScale.sessionBreaks;
        const times: readonly number[] = this.candleTimes;
        if (!gaps.enabled || times.length < 2) {
            this.slotOffsets = null;
            this.slotBreakScale = 1;
            return;
        }
        const resolved = resolveSessionBreaks(times, {
            thresholdMs: gaps.thresholdMs ?? undefined,
            mode: gaps.mode,
            maxWhitespaceRatio: gaps.maxWhitespaceRatio,
        });
        // `WithScale` rather than the plain form: a full rebuild caps total
        // whitespace just as an incremental append does, so its factor is the
        // starting point for the next append's recovery. Reading the breaks without
        // it and then appending is how the scale used to get applied twice.
        const sized = sizeSessionBreaksWithScale(times, resolved);
        if (sized.breaks.length === 0) {
            this.slotOffsets = null;
            this.slotBreakScale = 1;
            return;
        }
        this.slotOffsets = computeSlotOffsets(times, sized.breaks);
        this.slotBreakScale = sized.scale;
    }


    public fitContent(): void {
        this.assertAlive();
        const count: number = this.candlePyramid.candleCount;
        if (count === 0) return;
        // Whatever the current bar spacing, the whole series has to land inside the
        // plot. `clampBarSpacing` applies the configured minimum and maximum, so a
        // series of two bars is not blown up past `maxBarSpacing`.
        //
        // Divided by the **slot** count, not the bar count. They are the same number
        // until a break exists, and then the slots are strictly more, so dividing by the
        // bar count asks for a spacing wide enough for the bars and forgets the gaps: the
        // series then comes out wider than the plot and the overflow hangs off the left,
        // which is not a scroll the caller can reach. Half a chart is a worse answer than
        // a slightly cramped one, and the error grows with the data — 750 slots of 600
        // bars loses a fifth of the series.
        const plot: PlotRect = this.viewport.plot;
        const slots: number = this.slotOffsets === null ? count : totalSlots(this.slotOffsets);
        const spacing: number = this.clampBarSpacing(plot.width / Math.max(slots, 1));
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
        // Through the pane's own conversion. Pane 0 is drawn on the price scale, so on a
        // log chart its scale-space values are logs and reading them out raw reported
        // `log(100)` where a caller asked for `100` — the same class of mistake as
        // `getPriceRange` made, one level along, and it survived because the pane case was
        // only ever exercised on a linear chart.
        const top: number = this.paneScaleToValue(index, paneValueAt(transform, rect.y));
        const bottom: number = this.paneScaleToValue(
            index,
            paneValueAt(transform, rect.y + rect.height),
        );
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

    /**
     * Fractional slot position at a screen x. Not clamped.
     *
     * The sub-bar precision `coordinateToIndex` deliberately rounds away. A whole index is
     * the right answer to "which candle is under the pointer" and the wrong one to "where
     * in that candle", which is the question a hit-test asks: a trend line grabbed at the
     * left edge of a bar and one grabbed at its right edge are the same point under
     * `coordinateToIndex` and different points here.
     *
     * A **slot**, not a fractional index, and the two stop being interchangeable the moment
     * a break is in the series: "index 20.4" names no position at all, because the distance
     * from bar 20 to bar 21 is not a number of bars. Slot 20.4 is exactly where the pixel
     * is, before or after a break.
     *
     * Not clamped, like `coordinateToIndex`: a caller deciding whether a pointer is inside
     * the plot needs to be able to see that it is not, and a clamped answer cannot say so.
     *
    * `slotToCoordinate` is the public inverse for callers anchoring a drawing between
    * bars or in the extrapolated whitespace beyond the retained series.
     */
    public coordinateToSlot(coordinateX: number): number {
        this.assertAlive();
        return coordinateToSlot(this.viewport, coordinateX);
    }

    /** Screen x of a fractional slot, the inverse of `coordinateToSlot`. */
    public slotToCoordinate(slot: number): number {
        this.assertAlive();
        return slotToCoordinate(this.viewport, slot);
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
     * A data-to-screen projector for drawing geometry, bound to the current view.
     *
     * The engine stores a drawing's anchors as `{ time, value }` and knows how to
     * turn those into pixels, but nothing in the engine composes the two: there was
     * no way to obtain a `toScreen` callback to hand to the drawing model, so the
     * model was unreachable from outside even though the pieces were public. This
     * is that composition, and it is the seam a drawing layer built on top of this
     * engine needs and previously had to reimplement.
     *
     * Returns `null` only when there is nothing to project onto — an empty chart.
     * A timestamp inside an overnight gap projects to the nearer of the two bars
     * bounding it, deliberately: a line drawn across a weekend has a midpoint anchor
     * in the dead air between the sessions, and snapping it to the last bar before
     * the gap is what keeps that line connected to the candles it annotates. The
     * alternative — a fabricated x in the middle of the compressed break, or `null` —
     * draws a line that leans on nothing or cannot be moved at all.
     *
     * @param pane Optional pane index, for geometry anchored in a sub-pane's units.
     */
    /**
     * Returns the currently resolved price axis width in CSS pixels.
     */
    public getPriceAxisWidth(): number {
        this.assertAlive();
        return this.resolvedOptions.layout.priceAxisWidth;
    }

    /**
     * Dynamically measures the required price axis gutter width from actual price digits,
     * decimals, and font metrics.
     */
    public measurePriceAxisWidth(samplePrice?: number): number {
        this.assertAlive();
        const sample = samplePrice ?? (this.lastPrice()?.price ?? 100000);
        return measureDynamicPriceAxisWidth(
            this.resolvedOptions.priceFormat.precision,
            sample,
            this.resolvedOptions.locale,
            this.uiRenderer ? (this.uiRenderer as any).ctx : null,
        );
    }

    /**
     * Re-measures dynamic gutter width and updates layout if changed.
     */
    public updateDynamicPriceAxisWidth(samplePrice?: number): void {
        this.assertAlive();
        if (!this.resolvedOptions.layout.autoPriceAxisWidth) return;
        const width = this.measurePriceAxisWidth(samplePrice);
        if (width !== this.resolvedOptions.layout.priceAxisWidth) {
            this.resolvedOptions.layout.priceAxisWidth = width;
            this.syncRendererSize();
        }
    }

    public drawingProjector(pane: number = PRICE_PANE): DrawPointProjector {
        this.assertAlive();
        const index: number = this.assertPaneExists(pane, 'drawingProjector');
        return (point: DrawingPoint): { x: number; y: number } | null => {
            const x: number | null = this.timeToCoordinateUnchecked(point.time);
            if (x === null) return null;
            const transform: VerticalTransform | null = this.paneTransform(index);
            if (!transform || transform.scaleY === 0) return null;
            const scaled: number = this.paneValueToScale(index, point.value);
            return { x, y: scaled * transform.scaleY + transform.offsetY };
        };
    }

    /**
     * Registers a paint callback for content the engine does not own.
     *
     * This is the engine's one drawing surface. A charting engine draws candles,
     * axes, grids, and the decorations it is told about; it does not draw trend
     * lines, Fibonacci levels, order blocks, or an application's own overlays. Those
     * belong in the application's files — and this is how they reach the screen.
     *
     * The callback runs once per rendered frame on the UI layer, which sits over the
     * candles and under the crosshair. It receives a `PaintContext` carrying the
     * layer's 2D context already scaled to CSS pixels, the plot rect, every pane's
     * rect, and projections in both directions. The crosshair is drawn after the
     * callback returns, so a crosshair stays legible over a filled rectangle without
     * the painter knowing anything about it.
     *
     * Pass `null` to unregister. The callback is dropped on `destroy()` as well, so a
     * painter that closes over a drawing model cannot keep it reachable from a
     * detached canvas.
     *
     * A callback that throws is reported once per distinct error and the frame still
     * completes; the crosshair, the axes, and the candles are unaffected.
     *
     * @param painter The callback, or null to clear.
     */
    public setOverlayPainter(painter: OverlayPainter | null): void {
        this.assertAlive();
        if (painter !== null && typeof painter !== 'function') {
            throw new Error('MatrixCharts: setOverlayPainter requires a function or null.');
        }
        // No frame is emitted here. A painter has no effect on the chart's state, so
        // forcing a redraw would repaint three layers to show something that was
        // already going to be painted on the next frame anyway. A caller that has
        // just changed its own model and wants it on screen now calls `redraw()`.
        this.uiRenderer?.setOverlayPainter(painter);
    }

    /**
     * Reports a claim handler's failure once per distinct error, and does not claim the
     * press.
     *
     * The direction of the fallback is the whole point. A handler that throws on every
     * press would otherwise leave a chart that cannot be panned, scrolled, or zoomed —
     * the caller would have broken the chart completely in trying to add to it, with
     * nothing on screen to say why. Declining instead leaves the chart behaving exactly as
     * it did before the handler was registered.
     */
    private reportPointerClaimError(error: unknown): void {
        const key: string = error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        if (this.lastPointerClaimError === key) return;
        this.lastPointerClaimError = key;
        console.error(
            'MatrixCharts: a pointer claim handler threw; the press was not claimed '
            + 'and the chart behaves as if no handler were registered.',
            error,
        );
    }

    /**
     * Screen-to-data for drawing geometry, matching `drawingProjector`.
     *
     * A y outside the pane is converted rather than rejected, for the same reason
     * `coordinateToPrice` converts one: a crosshair dragged off the top of the
     * chart still has a price, and it is a real one.
     *
     * @param pane Optional pane index, for geometry anchored in a sub-pane's units.
     */
    public drawingUnprojector(pane: number = PRICE_PANE): (x: number, y: number) => DrawingPoint {
        this.assertAlive();
        const index: number = this.assertPaneExists(pane, 'drawingUnprojector');
        return (x: number, y: number): DrawingPoint => {
            const time: number = this.coordinateToTimeUnchecked(x);
            const transform: VerticalTransform | null = this.paneTransform(index);
            if (!transform || transform.scaleY === 0) return { time, value: 0 };
            const scaled: number = paneValueAt(transform, y);
            const value: number = this.paneScaleToValue(index, scaled);
            return { time, value };
        };
    }

    /**
     * Projects a screen point (x, y) back to data coordinates for any pane
     * (Pane 0 = price, Panes 1..N = subpanes with local bounds).
     */
    public toData(x: number, y: number, pane: number = PRICE_PANE): DrawingPoint {
        this.assertAlive();
        return this.drawingUnprojector(pane)(x, y);
    }

    /**
     * Projects a data point (time, value) to screen coordinates for any pane.
     */
    public toScreen(point: DrawingPoint, pane: number = PRICE_PANE): { x: number; y: number } | null {
        this.assertAlive();
        return this.drawingProjector(pane)(point);
    }

    /**
     * Converts a screen y coordinate to a value within the specified pane.
     */
    public coordinateToPaneValue(pane: number, coordinateY: number): number | null {
        this.assertAlive();
        const index: number = this.assertPaneExists(pane, 'coordinateToPaneValue');
        const transform: VerticalTransform | null = this.paneTransform(index);
        if (!transform || transform.scaleY === 0) return null;
        const scaled: number = paneValueAt(transform, coordinateY);
        return this.paneScaleToValue(index, scaled);
    }

    /**
     * Converts a value within the specified pane to a screen y coordinate.
     */
    public paneValueToCoordinate(pane: number, value: number): number | null {
        this.assertAlive();
        const index: number = this.assertPaneExists(pane, 'paneValueToCoordinate');
        const transform: VerticalTransform | null = this.paneTransform(index);
        if (!transform || transform.scaleY === 0) return null;
        const scaled: number = this.paneValueToScale(index, value);
        return scaled * transform.scaleY + transform.offsetY;
    }

    /**
     * Validates a pane index for a geometry helper, and returns it.
     *
     * The same bounds `getPaneValueRange` enforces, reported against the helper that
     * was asked for rather than against whichever one happened to be edited next.
     */
    private assertPaneExists(pane: number, which: string): number {
        if (!Number.isInteger(pane) || pane < 0) {
            throw new Error(`MatrixCharts: ${which} pane must be a non-negative integer; received ${pane}.`);
        }
        const count: number = this.paneLayout.rects.length;
        if (pane >= count) {
            throw new Error(
                `MatrixCharts: ${which} pane ${pane}, but the chart has ${count} `
                + `pane${count === 1 ? '' : 's'}. Panes are created by declaring panes.weights, `
                + 'one entry per pane.',
            );
        }
        return pane;
    }

    /**
     * `timeToCoordinate` without the liveness check, for the projectors above.
     *
     * A projector calls this on every anchor of every hit test, and the
     * `assertAlive()` inside `timeToCoordinate` is a per-anchor branch against a
     * flag the projector is already inside. The projector is guarded once, at the
     * point it is handed out.
     */
    private timeToCoordinateUnchecked(time: number): number | null {
        const index: number = indexAtTime(this.candleTimes, time);
        if (index < 0 || index >= this.candleTimes.length) return null;
        return this.indexToCoordinate(index);
    }

    private coordinateToTimeUnchecked(coordinateX: number): number {
        const index: number = nearestCandleIndex(this.viewport, coordinateX, this.candlePyramid.candleCount);
        if (index < 0) return this.candleTimes[0] ?? 0;
        return this.candleTimes[index];
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

    /** Resolves the nearest engine-owned drawing target at CSS-pixel coordinates. */
    public hitTest(coordinateX: number, coordinateY: number): HitTestResult | null {
        this.assertAlive();
        if (!Number.isFinite(coordinateX) || !Number.isFinite(coordinateY)) return null;
        const plot: PlotRect = this.viewport.plot;
        if (
            coordinateX < plot.x || coordinateX > plot.x + plot.width
            || coordinateY < plot.y || coordinateY > plot.y + plot.height
        ) return null;

        const axisTolerance: number = 6;
        let nearestLine: { line: ResolvedPriceLine; distance: number } | null = null;
        for (const order of this.orders) {
            if (Math.abs(this.priceToCoordinate(order.price) - coordinateY) <= axisTolerance) {
                return { kind: 'order', id: order.id, side: order.side, status: order.status, price: order.price, quantity: order.quantity };
            }
        }
        for (const line of this.priceLines) {
            const distance: number = Math.abs(this.priceToCoordinate(line.price) - coordinateY);
            if (distance <= axisTolerance && (nearestLine === null || distance < nearestLine.distance)) {
                nearestLine = { line, distance };
            }
        }
        if (nearestLine !== null) {
            return { kind: 'priceLine', id: nearestLine.line.id, price: nearestLine.line.price };
        }

        const markers: PlacedMarker[] = this.markersWithPrices();
        let nearestMarker: { marker: PlacedMarker; distance: number } | null = null;
        for (const marker of markers) {
            if (!Number.isFinite(marker.price)) continue;
            const markerX: number = this.indexToCoordinate(marker.index);
            const dx: number = markerX - coordinateX;
            const dy: number = this.priceToCoordinate(marker.price) - coordinateY;
            const distance: number = Math.hypot(dx, dy);
            if (distance <= 10 && (nearestMarker === null || distance < nearestMarker.distance)) {
                nearestMarker = { marker, distance };
            }
        }
        if (nearestMarker !== null) {
            const marker: PlacedMarker = nearestMarker.marker;
            const candle: CandleData | null = this.getCandleAt(marker.index);
            if (candle !== null) {
                return {
                    kind: 'marker',
                    index: marker.index,
                    time: candle.time,
                    price: marker.price,
                };
            }
        }

        for (const zone of this.zones) {
            const left: number = zone.extendLeft
                ? plot.x
                : this.indexToCoordinate(zone.fromIndex) - this.scaleX / 2;
            const right: number = zone.toIndex === null
                ? plot.x + plot.width
                : this.indexToCoordinate(zone.toIndex) + this.scaleX / 2;
            const top: number = this.priceToCoordinate(zone.top);
            const bottom: number = this.priceToCoordinate(zone.bottom);
            if (
                coordinateX >= Math.min(left, right)
                && coordinateX <= Math.max(left, right)
                && coordinateY >= Math.min(top, bottom)
                && coordinateY <= Math.max(top, bottom)
            ) {
                return {
                    kind: 'zone',
                    id: zone.id,
                    fromIndex: zone.fromIndex,
                    toIndex: zone.toIndex,
                    top: zone.top,
                    bottom: zone.bottom,
                };
            }
        }

        const index: number = this.coordinateToNearestIndex(coordinateX);
        const candle: CandleData | null = this.getCandleAt(index);
        if (candle === null) return null;
        const candleX: number = this.indexToCoordinate(index);
        const xTolerance: number = Math.max(this.scaleX / 2, 8);
        const highY: number = this.priceToCoordinate(candle.high);
        const lowY: number = this.priceToCoordinate(candle.low);
        if (
            Math.abs(candleX - coordinateX) <= xTolerance
            && coordinateY >= Math.min(highY, lowY) - axisTolerance
            && coordinateY <= Math.max(highY, lowY) + axisTolerance
        ) {
            return {
                kind: 'candle',
                index,
                time: candle.time,
                candle,
                price: this.coordinateToPrice(coordinateY),
            };
        }
        return null;
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
            this.writeCandleRecord(rawCandles, retainedIndex, candle);
            times[retainedIndex] = candle.time;
        }

        this.candlePyramid.reset(rawCandles);
        this.candleTimes = times;
        this.invalidateModalInterval();
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
        candle: CandleData,
    ): void {
        const offset: number = recordIndex * CANDLE_STRIDE;
        // `CANDLE_X` is left alone. The pyramid assigns ordinals itself, because it has
        // to keep them consistent with the level each bucket belongs to across a trim,
        // and an ordinal supplied from here is a second source of truth for exactly
        // the number a trim would have to rewrite on every bar.
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
                this.writeCandleRecord(rawCandles, index, candle);
                times[index] = candle.time;
            }
            this.candlePyramid.reset(rawCandles);
            this.candleTimes = times;
            this.invalidateModalInterval();
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
            // No ordinal argument: the pyramid owns its own ordinals, so there is no
            // second place for the caller to state one and get it out of step with the
            // level a trim left behind.
            this.candlePyramid.updateLast(
                lastUpdate.open,
                lastUpdate.high,
                lastUpdate.low,
                lastUpdate.close,
                DEFAULT_BODY_WIDTH_WEIGHT,
                candleVolume(lastUpdate),
            );
        }

        const firstNewIndex: number = this.candlePyramid.candleCount;
        const previousLastTime: number = firstNewIndex > 0
            ? this.candleTimes[firstNewIndex - 1]
            : Number.NEGATIVE_INFINITY;
        // The anchor bar's slot under the table as it stands *now*, captured before the
        // append. Afterwards the same ordinal names a different place, because the table
        // has been rebuilt to describe a longer series — so "where was this bar" has to be
        // asked of the old table with the old ordinal, and the answer is what tells us how
        // far the view has to move to keep that bar still.
        const anchorIndex: number = firstNewIndex - 1;
        const anchorSlotBefore: number = anchorIndex >= 0
            ? slotAtIndex(this.slotOffsets, anchorIndex)
            : 0;
        for (let index: number = 0; index < appends.length; index++) {
            const candle: CandleData = appends[index];
            this.candlePyramid.append(
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                DEFAULT_BODY_WIDTH_WEIGHT,
                candleVolume(candle),
            );
            this.candleTimes.push(candle.time);
        }
        // The timestamps are different now, so the cached interval is stale. Only
        // when bars were actually appended: `updateLast` on a forming candle
        // rewrites OHLC and leaves every timestamp alone, and a live feed calls it
        // on every tick.
        if (appends.length > 0) this.invalidateModalInterval();

        const overflow: number = Math.max(0, this.candlePyramid.candleCount - this.maxRetainedCandles);
        if (overflow > 0) {
            this.candlePyramid.trimStart(overflow);
            this.candleTimes.splice(0, overflow);
            // The overlays move left with the candles. They did not used to, and the
            // result was that every overlay on a chart that reached its retention cap
            // was drawn on the wrong bars by exactly the trim count, from the first
            // frame and with no visible symptom: an EMA lagging the price it annotates,
            // reading as a stale indicator rather than as a defect. Nothing else in the
            // engine can catch it, because the values are perfectly valid numbers on
            // perfectly valid ordinals — they are just the wrong ones.
            for (const overlay of this.overlays) {
                trimOverlayStart(overlay, overflow);
            }
        }

        // The slot table is rebuilt here, and this line is the whole of a shipped defect.
        // It ran on `setData`, on `applyOptions` and on the replace branch, and not here,
        // so on a live feed the table went on describing the series as it was *before* the
        // append. Three things read it and all three clamp to its length: the live-edge
        // shift, the visible-window cull, and the axis ticks. A feed that appended its
        // first session break therefore drew the new bars in ordinal space, reported a
        // visible range that stopped short of them, and bunched its last axis label
        // against the edge, with the data sitting in the array the whole time.
        //
        // Two details are load-bearing. It runs *after* the append and the trim, because
        // it reads `candleTimes`. And it runs only when bars were appended, never for a
        // bare `updateLast`: the table is O(n) in the length of the series, and a live
        // feed calls `updateLast` on every tick, so rebuilding a million-bar table at ten
        // hertz to accommodate a price change that moved no timestamp would be a far worse
        // defect than the one being fixed.
        if (appends.length > 0) {
            const gaps = this.resolvedOptions.timeScale.sessionBreaks;
            if (gaps.enabled && this.slotOffsets !== null) {
                const appendedTimes: number[] = appends.map((candle: CandleData): number => candle.time);
                const interval: number = this.modalInterval();
                // The threshold comes from the same resolved policy `rebuildSlots`
                // uses, rather than from a `interval * 3` written here. The two paths
                // were independent sources of one rule, and a caller who set
                // `collapsedSlots` on the full-rebuild path found the incremental
                // path still inserting half a slot — the only way to change it was to
                // edit two files, and the two disagreed the moment either default moved.
                const resolvedGaps = resolveSessionBreaks(this.candleTimes, {
                    thresholdMs: gaps.thresholdMs ?? undefined,
                    mode: gaps.mode,
                    maxWhitespaceRatio: gaps.maxWhitespaceRatio,
                });
                const update: SlotTableUpdate = incrementalSlotUpdateWithScale(
                    this.slotOffsets,
                    previousLastTime,
                    appendedTimes,
                    gaps.mode,
                    resolvedGaps.thresholdMs,
                    resolvedGaps.collapsedSlots,
                    resolvedGaps.maxWhitespaceRatio,
                    interval,
                    overflow,
                    this.slotBreakScale,
                );
                this.slotOffsets = update.offsets;
                this.slotBreakScale = update.scale;
            } else if (gaps.enabled) {
                this.rebuildSlots();
            }
        }

        if (appends.length > 0) {
            if (shouldFollow) {
                // Park the newest bar at the live edge. Recomputed from the table rather
                // than shifted by the width that was added, because the two are only
                // equivalent while the view was already at the edge, and this is the same
                // expression that self-corrects after a resize instead of compounding.
                this.offsetX = liveEdgeOffsetX(
                    plotRight(this.viewport),
                    this.slotOffsets,
                    this.candlePyramid.candleCount,
                    this.scaleX,
                );
            } else if (anchorIndex >= 0) {
                // A panned chart keeps the bar it is looking at where it is, which is the
                // anchor's slot before and after. Measured in bars this is the same number
                // only while bars are adjacent; crossing a break it comes up short by the
                // whole of the gap, so a panned chart saw the bar under the crosshair slide
                // out from under the pointer, by half a session for every close it lived
                // through.
                this.offsetX -= this.scaleX * (
                    slotAtIndex(this.slotOffsets, anchorIndex - overflow) - anchorSlotBefore
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
            this.clampView();
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
        // A locked price pane keeps whatever range it was given. This is the condition
        // the option exists to introduce, and it is why the fit is a method rather than
        // inlined into the viewport update: a fit that runs unconditionally every
        // frame cannot be skipped, and therefore cannot be locked.
        //
        // Pane 0 only. A lower pane's transform is built in `computePaneLayout`, which
        // applies that pane's own lock — the state is per pane, but it is read in two
        // places because pane 0's transform lives on the viewport and a lower pane's
        // does not.
        const locked: [number, number] | undefined = this.lockedPaneRanges.get(PRICE_PANE);
        if (this.paneLockHonoured(PRICE_PANE) && locked !== undefined) {
            this.applyPriceRange(locked);
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
     * A pane's value to the number its affine transform actually operates on.
     *
     * Pane 0 measures price, so it goes through the price scale and a log chart gets a
     * log. Every other pane measures something that is not a price — an RSI, a MACD
     * histogram, volume — and stays linear whatever the price pane is set to, because a
     * bounded oscillator has no reading on a log axis and a tradable increment means
     * nothing on one. That asymmetry is the reason this is a function of the pane index
     * and not a single global conversion: applying the price scale to an indicator pane
     * would be the same category of mistake as fitting an RSI against the price range,
     * which is the thing panes exist to prevent.
     */
    private paneValueToScale(pane: number, value: number): number {
        return pane === PRICE_PANE ? toScaleSpace(value, this.priceScale()) : value;
    }

    /** The inverse of `paneValueToScale`, for reading a range back out. */
    private paneScaleToValue(pane: number, scaled: number): number {
        return pane === PRICE_PANE ? fromScaleSpace(scaled, this.priceScale()) : scaled;
    }

    /**
     * Whether a pane's locked range should be applied rather than a fit.
     *
     * The lock map is authoritative for every pane. `priceScale.autoScale` is an
     * *additional* gate on pane 0 alone, because it is the price scale's option and the
     * price scale is pane 0 — gating a MACD pane on it would mean that stretching a
     * volume pane read as "stop auto-fitting the price chart", which is a different
     * statement from the one the caller made.
     *
     * The gate keeps what it already did for the price pane: a pane with no lock still
     * fits even while `autoScale` is false, so the option is not a way to freeze a pane
     * at a range nobody chose.
     */
    private paneLockHonoured(pane: number): boolean {
        if (!this.lockedPaneRanges.has(pane)) return false;
        return pane !== PRICE_PANE || !this.resolvedOptions.priceScale.autoScale;
    }

    /** The transform a pane is currently drawn with, whichever of the two tables holds it. */
    private paneTransform(pane: number): VerticalTransform | null {
        if (pane === PRICE_PANE) return { scaleY: this.scaleY, offsetY: this.offsetY };
        const transform: VerticalTransform | undefined = this.paneLayout.transforms[pane];
        return transform ?? null;
    }

    /**
     * Which pane the crosshair is over, and what it reads there.
     *
     * Both halves are the renderer's to draw and neither is the renderer's to decide.
     * The pane comes from the same `paneAtRow` the axis drag and
     * `getPaneAtCoordinate` use, and the value goes through that pane's own conversion —
     * a price under pane 0, an oscillator reading everywhere else. Resolving it here
     * rather than downstream is what stops a price appearing on an RSI axis, which is
     * what happened for as long as the readout asked the price pane's transform for a
     * y that lay inside somebody else's pane.
     *
     * `pane` and `value` are `null` together: on a divider there is no pane to read, and
     * a horizontal rule drawn at a y belonging to no pane would be a rule annotating
     * nothing.
     */
    private crosshairPaneScope(): { pane: number | null; value: number | null } {
        const y: number | null = this.crosshairY;
        if (y === null) return { pane: null, value: null };
        const pane: number | null = this.paneAtRow(y);
        if (pane === null) return { pane: null, value: null };
        const transform: VerticalTransform | null = this.paneTransform(pane);
        if (transform === null || transform.scaleY === 0) return { pane, value: null };
        return { pane, value: this.paneScaleToValue(pane, paneValueAt(transform, y)) };
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
            // A locked pane is drawn at the range its owner chose, not at a fit. This is
            // the whole point of letting a lower pane be dragged: one historical spike in
            // a volume or MACD pane would otherwise flatten the recent bars permanently,
            // and there is no other way back from that.
            //
            // Padding is zero, not the fit's ten percent. A fit may add headroom because
            // nobody chose those bounds; a locked range is a statement about exactly
            // which values the pane should show, and quietly widening it by a tenth on
            // each side would make the drag's own arithmetic disagree with the result.
            const locked: [number, number] | undefined = this.lockedPaneRanges.get(index);
            if (this.paneLockHonoured(index) && locked !== undefined) {
                transforms.push(fitPaneTransform(
                    rects[index],
                    this.paneValueToScale(index, locked[0]),
                    this.paneValueToScale(index, locked[1]),
                    0,
                ));
                empty.push(false);
                continue;
            }
            let minimum: number = Number.POSITIVE_INFINITY;
            let maximum: number = Number.NEGATIVE_INFINITY;
            const isVolumePane = this.resolvedOptions.volume.visible && this.resolvedOptions.volume.pane === index;
            if (isVolumePane) {
                minimum = 0;
                const count: number = this.displayedCandles.length / CANDLE_STRIDE;
                for (let i = 0; i < count; i++) {
                    const value: number = this.displayedCandles[i * CANDLE_STRIDE + CANDLE_VOLUME];
                    if (value > maximum) maximum = value;
                }
            }
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

    /**
     * Recomputes the pane table and broadcasts the spatial update.
     *
     * Split out of `updateViewport` because a change that only moves the vertical
     * scale still has to reach the renderers, and the renderers take `scaleY` from
     * this payload and from nowhere else — `redraw` re-renders whatever transform they
     * were last handed. So a path that sets `scaleY` and calls `redraw` without
     * emitting here changes the model and leaves the pixels exactly where they were,
     * which is what `setPriceRange` did: it reported `[100, 200]` while the canvas was
     * byte-for-byte unchanged, and only caught up on the next unrelated pan.
     *
     * One definition of the payload rather than a second copy beside it, because a
     * payload that quietly drifts out of step with the one `updateViewport` sends is the
     * same class of rot this fixes, one level down.
     */
    private emitViewportFrame(): void {
        this.paneRects = paneRects(
            this.viewport.plot,
            this.resolvedOptions.panes.weights,
            this.resolvedOptions.panes.separatorHeight,
        );
        this.paneLayout = this.computePaneLayout();
        this.emitter.emit('viewport', {
            offsetX: this.offsetX,
            offsetY: this.offsetY,
            scaleX: this.scaleX,
            slots: this.slotOffsets,
            scaleY: this.scaleY,
            plot: this.viewport.plot,
            panes: this.paneLayout,
        });
    }

    private updateViewport(): void {
        this.cancelScheduledViewportUpdate();
        // Self-heal the backing store before anything reads it, so a container
        // that resized without notifying us still renders at the right size.
        this.syncRendererSize();
        this.flushPendingData();
        // A container that has been sized and is now zero-sized is *collapsed*, and
        // that is not the same as unsized. The fallback geometry above exists for the
        // first frame on a container the layout has not resolved; laying 800x500 worth
        // of axis into a panel with no height is how a divider drag through zero
        // produces a mangled time axis, which is a frame nobody asked for drawn over a
        // panel that cannot show it.
        //
        // The data is flushed first, so a live feed does not build a backlog behind a
        // collapsed panel, and nothing is cleared, so the last frame stays on the canvas
        // because there is nothing better to put there. The view is left untouched for
        // the same reason the clamp below is not reached: the fallback geometry is not
        // the panel's geometry, and measuring the view against it would move it.
        if (this.hasBeenSized() && this.containerIsZero()) return;
        this.updateVisibleCandles();
        this.autoScaleY();
        this.emitViewportFrame();
        if (this.dataContextLost) return;
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
        // The auto-fit is a vertical change like any other, and on a live feed it is the
        // common one: a candle printing outside the range moves every fitted pane. A
        // readout that only heard about deliberate drags would be stale from the first
        // new high, which is the same permanent lie as a barSpacing readout that reports
        // the construction value.
        this.schedulePaneRangeChange();
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
     */    private scheduleVisibleRangeChange(): void {
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
            atRealtime: this.followsLiveEdge,
        };
        this.emittingVisibleRange = true;
        try {
            for (const handler of Array.from(this.visibleRangeHandlers)) handler(event);
        } finally {
            this.emittingVisibleRange = false;
        }
    }

    /**
     * Queues a vertical-range notification, coalesced to one per animation frame.
     *
     * A drag of the axis fires this on every pointer move, and an append fires it on
     * every flush, so without the frame it would be a stream rather than a signal.
     */
    private schedulePaneRangeChange(): void {
        if (this.paneRangeHandlers.size === 0) return;
        if (this.scheduledPaneRangeFrame !== null) return;
        // A change caused from inside a handler is not re-notified, for the same reason
        // the visible-range event has that guard: a handler that restyles the chart on
        // every notification would otherwise schedule a frame forever.
        if (this.emittingPaneRange) return;
        this.scheduledPaneRangeFrame = requestAnimationFrame(() => {
            this.scheduledPaneRangeFrame = null;
            this.emitPaneRangeChange();
        });
    }

    private cancelScheduledPaneRangeChange(): void {
        if (this.scheduledPaneRangeFrame === null) return;
        cancelAnimationFrame(this.scheduledPaneRangeFrame);
        this.scheduledPaneRangeFrame = null;
    }

    /**
     * Emits one event per pane whose range differs from what was last reported.
     *
     * Deduplicated per pane rather than as a single before/after comparison, because a
     * readout of one oscillator's bounds should not be woken by the price pane's fit
     * moving. A pane that has never been reported is always reported, so the first
     * subscription sees the current state instead of waiting for the next change.
     */
    private emitPaneRangeChange(): void {
        if (this.paneRangeHandlers.size === 0) return;
        if (this.emittingPaneRange) return;
        const changed: PaneRangeEvent[] = [];
        for (let index = 0; index < this.paneLayout.rects.length; index++) {
            const range: [number, number] | null = this.paneRangeOf(index);
            if (range === null) continue;
            const previous: [number, number] | undefined = this.lastReportedPaneRanges.get(index);
            if (previous !== undefined
                && previous[0] === range[0]
                && previous[1] === range[1]
            ) {
                continue;
            }
            this.lastReportedPaneRanges.set(index, [range[0], range[1]]);
            changed.push({ pane: index, range: [range[0], range[1]] });
        }
        if (changed.length === 0) return;
        this.emittingPaneRange = true;
        try {
            for (const handler of Array.from(this.paneRangeHandlers)) {
                for (const event of changed) handler(event);
            }
        } finally {
            this.emittingPaneRange = false;
        }
    }

    /**
     * One pane's current range in its own units, or `null` when it has none to report.
     *
     * The single reader behind `getPriceRange`, `getPaneValueRange` and the range
     * event, so the three cannot disagree. It reports the *drawn* range rather than the
     * locked one: a pane whose lock is not being honoured is fitting, and reporting the
     * lock would put a number on screen that the chart is not using.
     */
    private paneRangeOf(pane: number): [number, number] | null {
        if (pane === PRICE_PANE) {
            if (this.pricePaneRect().height <= 0 || this.scaleY === 0) return null;
        } else {
            const rect: PlotRect | undefined = this.paneLayout.rects[pane];
            const transform: VerticalTransform | undefined = this.paneLayout.transforms[pane];
            if (rect === undefined || transform === undefined) return null;
            if (!(rect.height > 0) || transform.scaleY === 0) return null;
        }
        return this.getPaneValueRange(pane);
    }

    /**
     * The factor the candle pyramid is currently drawing at, captured while the
     * level is chosen so overlays reduce to the very same buckets. Zero until the
     * first pass, which is harmless because there is nothing to draw then.
     */
    private overlayAggregationFactor: number = 1;

    /**
     * First pyramid bucket in `displayedCandles`, so a record's slot position can be
     * recovered from its position in the slice.
     */
    private displayedStartBucket: number = 0;

    /**
     * The retained-window ordinals currently on screen, from the same computation that
     * slices the candles.
     *
     * Overlays are reduced over this rather than over the whole retained series. The
     * candle path has always been culled — the engine draws the buckets the plot covers
     * — and an overlay that reduced the entire series on every frame paid for every bar
     * scrolled off the left edge as though it were about to be drawn. At 50,000 bars and
     * 32 indicators that was 14.8 ms of every frame, against 0.28 ms culled.
     *
     * Read in retained-window ordinals, not buckets, because the reduction divides. Zero
     * until the first pass, which is harmless: there is nothing to draw then.
     */
    private visibleFirstOrdinal: number = 0;
    private visibleLastOrdinal: number = -1;

    private updateVisibleCandles(): void {
        const viewport: ChartViewport = this.viewport;
        if (this.candlePyramid.candleCount === 0) {
            this.displayedCandles = new Float32Array(0);
            this.displayedStartBucket = 0;
            this.visibleFirstOrdinal = 0;
            this.visibleLastOrdinal = -1;
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
            // Non-zero once the series has been trimmed: the level's x values are
            // absolute ordinals, and the slice has to hand back retained-window ones.
            const levelBase: number = this.candlePyramid.getLevelBase(levelIndex);
            // The window is found in **bars**, not in the x the shader transforms.
            // `coordinateToIndex` resolves a coordinate through the slot table, so the
            // bar it names is the bar actually under that edge of the plot, and dividing
            // by the factor turns it into the bucket that holds it. Reading the raw
            // coordinate as an ordinal instead would name a bar further right than the
            // one on screen for every bar a break stands to the left of the edge, and the
            // slice would start after bars that are still visible.
            const visibleMinX: number = coordinateToIndex(viewport, viewport.plot.x);
            const visibleMaxX: number = coordinateToIndex(
                viewport,
                viewport.plot.x + viewport.plot.width,
            );
            // A trimmed series is bucketed on **absolute** boundaries, so a
            // retained-relative bar index has to be taken to absolute before it can be
            // divided by the factor, and the resulting absolute bucket translated back
            // into a position in this level's window. Dividing the retained index
            // directly is off by the trim count from the first bucket onwards, which
            // shows up as a zoomed-out chart whose candles and overlays are a whole
            // bucket out of step.
            const barBase: number = this.candlePyramid.getLevelBase(0);
            const firstBucket: number = Math.floor((barBase + visibleMinX) / aggregationFactor);
            const lastBucket: number = Math.ceil((barBase + visibleMaxX) / aggregationFactor);
            const startBucket: number = Math.max(0, firstBucket - levelBase - 1);
            const endBucket: number = Math.min(levelCount, lastBucket - levelBase + 2);
            this.displayedStartBucket = startBucket;
            // The same window, in retained ordinals rather than buckets. `bucketOverlay`
            // divides by the factor itself, and these are widened by one bar rather than
            // one bucket because an overlay's coverage is checked per ordinal — the
            // reduction clamps its own range to the covered window, so passing a
            // deliberately generous range here cannot make it draw a bar it has no value
            // for.
            this.visibleFirstOrdinal = Math.max(0, Math.floor(visibleMinX - 1));
            this.visibleLastOrdinal = Math.min(
                this.candlePyramid.candleCount - 1,
                visibleMaxX + 1,
            );
            this.displayedCandles = endBucket > startBucket
                ? this.sliceInSlotSpace(
                    level, startBucket, endBucket, aggregationFactor, levelBase, barBase,
                )
                : new Float32Array(0);
        }

    }

    /**
     * The visible buckets, with each record's x moved from ordinal space into slot space.
     *
     * The pyramid hands over a run of bars; the renderer needs a position for each. The
     * conversion is per record rather than per pixel because the slot table is a prefix
     * sum that changes only when the data does, so this is O(buckets on screen) and never
     * runs per bar of the series.
     *
     * `levelBase` is the absolute ordinal the level's first bucket carries, which is
     * non-zero once the series has been trimmed. The slice's own x values are absolute
     * and have to come back as retained-window ordinals, because that is the numbering
     * every other layer works in — the slot table, `coordinateToIndex`, and the live
     * edge. Both branches below apply it, including the unbroken one: a series that has
     * never been trimmed has a base of zero and the loop is a no-op, and a series that
     * has been trimmed needs it even with no session breaks at all.
     */
    private sliceInSlotSpace(
        level: Float32Array,
        startBucket: number,
        endBucket: number,
        factor: number,
        levelBase: number,
        barBase: number,
    ): Float32Array {
        const from: number = startBucket * CANDLE_STRIDE;
        const to: number = endBucket * CANDLE_STRIDE;
        const out: Float32Array = level.slice(from, to);
        if (levelBase === 0 && barBase === 0 && this.slotOffsets === null) return out;
        const sourceCount: number = this.candlePyramid.candleCount;
        for (let offset = 0; offset < out.length; offset += CANDLE_STRIDE) {
            const position: number = startBucket + offset / CANDLE_STRIDE;
            out[offset + CANDLE_X] = this.slotOffsets === null
                // Unbroken: ordinal space and slot space are the same number, so the only
                // conversion is the absolute ordinal this bucket covers.
                ? levelBase + position - barBase
                : bucketCentreSlot(
                    this.slotOffsets,
                    levelBase + position,
                    factor,
                    sourceCount,
                    barBase,
                );
        }
        return out;
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
            // The two directions of this switch were not symmetric, and that is the whole
            // defect. Moving *to* a line cleared the candle series; moving *back* cleared
            // nothing, so the polyline — and, for an area, the fill beneath it — stayed on
            // the GPU under the candles until something else happened to overwrite it. A
            // chart switched from area to candlesticks showed the fill and the line it was
            // drawn on top of, which reads as a rendering fault in the candles rather than
            // as a style that was never switched off.
            //
            // The data layer holds this geometry in persistent buffers and empties them
            // only when told to — its own `clearArea` says as much — so the two lines below
            // are the only place the clearing can happen. They cost a `setPasses([])` each.
            this.dataRenderer.clearLine();
            this.dataRenderer.clearArea();
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
        this.emitter.emit('data', { times: this.candleTimes, interval: this.modalInterval() });
    }

    /**
     * The modal interval between retained bars, in ms, derived once per data change.
     *
     * `modalInterval` is O(n log n): it collects every gap in the series and sorts
     * it to find the median. It is needed on the time axis to choose a step from
     * the calendar ladder, and the time axis runs on **every rendered frame** — so
     * it was being paid on every pan, zoom, append, resize, and crosshair frame.
     * At the default retention of 1,000,000 candles that is a sort of a million
     * boxed doubles, several times a second, to produce a number that changes only
     * when the timestamps do.
     *
     * Cached here, next to the array it describes, and invalidated by every path
     * that writes to that array. The cache is a plain field rather than a
     * `WeakMap` keyed on the array: `candleTimes` is mutated in place by `push`
     * and `splice`, so an identity-keyed cache would go stale without anything
     * changing the array's identity — the failure would be a wrong axis step that
     * no test could reproduce from a sequence of calls.
     */
    private modalInterval(): number {
        if (this.cachedModalInterval === null) {
            this.cachedModalInterval = modalInterval(this.candleTimes);
        }
        return this.cachedModalInterval;
    }

    /** Drops the cached modal interval. Called by every path that writes timestamps. */
    private invalidateModalInterval(): void {
        this.cachedModalInterval = null;
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
                // The absolute origin of the retained window, so the overlay is bucketed
                // on the same grid the candles are.
                this.candlePyramid.getLevelBase(0),
                // The window the candles above were sliced to. Clamped to the overlay's
                // own covered range inside the reduction, so an indicator that starts
                // partway across the series still begins partway across the chart.
                this.visibleFirstOrdinal,
                this.visibleLastOrdinal,
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
            let points2: Float32Array | null = null;
            if (overlay.values2 !== null) {
                const bucketed2 = bucketOverlay(
                    overlay.values2,
                    factor,
                    sourceCount,
                    overlay.firstIndex,
                    overlay.lastIndex,
                    null,
                    this.candlePyramid.getLevelBase(0),
                    this.visibleFirstOrdinal,
                    this.visibleLastOrdinal,
                );
                points2 = this.slotOverlayPoints(
                    bucketed2.points,
                    bucketed2.stride,
                );
            }
            const baselineVal = overlay.pane === PRICE_PANE
                ? toScaleSpace(overlay.baseline, this.priceScale())
                : overlay.baseline;
            this.dataRenderer.drawOverlay(
                overlay.id,
                points,
                bucketed.stride,
                overlay.color,
                overlay.pane === PRICE_PANE ? null : this.paneLayout.transforms[overlay.pane],
                overlay.pane,
                overlay.type,
                baselineVal,
                points2,
                overlay.fillColor,
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

        const paneIndex: number = volume.pane ?? 0;
        const paneRect: PlotRect = (paneIndex > 0 && this.paneRects && this.paneRects[paneIndex])
            ? this.paneRects[paneIndex]
            : this.viewport.plot;
        const regionHeight: number = paneIndex > 0 ? paneRect.height : paneRect.height * volume.heightRatio;
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

        // Bars occupy the bottom of the pane/plot, growing upward
        const scaleY: number = -(regionHeight * 0.92) / peak;
        const baseline: number = paneRect.y + paneRect.height;
        const offsetY: number = baseline - 0 * scaleY;
        this.dataRenderer.drawHistogram(
            this.displayedCandles,
            volume.colors,
            scaleY,
            offsetY,
            paneIndex,
        );
    }

    public destroy(): void {
        // Idempotent: teardown code often runs from more than one place.
        if (this.destroyed) return;
        this.cancelScheduledViewportUpdate();
        this.cancelScheduledVisibleRangeChange();
        this.cancelScheduledPaneRangeChange();
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        this.dataCanvas.removeEventListener('webglcontextlost', this.handleDataContextLost);
        this.dataCanvas.removeEventListener('webglcontextrestored', this.handleDataContextRestored);
        this.canvasWrapper.removeEventListener('pointerdown', this.handlePointerDown);
        this.canvasWrapper.removeEventListener('pointermove', this.handlePointerMove);
        this.canvasWrapper.removeEventListener('pointerup', this.handlePointerEnd);
        this.canvasWrapper.removeEventListener('pointercancel', this.handlePointerEnd);
        this.canvasWrapper.removeEventListener('lostpointercapture', this.handlePointerEnd);
        this.canvasWrapper.removeEventListener('pointerleave', this.handlePointerLeave);
        this.canvasWrapper.removeEventListener('wheel', this.handleWheel);
        // Drop every subscriber so a destroyed chart cannot call back into
        // application code, and so handlers are not retained by this instance.
        //
        // Every set has to be named here. The three that were missing — order,
        // drawing/order interaction, and pane range — are the ones whose payloads
        // carry the caller's own objects, so a handler closure pinning a DOM node
        // or a drawing survived `destroy()` and stayed reachable from whatever
        // still held the chart. A set that is not cleared is not a leak the GC can
        // ever collect, because the chart holds the handler and the handler's
        // owner usually holds something the chart also references.
        this.crosshairHandlers.clear();
        this.clickHandlers.clear();
        this.visibleRangeHandlers.clear();
        this.orderHandlers.clear();
        this.drawingOrderHandlers.clear();
        this.paneRangeHandlers.clear();
        // A claim handler closes over whatever the caller's tool model is, so dropping it
        // is what stops a destroyed chart being reachable from that model. The outstanding
        // claim goes with it, so a destroyed chart has no gesture in progress.
        this.pointerClaimHandler = null;
        this.claimedPointerId = null;
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
