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
