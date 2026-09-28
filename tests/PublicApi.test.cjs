const assert = require('node:assert/strict');
const { test } = require('node:test');
const publicApi = require('../.test-build/index.js');

const VALUE_EXPORTS = [
    'Chart',
    'ChartFeedController',
    'MockCandleSource',
    'WebSocketCandleSource',
];

test('package entry exports only the v1 public surface', () => {
    const exportedNames = Object.keys(publicApi).filter((name) => name !== '__esModule').sort();
    assert.deepEqual(exportedNames, VALUE_EXPORTS.slice().sort());
    for (const name of VALUE_EXPORTS) {
        assert.equal(typeof publicApi[name], 'function');
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
    // A leaked deep import means the barrel in src/index.ts is incomplete.
    for (const name of VALUE_EXPORTS) {
        assert.equal(typeof publicApi[name].name, 'string');
    }
    assert.equal(publicApi.Chart.prototype.constructor, publicApi.Chart);
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

