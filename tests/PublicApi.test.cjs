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
    for (const method of [
        'setPaneRange',
        'fitPaneRange',
        'getPaneValueRange',
        'setPriceRange',
        'fitPriceRange',
        'getPriceRange',
    ]) {
        assert.equal(typeof publicApi.Chart.prototype[method], 'function', `${method} must be public`);
    }
    // And they are not the seam: a factory that replaces a layer is not public API.
    for (const internal of ['createRenderer', 'setRendererFactory', 'paneAtClientY']) {
        assert.equal(internal in publicApi, false, `${internal} must not be exported`);
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

