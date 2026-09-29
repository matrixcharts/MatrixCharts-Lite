"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CandleReplaySource = exports.WebSocketCandleSource = exports.MockCandleSource = exports.ChartFeedController = exports.ChartSyncGroup = exports.DRAWING_TYPES = exports.validateDrawings = exports.hitTestDrawings = exports.getDrawingHandles = exports.createOrderFromDrawing = exports.createDrawingFromGesture = exports.canTransitionOrder = exports.Chart = void 0;
var Chart_js_1 = require("./core/Chart.js");
Object.defineProperty(exports, "Chart", { enumerable: true, get: function () { return Chart_js_1.Chart; } });
// The drawing model is exported, not just its types, because these are the
// renderer-agnostic parts an application needs in order to build its own drawing
// layer: geometry, hit testing, validation, and the order state machine. They take
// their projections as arguments and know nothing about this engine's internals, so
// they work against any chart that can report where a bar is.
//
// What is *not* exported is any drawing rendering. The engine paints candles, axes,
// grids, and the decorations it is told about; where an application's own drawings
// go on screen is `Chart.setOverlayPainter`, and the geometry here is what it draws.
var drawingOrderModel_js_1 = require("./core/drawingOrderModel.js");
Object.defineProperty(exports, "canTransitionOrder", { enumerable: true, get: function () { return drawingOrderModel_js_1.canTransitionOrder; } });
Object.defineProperty(exports, "createDrawingFromGesture", { enumerable: true, get: function () { return drawingOrderModel_js_1.createDrawingFromGesture; } });
Object.defineProperty(exports, "createOrderFromDrawing", { enumerable: true, get: function () { return drawingOrderModel_js_1.createOrderFromDrawing; } });
Object.defineProperty(exports, "getDrawingHandles", { enumerable: true, get: function () { return drawingOrderModel_js_1.getDrawingHandles; } });
Object.defineProperty(exports, "hitTestDrawings", { enumerable: true, get: function () { return drawingOrderModel_js_1.hitTestDrawings; } });
Object.defineProperty(exports, "validateDrawings", { enumerable: true, get: function () { return drawingOrderModel_js_1.validateDrawings; } });
Object.defineProperty(exports, "DRAWING_TYPES", { enumerable: true, get: function () { return drawingOrderModel_js_1.DRAWING_TYPES; } });
var ChartSyncGroup_js_1 = require("./core/ChartSyncGroup.js");
Object.defineProperty(exports, "ChartSyncGroup", { enumerable: true, get: function () { return ChartSyncGroup_js_1.ChartSyncGroup; } });
var index_js_1 = require("./feed/index.js");
Object.defineProperty(exports, "ChartFeedController", { enumerable: true, get: function () { return index_js_1.ChartFeedController; } });
Object.defineProperty(exports, "MockCandleSource", { enumerable: true, get: function () { return index_js_1.MockCandleSource; } });
Object.defineProperty(exports, "WebSocketCandleSource", { enumerable: true, get: function () { return index_js_1.WebSocketCandleSource; } });
Object.defineProperty(exports, "CandleReplaySource", { enumerable: true, get: function () { return index_js_1.CandleReplaySource; } });
