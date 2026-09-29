import type { CandleData } from './CandleData.js';
import type { ChartOptions, ChartTheme, ResolvedChartOptions } from './options.js';
import { type MarkerSpec, type PlacedMarker, type PriceLineSpec, type ZoneSpec } from './decorations.js';
import { type OverlayPoint, type OverlaySpec } from './overlays.js';
import type { ChartClickEvent, CrosshairMoveEvent, DrawingOrderInteractionEvent, Unsubscribe, VisibleRangeEvent, PaneRangeEvent, HitTestResult } from './ChartEvents.js';
import type { ChartViewState } from './viewState.js';
import type { LineSeriesHandle, LineSeriesOptions } from './series.js';
import type { DrawingPoint, DrawingType, EditableDrawing, DragHandle, OrderSide, OrderSpec, OrderStatus, ResolvedOrder } from './tradingTools.js';
import { type DrawPointProjector } from './drawingOrderModel.js';
import type { OverlayPainter, PointerClaimHandler } from './paint.js';
import { type LogicalRange, type PlotRect, type TimeRange } from './coordinates.js';
export declare class Chart {
    private container;
    private emitter;
    private canvasWrapper;
    private dataCanvas;
    private resizeObserver;
    private renderers;
    /**
     * The UI layer, held for the caller's paint callback.
     *
     * Separate from `renderers` because the painter has to reach a method that is
     * not on `IRenderer` — `setOverlayPainter` is specific to the layer that owns a
     * transparent 2D context. Held as a separate field rather than found in the array
     * so the role is explicit, and so a test double that implements `IRenderer` alone
     * is a compile error here instead of a painter that silently does nothing.
     */
    private uiRenderer;
    /** Held directly rather than by position, since init order is not paint order. */
    /**
     * The layer that draws the series, held as the contract Chart actually holds with it
     * rather than as the concrete renderer. See `IDataRenderer` for why the ten GPU draw
     * calls need a name of their own.
     */
    private dataRenderer;
    private isDragging;
    private lastPointerX;
    private lastPointerY;
    private activePointers;
    /**
     * The pointer id of a press a caller's claim handler took, or `null`.
     *
     * Kept out of `activePointers` on purpose: that map is what a pan and a pinch are
     * built from, and a claimed press in it would let a second finger start a pinch
     * underneath the caller's own drag.
     */
    private claimedPointerId;
    private pointerClaimHandler;
    /** Last reported claim-handler error, so a throwing handler is not reported per press. */
    private lastPointerClaimError;
    private lastPinchDistance;
    private lastPinchCenterX;
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
    private paneSeparatorDrag;
    private priceAxisDrag;
    private orderDrag;
    private offsetX;
    private scaleX;
    private offsetY;
    private scaleY;
    private candlePyramid;
    private displayedCandles;
    private candleTimes;
    private overlays;
    /**
     * The specs as last supplied, kept so a change to the pane count can
     * re-validate them. Resolved overlays alone are not enough for that, because
     * a pane index has already been resolved away by then.
     */
    private overlaySpecs;
    /** Decorations, drawn on the UI layer rather than as series. */
    private priceLines;
    private markers;
    private zones;
    private orders;
    private orderHandlers;
    /** Editable drawings with drag handles. */
    private drawings;
    /** Drawing/order interaction event handlers. */
    private drawingOrderHandlers;
    /** The drag operation currently in progress. */
    private activeDrag;
    /** The drawing type currently being created. */
    private creatingDrawingType;
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
    private lockedPaneRanges;
    /**
     * Reused each frame, so a log chart converts prices in place rather than
     * reallocating a full candle buffer on every animation frame.
     */
    private scaledCandleBuffer;
    /**
     * Slot offset of every retained bar, or null when the series has no breaks.
     *
     * Rebuilt only when the data changes. Pan and zoom never touch it, which is
     * the reason the unit is slots: a per-bar table rebuilt on every wheel tick
     * would cost more than the candle pyramid, and a table in wall-clock deltas
     * would make the x transform a function of the viewport rather than of the data.
     */
    private slotOffsets;
    /**
     * Pane rects and vertical transforms for the current frame, in CSS pixels.
     * Recomputed with the viewport, because both depend on it.
     */
    private paneLayout;
    /**
     * Cached `modalInterval(this.candleTimes)`, or null when it must be re-derived.
     *
     * Null means "not yet computed", which is distinct from a computed 0 — a series
     * whose bars all share a timestamp has a real modal interval of 0, and
     * conflating the two would re-derive it on every frame forever, which is the
     * cost this field exists to remove.
     */
    private cachedModalInterval;
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
    private slotBreakScale;
    private paneRects;
    private followsLiveEdge;
    private scheduledViewportFrame;
    private readonly maxRetainedCandles;
    private pendingAppends;
    private pendingLastUpdate;
    private pendingReplace;
    /**
     * Caller-supplied partials, accumulated across every applyOptions. Kept so a
     * theme change can re-seed from the new preset and still re-apply these.
     */
    private explicitOptions;
    private resolvedOptions;
    /** CSS colours parsed to vec4 once per apply, never per candle. */
    private candleColors;
    private crosshairX;
    private crosshairY;
    private crosshairIndex;
    private crosshairCandle;
    private crosshairTime;
    private crosshairHandlers;
    private clickHandlers;
    private visibleRangeHandlers;
    private paneRangeHandlers;
    /** What each pane was last reported as showing, so the event is silent when it did not move. */
    private lastReportedPaneRanges;
    private pressX;
    private pressY;
    private pressButton;
    private pressMoved;
    /** Last raw pointer position in client coordinates, for viewport changes. */
    private pointerClientX;
    private pointerClientY;
    private lastReportedRange;
    private scheduledRangeFrame;
    private scheduledPaneRangeFrame;
    /**
     * A destroyed chart is unusable. Every public method throws a single stable
     * error rather than some throwing internal messages and others quietly
     * serving stale state, which is far harder to diagnose at an integration
     * boundary.
     */
    private destroyed;
    /** A lost WebGL context pauses data uploads until the browser restores it. */
    private dataContextLost;
    /** Guards against a handler re-entering its own event and looping forever. */
    private emittingCrosshair;
    private emittingVisibleRange;
    private emittingPaneRange;
    /**
     * Mounts a chart into an existing element, or into `document.getElementById(container)`.
     * WebGL2 is required.
     *
     * Constructor options are the initial `applyOptions`. `maxRetainedCandles` is
     * accepted here only; every other field may be changed later.
     */
    constructor(container: HTMLElement | string, options?: ChartOptions);
    private createLayer;
    private handleDataContextLost;
    private handleDataContextRestored;
    private handleResize;
    private lastSizedWidth;
    private lastSizedHeight;
    private lastSizedRatio;
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
    private clampView;
    /**
     * Whether this chart has ever measured a non-zero container.
     *
     * The distinction that `clientWidth || FALLBACK` cannot make on its own: zero
     * before the first measurement is "not ready", and zero afterwards is "collapsed".
     */
    private hasBeenSized;
    /** Whether the container is right now measuring zero in either axis. */
    private containerIsZero;
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
    private syncRendererSize;
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
    setPointerClaimHandler(handler: PointerClaimHandler | null): void;
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
    redraw(): void;
    private bindEvents;
    /**
     * Hit-tests the native 'MC' brand watermark badge in the bottom-left corner
     * of the plot rect.
     */
    private isWatermarkHit;
    private handlePointerDown;
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
    private isInPriceAxisGutter;
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
    private paneAtClientY;
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
    private separatorAtRow;
    private updatePaneSeparatorDrag;
    private paneAtRow;
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
    getPaneAtCoordinate(x: number, y: number): number | null;
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
    private beginPaneAxisDrag;
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
    private updatePaneAxisDrag;
    /**
     * Pointer capture keeps a drag alive when the pointer leaves the chart. It
     * throws for a pointer the browser no longer considers active, and that must
     * degrade to "no capture" rather than break the gesture, because the events
     * still reach the wrapper by bubbling.
     */
    private capturePointer;
    private handlePointerMove;
    /** Translates the price range with a plot drag, preserving its span. */
    private panPricePane;
    private handlePointerEnd;
    private handlePointerLeave;
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
    private offerPointerClaim;
    /** A drag or pinch is under way, so pointer movement is not hover. */
    private isInteracting;
    private handleWheel;
    private zoomAt;
    setData(candles: readonly CandleData[]): void;
    setTheme(theme: ChartTheme): void;
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
    applyOptions(partial: ChartOptions): void;
    /** Fully resolved options. The returned object is a fresh, immutable snapshot. */
    options(): Readonly<ResolvedChartOptions>;
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
    private setBarSpacingLive;
    private clampBarSpacing;
    /**
     * Sets bar spacing while holding the view still: a live-following chart stays
     * pinned to the newest bar, anything else keeps the bar under the viewport
     * centre where it was.
     */
    private applyBarSpacing;
    /** Throws if `destroy()` has run. Called by every public entry point. */
    private assertAlive;
    /** Fires as the pointer moves over the chart, and once when it leaves. */
    subscribeCrosshairMove(handler: (event: CrosshairMoveEvent) => void): Unsubscribe;
    /** Fires on a press and release that did not turn into a pan or pinch. */
    subscribeClick(handler: (event: ChartClickEvent) => void): Unsubscribe;
    /**
     * Fires when the visible candle range or bar spacing changes, at most once
     * per animation frame. A drag that stays inside one bar's width is silent.
     */
    subscribeVisibleRangeChange(handler: (event: VisibleRangeEvent) => void): Unsubscribe;
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
    subscribePaneRangeChange(handler: (event: PaneRangeEvent) => void): Unsubscribe;
    private emitCrosshair;
    private dispatchCrosshair;
    private updateCrosshair;
    private clearCrosshair;
    private emitClick;
    /** Current plot geometry. Internal; exposed for the renderer and tests. */
    private get viewport();
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
    private plotRect;
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
    getPlotRect(): PlotRect;
    /** CSS pixels per candle index. */
    getBarSpacing(): number;
    /**
     * Visible candle indices as a half-open range: `from` through `to - 1`.
     * Partial bars at either edge are included, and `from === to` means the
     * series is empty or fully scrolled out of view.
     */
    getVisibleLogicalRange(): LogicalRange;
    /**
     * Epoch milliseconds of the first and last visible candles, both inclusive,
     * or `null` when no candle is visible. Closed sessions are not interpolated,
     * so the span can be wider than the elapsed visible time.
     */
    getVisibleTimeRange(): TimeRange | null;
    /** Captures the user-owned viewport and pane ranges for persistence or linking. */
    getViewState(): ChartViewState;
    /** Restores a previously captured viewport and pane state. */
    setViewState(state: ChartViewState): void;
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
    setVisibleLogicalRange(range: LogicalRange): void;
    /** Number of candles retained in chart memory. */
    getCandleCount(): number;
    /**
     * Retained candle at a zero-based ordinal index, or `null` when the index is
     * out of range. Prices come back at float32 precision, matching what the
     * renderer draws, so they may differ from the doubles that were passed in.
     */
    getCandleAt(index: number): CandleData | null;
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
    setOverlays(overlays: readonly OverlaySpec[]): void;
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
    appendOverlayValue(id: string, time: number, value: number, color?: string): number;
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
    appendOverlayValues(id: string, points: readonly OverlayPoint[], color?: string): number;
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
    updateOverlayValue(id: string, time: number, value: number, color?: string): number;
    /**
     * The ordinal a timestamp names, or -1.
     *
     * An exact match only, for the same reason `resolveOverlays` insists on one: a
     * value landing on a bar the caller did not mean is a defect that looks correct.
     */
    private overlayOrdinalFor;
    /** Adds a managed line series using the chart's validated overlay pipeline. */
    addSeries(options: LineSeriesOptions): LineSeriesHandle;
    /** Adds an editable drawing backed by the managed line-series pipeline. */
    addDrawing(options: LineSeriesOptions & {
        points?: readonly DrawingPoint[];
    }): LineSeriesHandle;
    /** Replaces working orders shown as interactive price lines. */
    setOrders(orders: readonly OrderSpec[]): void;
    getOrders(): ResolvedOrder[];
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
    updateOrderStatus(id: string, status: OrderStatus): void;
    subscribeOrders(handler: (orders: readonly ResolvedOrder[]) => void): Unsubscribe;
    private emitOrders;
    /**
     * Replaces all editable drawings.
     *
     * Validated before anything is replaced, so a refused call leaves the existing
     * set exactly as it was. Every other bulk-ingest method on this class already
     * worked that way; this one did not, which meant a drawing with a NaN anchor
     * entered the store and then failed every projection and every hit test
     * invisibly.
     */
    setDrawings(drawings: readonly EditableDrawing[]): void;
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
    getDrawings(): EditableDrawing[];
    /** Returns drag handles for a specific drawing. */
    getDrawingHandles(id: string): DragHandle[];
    /** Starts creating a drawing of the given type. Call on pointer down. */
    beginDrawingCreate(type: DrawingType, point: DrawingPoint): void;
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
    updateDrawingCreate(point: DrawingPoint): void;
    /** Completes the drawing creation. Call on pointer up. */
    finishDrawingCreate(id: string): EditableDrawing | null;
    /** Cancels the drawing creation. */
    cancelDrawingCreate(): void;
    /** Selects a drawing by id. */
    selectDrawing(id: string): void;
    /** Deselects all drawings. */
    deselectAllDrawings(): void;
    /** Deletes a drawing by id. */
    deleteDrawing(id: string): boolean;
    /** Creates an order from a horizontal-line or trend-line drawing. */
    createOrderFromDrawing(drawingId: string, side: OrderSide, orderId: string, quantity?: number): boolean;
    /** Subscribes to drawing/order interaction events. */
    subscribeDrawingOrderEvents(handler: (event: DrawingOrderInteractionEvent) => void): Unsubscribe;
    private emitDrawings;
    private emitDrawingOrderEvent;
    /**
     * Validates and aligns overlay specs against the current options.
     *
     * Kept separate from `setOverlays` because the pane count can change under an
     * overlay: shrinking `panes.weights` can leave a supplied overlay naming a
     * pane that no longer exists, and that has to be caught rather than drawn on
     * whichever pane now occupies that index.
     */
    private resolveOverlaySpecs;
    /** The overlay ids currently supplied, in the order they were given. */
    getOverlayIds(): string[];
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
    setPriceLines(lines: readonly PriceLineSpec[]): void;
    /**
     * Removes one price line by id. Returns whether it was there, so a caller can
     * tell a removal that happened from one that did not.
     */
    removePriceLine(id: string): boolean;
    /** The price line ids currently drawn, in the order they were given. */
    getPriceLineIds(): string[];
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
    setMarkers(markers: readonly MarkerSpec[]): void;
    /**
     * The markers currently supplied, with the ordinal each timestamp snapped to
     * and the price each is drawn at.
     *
     * Present whether or not they are visible, so a caller can read positions at a
     * zoom where the markers themselves are suppressed. The price is the live one,
     * recomputed from the bar the marker landed on rather than fixed when
     * `setMarkers` was called, so it moves with a candle that is still updating.
     */
    getMarkers(): PlacedMarker[];
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
    setZones(zones: readonly ZoneSpec[]): void;
    /**
     * The zone ids currently supplied, in the order they were given.
     *
     * This reports every zone, including any left undrawn because the chart was over
     * its drawing budget, so a caller can tell what is on the chart from what is not
     * rather than inferring it from a missing rectangle.
     */
    getZoneIds(): string[];
    /** Removes every zone. */
    clearZones(): void;
    /** Removes every marker. */
    clearMarkers(): void;
    /**
     * The newest candle's close and whether it closed up, or `null` with no data.
     * This is what the last-price tag is drawn from.
     */
    getLastPrice(): {
        price: number;
        direction: 'up' | 'down';
    } | null;
    private lastPrice;
    private emitDecorations;
    private priceLinesWithOrders;
    /**
     * Markers with the price each one is drawn at, read from the bar it snapped to.
     *
     * Recomputed every frame rather than at `setMarkers` time, because a live candle
     * changes the high a marker above it is anchored to, and a marker pinned to a
     * stale high would drift away from the bar it is annotating.
     */
    private markersWithPrices;
    /**
     * How many panes the chart has. Always at least 1, the price pane, and equal
     * to the length of `panes.weights`.
     */
    getPaneCount(): number;
    /**
     * The price range the price pane is currently showing, low first.
     *
     * Prices, not scale-space values, whatever the scale is — this is the API a
     * caller reads to display the current range or to hand the same range to
     * another chart.
     */
    getPriceRange(): [number, number];
    /**
     * Sets the price range the price pane shows, and locks it.
     *
     * Locking is the point: a fit that runs every frame would undo this on the next
     * append. `priceScale.autoScale` goes false, so the range holds until a caller
     * turns it back on or calls `fitPriceRange`.
     */
    setPriceRange(range: readonly [number, number]): void;
    /**
     * Sets the range a pane shows, and locks that pane to it.
     *
     * The general form of `setPriceRange`, and the one the price axis drag uses for
     * whichever pane the pointer was over. Pane 0's values are prices and go through the
     * price scale, so a log chart rejects a non-positive low; every other pane's values
     * are indicator readings and are taken as they are, because that pane is drawn
     * linear whatever the price pane is set to.
     */
    setPaneRange(pane: number, range: readonly [number, number]): void;
    /** A pane index that exists, or the documented error naming the call that asked. */
    private requirePaneIndex;
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
    private adoptLockedPaneRange;
    /**
     * Unlocks the price pane and lets it fit the visible data again.
     *
     * Separate from `applyOptions({priceScale: {autoScale: true}})` only in
     * spelling: the range is forgotten either way, so the next frame is a fit.
     */
    fitPriceRange(): void;
    /**
     * Unlocks one pane and lets it fit its own values again.
     *
     * The counterpart to `setPaneRange`, and the only way back from a drag. A pane
     * nobody can un-drag is a pane a single historical spike can flatten for good, which
     * is the reason the gesture exists in the first place.
     */
    fitPaneRange(pane: number): void;
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
    private slotX;
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
    private slotOverlayPoints;
    private rebuildSlots;
    fitContent(): void;
    /**
     * Returns to the live edge, re-arming the follow that a pan switches off.
     *
     * Separate from setting the range by hand because the latch is the part a
     * caller cannot see: a chart that has been panned keeps the old offset and looks
     * frozen at the new one, and the only way back is this.
     */
    scrollToRealtime(): void;
    /** Whether the chart is currently following the newest candle. */
    isAtRealtime(): boolean;
    /**
     * The value range currently shown in a pane, low first, or `null` for a pane
     * that does not exist or has nothing on screen to scale to.
     *
     * Pane 0 reports the price range. Any other pane reports the range of the
     * values drawn in it, which is the range its axis is labelled from, so a
     * caller labelling its own pane is reading the same numbers the chart is
     * drawing rather than recomputing them.
     */
    getPaneValueRange(pane: number): [number, number] | null;
    /**
     * The value of one overlay at a candle index, or `null` when the overlay does
     * not cover that candle — including the bars before an indicator's warm-up.
     * Read at full resolution, so this is the caller's own value rather than a
     * reduced one.
     */
    getOverlayValueAt(id: string, index: number): number | null;
    /** Newest retained candle, or `null` when the chart has no data. */
    getLastCandle(): CandleData | null;
    /** Screen x of a candle index, measured from the canvas's left edge. */
    indexToCoordinate(index: number): number;
    /** Fractional candle index at a screen x. Not clamped to the series. */
    coordinateToIndex(coordinateX: number): number;
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
    coordinateToSlot(coordinateX: number): number;
    /** Screen x of a fractional slot, the inverse of `coordinateToSlot`. */
    slotToCoordinate(slot: number): number;
    /** Index of the candle nearest a screen x, or -1 when the chart has no data. */
    coordinateToNearestIndex(coordinateX: number): number;
    /**
     * Timestamp of the candle nearest a screen x, or `null` when the chart has no
     * data. Snaps to a real candle time and never interpolates through a gap.
     */
    coordinateToTime(coordinateX: number): number | null;
    /**
     * Screen x of the candle whose timestamp is nearest `time`, or `null` when
     * the chart has no data. Inverse of `coordinateToTime` up to snapping.
     */
    timeToCoordinate(time: number): number | null;
    /** Screen y of a price. */
    priceToCoordinate(price: number): number;
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
    getPriceAxisWidth(): number;
    /**
     * Dynamically measures the required price axis gutter width from actual price digits,
     * decimals, and font metrics.
     */
    measurePriceAxisWidth(samplePrice?: number): number;
    /**
     * Re-measures dynamic gutter width and updates layout if changed.
     */
    updateDynamicPriceAxisWidth(samplePrice?: number): void;
    drawingProjector(pane?: number): DrawPointProjector;
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
    setOverlayPainter(painter: OverlayPainter | null): void;
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
    private reportPointerClaimError;
    /**
     * Screen-to-data for drawing geometry, matching `drawingProjector`.
     *
     * A y outside the pane is converted rather than rejected, for the same reason
     * `coordinateToPrice` converts one: a crosshair dragged off the top of the
     * chart still has a price, and it is a real one.
     *
     * @param pane Optional pane index, for geometry anchored in a sub-pane's units.
     */
    drawingUnprojector(pane?: number): (x: number, y: number) => DrawingPoint;
    /**
     * Projects a screen point (x, y) back to data coordinates for any pane
     * (Pane 0 = price, Panes 1..N = subpanes with local bounds).
     */
    toData(x: number, y: number, pane?: number): DrawingPoint;
    /**
     * Projects a data point (time, value) to screen coordinates for any pane.
     */
    toScreen(point: DrawingPoint, pane?: number): {
        x: number;
        y: number;
    } | null;
    /**
     * Converts a screen y coordinate to a value within the specified pane.
     */
    coordinateToPaneValue(pane: number, coordinateY: number): number | null;
    /**
     * Converts a value within the specified pane to a screen y coordinate.
     */
    paneValueToCoordinate(pane: number, value: number): number | null;
    /**
     * Validates a pane index for a geometry helper, and returns it.
     *
     * The same bounds `getPaneValueRange` enforces, reported against the helper that
     * was asked for rather than against whichever one happened to be edited next.
     */
    private assertPaneExists;
    /**
     * `timeToCoordinate` without the liveness check, for the projectors above.
     *
     * A projector calls this on every anchor of every hit test, and the
     * `assertAlive()` inside `timeToCoordinate` is a per-anchor branch against a
     * flag the projector is already inside. The projector is guarded once, at the
     * point it is handed out.
     */
    private timeToCoordinateUnchecked;
    private coordinateToTimeUnchecked;
    /**
     * Price at a screen y on the price pane, honouring the scale and the inversion.
     *
     * The inverse of `priceToCoordinate`. A y outside the pane is still converted
     * rather than clamped: a crosshair dragged above the chart has a price, and it
     * is a real one.
     */
    coordinateToPrice(coordinateY: number): number;
    /** Resolves the nearest engine-owned drawing target at CSS-pixel coordinates. */
    hitTest(coordinateX: number, coordinateY: number): HitTestResult | null;
    /** Replaces authoritative feed history while retaining the current time anchor when available. */
    replaceData(candles: readonly CandleData[]): void;
    private loadData;
    private findNearestDataIndex;
    appendData(candle: CandleData): void;
    /** Appends a chronological batch after validating every candle before mutation. */
    appendBatch(candles: readonly CandleData[]): void;
    /** Replaces the current last candle; its timestamp must match exactly. */
    updateLast(candle: CandleData): void;
    private validateCandle;
    private isAtLiveEdge;
    private scheduleViewportUpdate;
    private handleVisibilityChange;
    private cancelScheduledViewportUpdate;
    /**
     * Writes one interleaved candle record into a source buffer. Every ingest
     * path funnels through here so the record layout is defined in exactly one
     * place; a channel added to `CandleData` is appended here once rather than at
     * each of the call sites.
     */
    private writeCandleRecord;
    private flushPendingData;
    private resetPinchBaseline;
    private handlePinchMove;
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
    private priceScale;
    private autoScaleY;
    /**
     * Sets the price pane's vertical transform from a padded value range, honouring
     * the inversion. One place, so the fit and the locked range cannot disagree
     * about the sign convention.
     */
    private applyVerticalFit;
    /** Establishes the pane's transform from a price range, without padding. */
    private applyPriceRange;
    /** The price pane's rect: pane 0 of the current layout, or the whole plot. */
    private pricePaneRect;
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
    private paneValueToScale;
    /** The inverse of `paneValueToScale`, for reading a range back out. */
    private paneScaleToValue;
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
    private paneLockHonoured;
    /** The transform a pane is currently drawn with, whichever of the two tables holds it. */
    private paneTransform;
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
    private crosshairPaneScope;
    /**
     * The layout for the current frame: one rect per declared pane, and a
     * vertical transform for each.
     *
     * Pane 0 keeps the viewport's price scale so the price axis, the candles, and
     * every price-derived coordinate are untouched. Every other pane is fitted to
     * the values actually on screen in it, which is what stops an RSI drawn
     * against the price range from being a flat line along one price level.
     */
    private computePaneLayout;
    /**
     * The visible candle range as a half-open interval, computed from the same
     * transform the candles are drawn with. Reading it off the displayed slice
     * would work at full resolution and be wrong at every aggregated level.
     */
    private displayedLogicalRange;
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
    private emitViewportFrame;
    private updateViewport;
    private refreshCrosshairAfterViewportChange;
    /**
     * Coalesces range notifications to one per frame. updateViewport runs from
     * pointer handlers that can fire faster than the display, and from a rAF
     * callback during feed flushes; both collapse to a single event.
     */ private scheduleVisibleRangeChange;
    private cancelScheduledVisibleRangeChange;
    private emitVisibleRangeChange;
    /**
     * Queues a vertical-range notification, coalesced to one per animation frame.
     *
     * A drag of the axis fires this on every pointer move, and an append fires it on
     * every flush, so without the frame it would be a stream rather than a signal.
     */
    private schedulePaneRangeChange;
    private cancelScheduledPaneRangeChange;
    /**
     * Emits one event per pane whose range differs from what was last reported.
     *
     * Deduplicated per pane rather than as a single before/after comparison, because a
     * readout of one oscillator's bounds should not be woken by the price pane's fit
     * moving. A pane that has never been reported is always reported, so the first
     * subscription sees the current state instead of waiting for the next change.
     */
    private emitPaneRangeChange;
    /**
     * One pane's current range in its own units, or `null` when it has none to report.
     *
     * The single reader behind `getPriceRange`, `getPaneValueRange` and the range
     * event, so the three cannot disagree. It reports the *drawn* range rather than the
     * locked one: a pane whose lock is not being honoured is fitting, and reporting the
     * lock would put a number on screen that the chart is not using.
     */
    private paneRangeOf;
    /**
     * The factor the candle pyramid is currently drawing at, captured while the
     * level is chosen so overlays reduce to the very same buckets. Zero until the
     * first pass, which is harmless because there is nothing to draw then.
     */
    private overlayAggregationFactor;
    /**
     * First pyramid bucket in `displayedCandles`, so a record's slot position can be
     * recovered from its position in the slice.
     */
    private displayedStartBucket;
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
    private visibleFirstOrdinal;
    private visibleLastOrdinal;
    private updateVisibleCandles;
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
    private sliceInSlotSpace;
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
    private scaledCandles;
    private uploadVisibleCandles;
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
    private modalInterval;
    /** Drops the cached modal interval. Called by every path that writes timestamps. */
    private invalidateModalInterval;
    /**
     * Uploads every overlay, reduced to the same buckets as the candles.
     *
     * `aggregationFactor` is the factor the candle pyramid is currently drawing at,
     * so an overlay point lands on exactly the same x as the candle it belongs to.
     * Reducing them independently would let the two drift apart as the chart zooms,
     * which reads as the overlay lagging the price rather than as a bug.
     */
    private uploadVisibleOverlays;
    /**
     * Uploads the close price as a polyline, and as an area fill beneath it.
     *
     * The two styles share the same points, so the fill edge and the stroke edge
     * are the same numbers and cannot drift apart.
     */
    private uploadVisibleClose;
    /**
     * The reference price for the baseline style: the configured one, or the close
     * of the first visible candle. Defaulting to a real close keeps the line on
     * screen, where a caller-chosen price far outside the fitted range would draw
     * nothing at all.
     */
    private baselinePrice;
    /**
     * Fits the histogram to the bottom of the plot and uploads it.
     *
     * The volume scale is its own: bars are measured against the largest volume
     * on screen, so a volume spike cannot stretch the price axis. The region is
     * the bottom `heightRatio` of the plot for now; when volume gets its own pane
     * this becomes that pane's height and nothing else about the scaling changes.
     */
    private uploadVisibleVolume;
    destroy(): void;
}
