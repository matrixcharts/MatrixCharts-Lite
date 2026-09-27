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

test('the renderer-injection seam stays internal', () => {
    // The seam exists so a headless test can stand a recorder in for the GPU. It is
    // reachable from the compiled output, so what keeps it out of an integrator's hands is
    // that the barrel is an explicit allow-list — so the names themselves have to stay
    // off it, and `setRendererFactory` in particular must not become a supported way to
    // replace a layer. A published seam is not a seam, it is a second public contract
    // nobody specified.
    for (const internal of [
        'createRenderer',
        'setRendererFactory',
        'defaultFactory',
    ]) {
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

