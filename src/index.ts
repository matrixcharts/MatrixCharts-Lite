export { Chart } from './core/Chart.js';
export type { CandleData } from './core/CandleData.js';
export type {
    CandlestickOptions,
    ChartOptions,
    ChartTheme,
    CrosshairOptions,
    GridOptions,
    LayoutOptions,
    PanesOptions,
    PriceFormatOptions,
    ResolvedChartOptions,
    TimeScaleOptions,
    VolumeOptions,
} from './core/options.js';
export type { LogicalRange, PlotRect, TimeRange } from './core/coordinates.js';
export type { ChartViewState } from './core/viewState.js';
export type { LineSeriesHandle, LineSeriesOptions } from './core/series.js';
export type {
    DrawingPoint,
    DrawingType,
    DragHandle,
    EditableDrawing,
    OrderSide,
    OrderSpec,
    OrderStatus,
    ResolvedOrder,
} from './core/tradingTools.js';
// The drawing model is exported, not just its types, because these are the
// renderer-agnostic parts an application needs in order to build its own drawing
// layer: geometry, hit testing, validation, and the order state machine. They take
// their projections as arguments and know nothing about this engine's internals, so
// they work against any chart that can report where a bar is.
//
// What is *not* exported is any drawing rendering. The engine paints candles, axes,
// grids, and the decorations it is told about; where an application's own drawings
// go on screen is `Chart.setOverlayPainter`, and the geometry here is what it draws.
export {
    canTransitionOrder,
    createDrawingFromGesture,
    createOrderFromDrawing,
    getDrawingHandles,
    hitTestDrawings,
    validateDrawings,
    DRAWING_TYPES,
} from './core/drawingOrderModel.js';
export type {
    DrawingOrderEvent,
    DrawingOrderHitResult,
    DrawPointProjector,
} from './core/drawingOrderModel.js';
// The paint seam: the one place a caller's own content reaches the screen.
export type { OverlayPainter, PaintContext } from './core/paint.js';
// The gesture seam: the one place a caller can take a press the engine would otherwise
// turn into a pan. A drawing tool that cannot claim its own drag is dragging the chart
// and the drawing at once.
export type { PointerClaim, PointerClaimHandler } from './core/paint.js';
export { ChartSyncGroup } from './core/ChartSyncGroup.js';
export type { ChartSyncOptions } from './core/ChartSyncGroup.js';
export type { OverlayPoint, OverlaySpec } from './core/overlays.js';
export type {
    MarkerPosition,
    MarkerShape,
    MarkerSpec,
    PriceLineSpec,
    ZoneSpec,
    ZoneState,
} from './core/decorations.js';
export type {
    ChartClickEvent,
    CrosshairCleared,
    CrosshairData,
    CrosshairMoveEvent,
    DrawingOrderInteractionEvent,
    PaneRangeEvent,
    HitTestResult,
    Unsubscribe,
    VisibleRangeEvent,
} from './core/ChartEvents.js';
export type {
    CandleFeedMessage,
    CandleSource,
    CandleSourceState,
    CandleTarget,
    FeedDiagnostics,
    WebSocketCandleSourceOptions,
} from './feed/index.js';
export {
    ChartFeedController,
    MockCandleSource,
    WebSocketCandleSource,
    CandleReplaySource,
} from './feed/index.js';
export type { CandleReplayFrame } from './feed/index.js';
