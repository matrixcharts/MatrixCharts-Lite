// Chart-level tests for switching the candlestick style.
//
// The data layer holds persistent geometry: `drawLine` and `drawArea` upload buffers and
// `clearLine` and `clearArea` are how they are emptied. Nothing empties them implicitly,
// so whoever owns the style owns the clearing. This file is about whether it did.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createHeadlessChart, flatCandles } = require('./support/headlessChart.cjs');

/** The data-layer calls recorded since `mark`, by name. */
function since(dataRenderer, mark) {
    return dataRenderer.calls.slice(mark).map(([name]) => name);
}

function chart() {
    const harness = createHeadlessChart();
    harness.chart.setData(flatCandles(60));
    harness.flush();
    return harness;
}

test('switching to candles clears the line and the area fill behind it', () => {
    // Reported from the demo: switch to area, switch back to candlesticks, and the fill is
    // still there underneath. The two directions of the switch were not symmetric — moving
    // to a line cleared the candle series, and moving back cleared nothing — so the
    // geometry of whichever style was last drawn stayed on the GPU until something else
    // happened to overwrite it.
    for (const from of ['line', 'area']) {
        const harness = chart();
        try {
            let mark = harness.dataRenderer.calls.length;
            harness.chart.applyOptions({ candlestick: { style: from } });
            harness.flush();
            const drawn = since(harness.dataRenderer, mark);
            assert.ok(drawn.includes(from === 'line' ? 'drawLine' : 'drawArea'),
                `${from} should have drawn its geometry, got ${drawn.join(',')}`);

            mark = harness.dataRenderer.calls.length;
            harness.chart.applyOptions({ candlestick: { style: 'candlestick' } });
            harness.flush();
            const after = since(harness.dataRenderer, mark);
            assert.ok(after.includes('drawCandlesticks'), `candlesticks were not drawn: ${after.join(',')}`);
            assert.ok(after.includes('clearLine'),
                `${from} -> candlestick left the line on the GPU: ${after.join(',')}`);
            if (from === 'area') {
                assert.ok(after.includes('clearArea'),
                    `area -> candlestick left the fill on the GPU: ${after.join(',')}`);
            }
        } finally {
            harness.dispose();
        }
    }
});

test('switching to a line clears the candle bodies and any fill', () => {
    // The direction that already worked, pinned so it cannot regress while the other is
    // fixed. `clearArea` matters here too: a chart that was last showing an area and is
    // switched to a line must drop the fill, or the line is drawn over a stale silhouette.
    for (const to of ['line', 'area']) {
        const harness = chart();
        try {
            harness.chart.applyOptions({ candlestick: { style: 'area' } });
            harness.flush();
            harness.chart.applyOptions({ candlestick: { style: 'candlestick' } });
            harness.flush();

            let mark = harness.dataRenderer.calls.length;
            harness.chart.applyOptions({ candlestick: { style: to } });
            harness.flush();
            const calls = since(harness.dataRenderer, mark);
            assert.ok(calls.includes('clearCandlesticks'),
                `${to} left the candle bodies on the GPU: ${calls.join(',')}`);
            // Only a bare line needs the fill cleared; switching *to* an area draws one, and
            // a clear afterwards would be undone by the draw in the same frame.
            if (to === 'line') {
                assert.ok(calls.includes('clearArea'), `${to} left a stale fill behind: ${calls.join(',')}`);
            }
            assert.ok(calls.includes(to === 'line' ? 'drawLine' : 'drawArea'),
                `${to} drew nothing: ${calls.join(',')}`);
        } finally {
            harness.dispose();
        }
    }
});

test('every style switch clears whatever the next style will not draw', () => {
    // The whole matrix, because the defect is a missing edge and a matrix is the only
    // thing that enumerates all of them. It is stated as a rule rather than as a list of
    // pairs, because the rule is the thing worth pinning: every one of `drawCandlesticks`,
    // `drawLine` and `drawArea` *replaces* the pass list of the series it draws, so the
    // only geometry that can survive a frame is geometry belonging to a series this frame
    // never drew. That is what has to be cleared, and it is what was not.
    const CANDLES = new Set(['candlestick', 'hollow', 'ohlc', 'baseline']);
    const draws = (style) => ({
        candles: CANDLES.has(style),
        line: style === 'line' || style === 'area',
        area: style === 'area',
    });
    const styles = [...CANDLES, 'line', 'area'];

    for (const from of styles) {
        for (const to of styles) {
            if (from === to) continue;
            const harness = chart();
            try {
                harness.chart.applyOptions({ candlestick: { style: from } });
                harness.flush();
                let mark = harness.dataRenderer.calls.length;
                harness.chart.applyOptions({ candlestick: { style: to } });
                harness.flush();
                const calls = since(harness.dataRenderer, mark);
                const next = draws(to);

                if (!next.candles) {
                    assert.ok(calls.includes('clearCandlesticks'),
                        `${from} -> ${to} left candle bodies behind: ${calls.join(',')}`);
                }
                if (!next.line) {
                    assert.ok(calls.includes('clearLine'),
                        `${from} -> ${to} left the line behind: ${calls.join(',')}`);
                }
                if (!next.area) {
                    assert.ok(calls.includes('clearArea'),
                        `${from} -> ${to} left the fill behind: ${calls.join(',')}`);
                }
            } finally {
                harness.dispose();
            }
        }
    }
});

test('the four candle styles are handled identically, since they share one branch', () => {
    // hollow, ohlc and baseline differ from candlestick only in the geometry they build,
    // never in the branch that clears, so a fix applied to `candlestick` reaches all four.
    // Asserted so that a future style that needs its own branch has to say so.
    for (const style of ['candlestick', 'hollow', 'ohlc', 'baseline']) {
        const harness = chart();
        try {
            harness.chart.applyOptions({ candlestick: { style: 'area' } });
            harness.flush();
            let mark = harness.dataRenderer.calls.length;
            harness.chart.applyOptions({ candlestick: { style } });
            harness.flush();
            const calls = since(harness.dataRenderer, mark);
            assert.ok(calls.includes('clearArea'), `area -> ${style} left the fill: ${calls.join(',')}`);
            assert.ok(calls.includes('clearLine'), `area -> ${style} left the line: ${calls.join(',')}`);
        } finally {
            harness.dispose();
        }
    }
});
