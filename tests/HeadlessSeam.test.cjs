// Does the seam work at all? A Chart, in node, with no WebGL and no DOM.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHeadlessChart, flatCandles } = require('./support/headlessChart.cjs');

test('a Chart constructs in node with no WebGL and no real DOM', () => {
    const h = createHeadlessChart({ timeScale: { barSpacing: 12 } });
    try {
        assert.equal(typeof h.chart.getPriceRange, 'function');
        // Three layers were built, through the seam rather than the real renderers.
        const inits = h.rendererLog.filter((entry) => entry[1] === 'init').map((entry) => entry[0]);
        assert.deepEqual(inits, ['data', 'grid', 'ui']);
    } finally {
        h.dispose();
    }
});

test('setData and the price API work headlessly', () => {
    const h = createHeadlessChart({ timeScale: { barSpacing: 12 } });
    try {
        h.chart.setData(flatCandles(50, { start: 100, step: 0.5 }));
        h.flush();
        const [low, high] = h.chart.getPriceRange();
        assert.ok(Number.isFinite(low) && Number.isFinite(high), 'range must be finite');
        assert.ok(high > low, `expected an ordered range, got [${low}, ${high}]`);
    } finally {
        h.dispose();
    }
});

test('a restored data context rebuilds the data renderer from retained chart state', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(flatCandles(50));
        h.flush();
        const dataCanvas = h.wrapper.children[1];
        dataCanvas.dispatch('webglcontextlost', { preventDefault() {} });
        h.chart.appendData(flatCandles(1, { from: 1_700_000_000_000 + 50 * 60_000 } )[0]);
        h.flush();
        dataCanvas.dispatch('webglcontextrestored', {});
        h.flush();

        const dataInits = h.rendererLog.filter((entry) => entry[0] === 'data' && entry[1] === 'init');
        assert.equal(dataInits.length, 2, 'restoration did not recreate the data renderer');
        assert.equal(h.chart.getCandleCount(), 51, 'data received during context loss was dropped');
        assert.ok(h.dataRenderer.calls.some((entry) => entry[0] === 'drawCandlesticks'),
            'restoration did not replay candle geometry');
    } finally {
        h.dispose();
    }
});
