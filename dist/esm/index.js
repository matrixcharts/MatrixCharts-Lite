export { Chart } from './core/Chart.js';
// The drawing model is exported, not just its types, because these are the
// renderer-agnostic parts an application needs in order to build its own drawing
// layer: geometry, hit testing, validation, and the order state machine. They take
// their projections as arguments and know nothing about this engine's internals, so
// they work against any chart that can report where a bar is.
//
// What is *not* exported is any drawing rendering. The engine paints candles, axes,
// grids, and the decorations it is told about; where an application's own drawings
// go on screen is `Chart.setOverlayPainter`, and the geometry here is what it draws.
export { canTransitionOrder, createDrawingFromGesture, createOrderFromDrawing, getDrawingHandles, hitTestDrawings, validateDrawings, DRAWING_TYPES, } from './core/drawingOrderModel.js';
export { ChartSyncGroup } from './core/ChartSyncGroup.js';
export { ChartFeedController, MockCandleSource, WebSocketCandleSource, CandleReplaySource, } from './feed/index.js';
