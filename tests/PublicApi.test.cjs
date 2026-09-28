const assert = require('node:assert/strict');
const { test } = require('node:test');
const publicApi = require('../.test-build/index.js');

// The exact set of runtime values the package entry exports. It is an allow-list
// rather than a spot-check because the point of the barrel is that nothing reaches
// an integrator that was not deliberately put there.
//
// The drawing-model functions are here because they are the renderer-agnostic half of
// a drawing layer — geometry, hit testing, validation, the order state machine — and
// an application building its own drawing tools needs them. They take their
// projections as arguments and know nothing about the engine, so they are not a
// second implementation of anything the engine does. The rendering half is not
// exported at all; that goes through `Chart.setOverlayPainter`.
const VALUE_EXPORTS = [
    'CandleReplaySource',
    'ChartSyncGroup',
    'Chart',
    'ChartFeedController',
    'DRAWING_TYPES',
    'MockCandleSource',
    'WebSocketCandleSource',
    'canTransitionOrder',
    'createDrawingFromGesture',
    'createOrderFromDrawing',
    'getDrawingHandles',
    'hitTestDrawings',
    'validateDrawings',
];

test('package entry exports only the v1 public surface', () => {
    const exportedNames = Object.keys(publicApi).filter((name) => name !== '__esModule').sort();
    assert.deepEqual(exportedNames, VALUE_EXPORTS.slice().sort());
    for (const name of VALUE_EXPORTS) {
        assert.ok(
            typeof publicApi[name] === 'function' || Array.isArray(publicApi[name]),
            `${name} should be callable or a frozen list, got ${typeof publicApi[name]}`,
        );
    }
});

test('internal renderers, math, and test hooks stay unexported', () => {
    for (const internal of [
        'IRenderer',
        'IDataRenderer',
        'WebGL2Renderer',
        'Canvas2DRenderer',
        'OHLCPyramid',
        'LTTBDownsampler',
        'candlestickBodyEdgesData',
        'EventEmitter',
        'resolveChartContainer',
    ]) {
        assert.equal(internal in publicApi, false, `${internal} must not be exported`);
    }
    for (const hook of ['testDrawWebGLData', 'testDrawWebGLCandlesticks']) {
        assert.equal(typeof publicApi.Chart.prototype[hook], 'undefined');
    }
});

test('the public read and write API is present, and nothing internal leaked beside it', () => {
    // The per-pane vertical surface: `setPaneRange`/`fitPaneRange` are what a drag of a
    // lower pane's gutter uses, and the only way for a caller to undo one. Without them a
    // pane a single spike had flattened could not be released from code at all.
    //
    // `getPaneAtCoordinate` is here for the same reason: a caller's own double-click has
    // to reach `fitPaneRange(n)`, and without the pane index at a point the only route is
    // to reimplement `paneRects` — and its rounding rules — in application code.
    for (const method of [
        'setPaneRange',
        'fitPaneRange',
        'getPaneValueRange',
        'getPaneAtCoordinate',
        'setPriceRange',
        'fitPriceRange',
        'getPriceRange',
        'subscribePaneRangeChange',
        'coordinateToSlot',
        'slotToCoordinate',
        'hitTest',
        'addSeries',
        'addDrawing',
        'setOrders',
        'getOrders',
        'updateOrderStatus',
        'subscribeOrders',
        // The live-edge pair. A chart that has been panned takes its view over and the
        // feed keeps appending into it, which from outside is indistinguishable from a
        // feed that has stopped — so a caller needs both the question and the way back.
        'isAtRealtime',
        'scrollToRealtime',
    ]) {
        assert.equal(typeof publicApi.Chart.prototype[method], 'function', `${method} must be public`);
    }
    // And they are not the seam: a factory that replaces a layer is not public API.
    for (const internal of ['createRenderer', 'setRendererFactory', 'paneAtClientY', 'paneAtRow']) {
        assert.equal(internal in publicApi, false, `${internal} must not be exported`);
    }
});

test('the visible-range payload carries the live-edge state, additively', () => {
    // `atRealtime` was added after the event was frozen, which the contract permits —
    // fields are added, never removed or repurposed. What must not change is that the
    // fields already there keep their names, their types and their meanings, so a caller
    // written against v1.0.0 destructures exactly what it did before and simply ignores
    // the new one. Pinned as a key set so a rename cannot pass unnoticed.
    const { createHeadlessChart, flatCandles } = require('./support/headlessChart.cjs');
    const harness = createHeadlessChart();
    try {
        const events = [];
        harness.chart.subscribeVisibleRangeChange((event) => events.push(event));
        harness.chart.setData(flatCandles(40));
        harness.flush();
        assert.ok(events.length > 0, 'no range event to inspect');

        for (const event of events) {
            assert.deepEqual(
                Object.keys(event).sort(),
                ['atRealtime', 'barSpacing', 'logical', 'time'],
                'the payload shape changed, which is a breaking change to a frozen event',
            );
            assert.equal(typeof event.atRealtime, 'boolean');
            assert.equal(typeof event.barSpacing, 'number');
            assert.equal(typeof event.logical.from, 'number');
            assert.equal(typeof event.logical.to, 'number');
        }
    } finally {
        harness.dispose();
    }
});

test('no public export is reachable only through a deep path', () => {
    // A leaked deep import means the barrel in src/index.ts is incomplete. Every
    // value export is a named function, or the one frozen list, and is the *same*
    // binding the internal module holds rather than a wrapper re-created here.
    for (const name of VALUE_EXPORTS) {
        const value = publicApi[name];
        if (Array.isArray(value)) {
            assert.equal(name, 'DRAWING_TYPES', 'the only list export should be declared as one');
            continue;
        }
        assert.equal(typeof value.name, 'string', `${name} should be a named function`);
    }
    assert.equal(publicApi.Chart.prototype.constructor, publicApi.Chart);
    // A wrapper would satisfy the checks above and still be a second implementation.
    const model = require('../.test-build/core/drawingOrderModel.js');
    assert.equal(publicApi.hitTestDrawings, model.hitTestDrawings);
    assert.equal(publicApi.validateDrawings, model.validateDrawings);
    assert.equal(publicApi.DRAWING_TYPES, model.DRAWING_TYPES);
});

test('the WebGL2 requirement ships as one stable, documented error string', async () => {
    // Integrators match on this text, and the contract freezes it, so a change
    // here has to be a deliberate breaking change rather than a reword.
    const { WebGL2Renderer } = require('../.test-build/renderers/WebGL2Renderer.js');
    const noContextCanvas = { getContext: () => null };
    const emitter = { on() {}, off() {} };
    assert.throws(
        () => new WebGL2Renderer().init(noContextCanvas, emitter),
        (error) => error.message === 'MatrixCharts: WebGL2 is required.',
        'unsupported context must throw the exact documented message',
    );
});

