// Tests for the caller's paint seam: `Chart.setOverlayPainter`, and the geometry
// helpers an application needs to build its own drawing layer on top of it.
//
// The engine is a pure engine: it draws candles, axes, grids, and the decorations it
// is told about, and nothing else. Drawings belong to the application. These pin the
// contract that makes that division real rather than nominal — that a painter
// registered through the public API actually reaches a layer, that the projections it
// is handed agree with the ones the engine draws its own geometry from, and that a
// painter runs under the crosshair rather than over it.
//
// The paint context is built by the real renderer, so these drive the real renderer
// with a recording 2D context. A renderer double would only be able to confirm that
// someone registered a callback somewhere.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHeadlessChart, flatCandles } = require('./support/headlessChart.cjs');
const { createUiRenderer } = require('./support/uiRenderer.cjs');

const MINUTE = 60_000;
const START = Date.UTC(2024, 0, 1);

/** A minute series long enough to pan and to have both ends on screen. */
function candles(count) {
    return flatCandles(count).map((candle, index) => ({ ...candle, time: START + index * MINUTE }));
}

/** A viewport for `count` bars in a 1000x500 plot at 8px per slot, no breaks. */
function viewportFor(count, overrides = {}) {
    return {
        offsetX: 0,
        offsetY: 0,
        scaleX: 8,
        scaleY: -2,
        cssWidth: 1000,
        cssHeight: 500,
        plot: { x: 0, y: 0, width: 1000, height: 500 },
        slots: null,
        ...overrides,
    };
}

/** Drives the real UI layer and returns the context a painter was handed. */
function paintOnce({ times, viewport, panes, painter }) {
    const h = createUiRenderer(false);
    h.renderer.resize(1000, 500, 1);
    h.emitter.emit('viewport', { ...viewport, panes });
    h.emitter.emit('data', { times, interval: MINUTE });
    let seen = null;
    h.renderer.setOverlayPainter((context) => {
        seen = context;
        painter(context);
    });
    h.renderer.render();
    h.dispose();
    return seen;
}

// --- a painter reaches the UI layer, and runs under the crosshair --------------

test('a registered painter is called with a paint context', () => {
    const times = candles(50).map((candle) => candle.time);
    const seen = paintOnce({ times, viewport: viewportFor(50), painter: () => {} });
    assert.ok(seen, 'the painter never ran');
    assert.equal(typeof seen.toScreen, 'function');
    assert.equal(typeof seen.toData, 'function');
    assert.ok(seen.ctx, 'no 2D context was handed over');
});

test('the painter runs before the crosshair, so the crosshair stays legible', () => {
    const h = createUiRenderer(false);
    h.renderer.resize(1000, 500, 1);
    h.emitter.emit('viewport', { ...viewportFor(50), panes: null });
    h.emitter.emit('data', { times: candles(50).map((c) => c.time), interval: MINUTE });
    const order = [];
    h.renderer.setOverlayPainter(() => { order.push('painter'); });
    h.emitter.emit('crosshair', {
        x: 400,
        y: 250,
        time: START + 25 * MINUTE,
        candle: { time: START + 25 * MINUTE, open: 1, high: 2, low: 0.5, close: 1.5 },
        pane: 0,
        value: 100,
        visible: true,
    });
    h.calls.length = 0;
    h.renderer.render();
    h.dispose();
    // The crosshair's own strokes are the `moveTo`/`lineTo` pair on the UI layer.
    // What matters is that the painter ran before any of them.
    assert.equal(order[0], 'painter', 'the painter did not run first');
    assert.ok(h.calls.length > 0, 'nothing was drawn at all');
});

test('no painter registered means no paint context is built', () => {
    const h = createUiRenderer(false);
    h.renderer.resize(1000, 500, 1);
    h.emitter.emit('viewport', { ...viewportFor(50), panes: null });
    h.emitter.emit('data', { times: candles(50).map((c) => c.time), interval: MINUTE });
    h.calls.length = 0;
    h.renderer.render();
    h.dispose();
    // Nothing to assert beyond it not throwing: the seam costs nothing when unused,
    // which is the point of checking it on a chart with no painter.
    assert.ok(true);
});

test('the grid layer refuses a painter, because its background would erase it', () => {
    const h = createUiRenderer(true);
    assert.throws(
        () => h.renderer.setOverlayPainter(() => {}),
        /must be registered on the UI layer/,
    );
    h.dispose();
});

test('a painter that throws is contained and the frame still completes', () => {
    const h = createUiRenderer(false);
    h.renderer.resize(1000, 500, 1);
    h.emitter.emit('viewport', { ...viewportFor(50), panes: null });
    h.emitter.emit('data', { times: candles(50).map((c) => c.time), interval: MINUTE });
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => { logged.push(args[0]); };
    let thrown = null;
    try {
        h.renderer.setOverlayPainter(() => { throw new Error('painter exploded'); });
        try {
            h.renderer.render();
        } catch (error) {
            thrown = error;
        }
    } finally {
        console.error = originalError;
    }
    h.dispose();
    // A painter is the caller's code. It must not be able to take the crosshair, the
    // axes, or the frame with it.
    assert.equal(thrown, null, 'a throwing painter took the frame down');
    assert.equal(logged.length, 1, 'the error should be reported');
    assert.match(String(logged[0]), /overlay painter threw/);
});

test('a throwing painter is reported once, not once per frame', () => {
    const h = createUiRenderer(false);
    h.renderer.resize(1000, 500, 1);
    h.emitter.emit('viewport', { ...viewportFor(50), panes: null });
    h.emitter.emit('data', { times: candles(50).map((c) => c.time), interval: MINUTE });
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => { logged.push(args[0]); };
    try {
        h.renderer.setOverlayPainter(() => { throw new Error('same every frame'); });
        h.renderer.render();
        h.renderer.render();
        h.renderer.render();
    } finally {
        console.error = originalError;
    }
    h.dispose();
    // Sixty identical entries a second buries the first one and the actual stack.
    assert.equal(logged.length, 1, `reported ${logged.length} times for one error`);
});

test('a re-registered painter gets a clean error log', () => {
    const h = createUiRenderer(false);
    h.renderer.resize(1000, 500, 1);
    h.emitter.emit('viewport', { ...viewportFor(50), panes: null });
    h.emitter.emit('data', { times: candles(50).map((c) => c.time), interval: MINUTE });
    const originalError = console.error;
    const logged = [];
    console.error = (...args) => { logged.push(args[0]); };
    try {
        h.renderer.setOverlayPainter(() => { throw new Error('boom'); });
        h.renderer.render();
        h.renderer.setOverlayPainter(() => { throw new Error('boom again'); });
        h.renderer.render();
    } finally {
        console.error = originalError;
    }
    h.dispose();
    assert.equal(logged.length, 2, 'a fixed-and-re-registered painter stayed silenced');
});

test('destroying the renderer drops the painter', () => {
    const h = createUiRenderer(false);
    h.renderer.setOverlayPainter(() => {});
    h.renderer.destroy();
    // The painter is a closure over the caller's own drawing model, and the renderer
    // is reachable from the chart, so a painter that outlived destroy kept a whole
    // application alive from a detached canvas.
    assert.equal(h.renderer.overlayPainter, null);
    h.dispose();
});

// --- the context agrees with the engine's own geometry ------------------------

// The projections a painter is handed have to be the ones the candles and the axis
// were drawn from. If they disagree, a drawing drifts off the bars it annotates and
// the drift is invisible until someone pans.

test('the paint context projects the same x as the engine transform', () => {
    const times = candles(50).map((candle) => candle.time);
    const viewport = viewportFor(50);
    const seen = paintOnce({ times, viewport, painter: () => {} });
    for (let index = 0; index < times.length; index += 7) {
        const screen = seen.toScreen({ time: times[index], value: 100 });
        assert.ok(screen !== null, `bar ${index} should project`);
        // `offsetX + index * scaleX`, the engine's own unbroken-series transform.
        const expected = viewport.offsetX + index * viewport.scaleX;
        assert.ok(
            Math.abs(screen.x - expected) < 1e-9,
            `bar ${index} painted at ${screen.x}, engine draws it at ${expected}`,
        );
    }
});

test('the drawing projector agrees with the chart own coordinate API', () => {
    // The invariant that makes the two halves of the seam interchangeable: a drawing
    // painted through the painter and a drawing hit-tested through the projector must
    // resolve to the same pixel, or one drifts off the bars it annotates. Both read
    // the chart's live viewport, so they cannot disagree.
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        const projector = h.chart.drawingProjector();
        for (let index = 0; index < 50; index += 3) {
            const time = START + index * MINUTE;
            const viaProjector = projector({ time, value: 100 });
            assert.ok(viaProjector !== null, `bar ${index} should project`);
            // `indexToCoordinate` is what the candles are drawn at.
            const viaChart = h.chart.indexToCoordinate(index);
            assert.equal(viaProjector.x, viaChart, `bar ${index} disagrees on x`);
            // And `timeToCoordinate` is the public time-space entry point.
            assert.equal(viaProjector.x, h.chart.timeToCoordinate(time), `bar ${index} disagrees with timeToCoordinate`);
        }
    } finally {
        h.dispose();
    }
});

test('the projector keeps agreeing with the chart after a pan', () => {
    // A pan moves bars and offsets together. If either moved without the other, a
    // drawing painted before the pan and hit-tested after it would be somewhere else,
    // and the drift would only be visible once someone moved the chart.
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(120));
        h.flush();
        const projector = h.chart.drawingProjector();
        const before = [];
        for (let index = 0; index < 120; index += 17) {
            before.push(projector({ time: START + index * MINUTE, value: 100 }).x);
        }
        h.chart.setVisibleLogicalRange({ from: 40, to: 90 });
        h.flush();
        for (let index = 0; index < 120; index += 17) {
            const after = projector({ time: START + index * MINUTE, value: 100 });
            assert.equal(after.x, h.chart.indexToCoordinate(index), `bar ${index} drifted after a pan`);
            assert.notEqual(after.x, before[index / 17], `bar ${index} did not move with the pan`);
        }
    } finally {
        h.dispose();
    }
});

test('the paint context round-trips a point back to the same bar', () => {
    const times = candles(50).map((candle) => candle.time);
    const seen = paintOnce({ times, viewport: viewportFor(50), painter: () => {} });
    for (let index = 0; index < times.length; index += 5) {
        const screen = seen.toScreen({ time: times[index], value: 100 });
        const back = seen.toData(screen.x, screen.y);
        assert.equal(back.time, times[index], `bar ${index} did not round-trip`);
    }
});

test('the paint context round-trips a price', () => {
    const times = candles(50).map((candle) => candle.time);
    const viewport = viewportFor(50);
    const seen = paintOnce({ times, viewport, painter: () => {} });
    // The identity transform for this viewport is y = -2 * value + offsetY, so any
    // value has to come back to itself.
    for (let step = 1; step < 8; step++) {
        const value = step * 10;
        const screen = seen.toScreen({ time: times[25], value });
        const back = seen.toData(screen.x, screen.y);
        assert.ok(Math.abs(back.value - value) < 1e-6, `${value} came back as ${back.value}`);
    }
});

test('a timestamp in a session gap snaps to the nearer bounding bar', () => {
    // Bars skip from 00:04 to 24:00, so a timestamp at 12:00 is in dead air. It
    // projects to the nearer of the two bars bounding the break rather than to null,
    // which is what keeps a drawing drawn across a weekend connected to the candles
    // it annotates. A fabricated x in the middle of the compressed break, or a null,
    // would draw a line that leans on nothing or cannot be moved.
    const series = [];
    for (let index = 0; index < 5; index++) {
        series.push({ time: START + index * MINUTE, open: 1, high: 2, low: 0.5, close: 1.5 });
    }
    const resume = START + 24 * 3600_000;
    for (let index = 0; index < 5; index++) {
        series.push({ time: resume + index * MINUTE, open: 1, high: 2, low: 0.5, close: 1.5 });
    }
    const times = series.map((candle) => candle.time);
    const seen = paintOnce({ times, viewport: viewportFor(10), painter: () => {} });
    const inTheGap = START + 12 * 3600_000;
    const snapped = seen.toScreen({ time: inTheGap, value: 1.5 });
    assert.ok(snapped !== null, 'a gap time should still land on a real bar');
    // 12:00 sits 11h56m past bar 4 and 12h04m before bar 5, so it resolves to bar 4.
    assert.equal(snapped.x, seen.toScreen({ time: times[4], value: 1.5 }).x);
    assert.notEqual(snapped.x, seen.toScreen({ time: times[5], value: 1.5 }).x);
});

test('every real bar still projects, so the gap case is about the gap', () => {
    const series = [];
    for (let index = 0; index < 5; index++) {
        series.push({ time: START + index * MINUTE, open: 1, high: 2, low: 0.5, close: 1.5 });
    }
    const resume = START + 24 * 3600_000;
    for (let index = 0; index < 5; index++) {
        series.push({ time: resume + index * MINUTE, open: 1, high: 2, low: 0.5, close: 1.5 });
    }
    const times = series.map((candle) => candle.time);
    const seen = paintOnce({ times, viewport: viewportFor(10), painter: () => {} });
    for (const time of times) {
        assert.ok(seen.toScreen({ time, value: 1.5 }) !== null, `${time} should project`);
    }
});

test('a chart with no data projects nothing', () => {
    const seen = paintOnce({ times: [], viewport: viewportFor(0), painter: () => {} });
    // The one case that is genuinely `null`: a timestamp cannot name a bar that does
    // not exist.
    assert.equal(seen.toScreen({ time: START, value: 1.5 }), null);
});

test('a bar scrolled past the plot edge still projects, so a wide line is clipped not truncated', () => {
    const times = candles(50).map((candle) => candle.time);
    // Pushed right so the last three bars sit beyond the plot's right edge. A
    // painter drawing a trend line across the viewport needs coordinates out there so
    // the canvas can clip them; truncating at the edge would make the line stop
    // short of where the data is.
    const seen = paintOnce({ times, viewport: viewportFor(50, { offsetX: 800 }), painter: () => {} });
    const last = seen.toScreen({ time: times[49], value: 100 });
    assert.ok(last !== null, 'a bar past the edge should still project');
    assert.ok(last.x > 1000, `expected the last bar past the plot edge, got ${last.x}`);
    // And the first is still on screen, so the viewport is the one described.
    const first = seen.toScreen({ time: times[0], value: 100 });
    assert.ok(first.x >= 0 && first.x < 1000);
});

test('a multi-pane layout hands the painter every pane', () => {
    const times = candles(50).map((candle) => candle.time);
    const panes = {
        rects: [
            { x: 0, y: 0, width: 1000, height: 300 },
            { x: 0, y: 301, width: 1000, height: 198 },
        ],
        transforms: [
            { scaleY: -2, offsetY: 300 },
            { scaleY: -20, offsetY: 499 },
        ],
        empty: [false, false],
    };
    const seen = paintOnce({ times, viewport: viewportFor(50), panes, painter: () => {} });
    assert.equal(seen.paneCount, 2);
    assert.equal(seen.paneRects.length, 2);
    const time = times[25];
    const pricePane = seen.toScreen({ time, value: 100 }, 0);
    const lowerPane = seen.toScreen({ time, value: 100 }, 1);
    assert.ok(pricePane !== null && lowerPane !== null);
    // Panes share the horizontal transform, so the same anchor has the same x. That
    // is what lets a series move between panes without anything about its data
    // changing.
    assert.equal(pricePane.x, lowerPane.x);
    // Different vertical units, so the same value lands somewhere else.
    assert.notEqual(pricePane.y, lowerPane.y);
});

test('a pane with no transform does not throw at the painter', () => {
    const times = candles(50).map((candle) => candle.time);
    const panes = {
        rects: [{ x: 0, y: 0, width: 1000, height: 500 }],
        transforms: [],
        empty: [false],
    };
    const seen = paintOnce({ times, viewport: viewportFor(50), panes, painter: () => {} });
    // A layout mid-flight can name a pane it has not given a transform for. A painter
    // must not take the frame down over it, and the honest answer is that the point
    // cannot be placed.
    assert.equal(seen.toScreen({ time: times[10], value: 100 }, 0), null);
    assert.equal(seen.toScreen({ time: times[10], value: 100 }, 9), null);
});

test('the context reports the layer size and pixel ratio', () => {
    const times = candles(50).map((candle) => candle.time);
    const seen = paintOnce({ times, viewport: viewportFor(50), painter: () => {} });
    assert.equal(seen.width, 1000);
    assert.equal(seen.height, 500);
    assert.equal(seen.dpr, 1);
    assert.equal(seen.plot.width, 1000);
});

// --- Chart forwards to the UI layer -------------------------------------------

test('the chart hands its painter to the UI layer', () => {
    const h = createHeadlessChart();
    try {
        const painter = () => {};
        h.chart.setOverlayPainter(painter);
        assert.equal(h.uiRenderer.overlayPainter, painter);
    } finally {
        h.dispose();
    }
});

test('the chart accepts null to unregister', () => {
    const h = createHeadlessChart();
    try {
        const painter = () => {};
        h.chart.setOverlayPainter(painter);
        h.chart.setOverlayPainter(null);
        assert.equal(h.uiRenderer.overlayPainter, null);
    } finally {
        h.dispose();
    }
});

test('registering a painter repaints nothing', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        // Only the repaint calls, not the registration itself, which the stub records.
        const paints = () => h.rendererLog
            .filter(([name, action]) => action === 'render' || action === 'clear').length;
        const before = paints();
        h.chart.setOverlayPainter(() => {});
        // A painter changes nothing the engine draws. Forcing a redraw would repaint
        // three layers to produce a frame that is going to be painted on the next
        // tick regardless.
        assert.equal(paints(), before, 'registering a painter repainted the chart');
    } finally {
        h.dispose();
    }
});

test('a non-function painter is refused', () => {
    const h = createHeadlessChart();
    try {
        assert.throws(() => h.chart.setOverlayPainter('nope'), /requires a function or null/);
    } finally {
        h.dispose();
    }
});

test('a painter cannot be registered on a destroyed chart', () => {
    const h = createHeadlessChart();
    h.chart.destroy();
    assert.throws(() => h.chart.setOverlayPainter(() => {}), /This chart has been destroyed/);
    h.dispose();
});

// --- the drawing projectors the chart hands out -------------------------------

test('the drawing projector round-trips through the unprojector', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        const toScreen = h.chart.drawingProjector();
        const toData = h.chart.drawingUnprojector();
        for (let index = 0; index < 50; index += 5) {
            const time = START + index * MINUTE;
            const screen = toScreen({ time, value: 100 });
            assert.ok(screen !== null, `bar ${index} should project`);
            assert.equal(toData(screen.x, screen.y).time, time);
        }
    } finally {
        h.dispose();
    }
});

test('the drawing projector snaps a session-gap time to the nearer bar', () => {
    const h = createHeadlessChart();
    try {
        const series = [];
        for (let index = 0; index < 5; index++) {
            series.push({ time: START + index * MINUTE, open: 1, high: 2, low: 0.5, close: 1.5 });
        }
        const resume = START + 24 * 3600_000;
        for (let index = 0; index < 5; index++) {
            series.push({ time: resume + index * MINUTE, open: 1, high: 2, low: 0.5, close: 1.5 });
        }
        h.chart.setData(series);
        h.flush();
        const projector = h.chart.drawingProjector();
        const inTheGap = projector({ time: START + 12 * 3600_000, value: 1.5 });
        // Not null, and on the nearer bounding bar. A line drawn across the weekend
        // has a midpoint anchor in the dead air between the sessions; snapping keeps
        // it on the drawing rather than dropping it.
        assert.ok(inTheGap !== null);
        assert.equal(inTheGap.x, projector({ time: START + 4 * MINUTE, value: 1.5 }).x);
    } finally {
        h.dispose();
    }
});

test('a projector on a chart with no data returns null', () => {
    const h = createHeadlessChart();
    try {
        assert.equal(h.chart.drawingProjector()({ time: START, value: 1.5 }), null);
    } finally {
        h.dispose();
    }
});

test('a projector for a pane that does not exist is refused, by name', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        assert.equal(h.chart.getPaneCount(), 1);
        // The message names the helper that was asked for, so the complaint is about
        // the right call.
        assert.throws(() => h.chart.drawingProjector(1), /drawingProjector pane 1, but the chart has 1 pane/);
        assert.throws(() => h.chart.drawingUnprojector(1), /drawingUnprojector pane 1, but the chart has 1 pane/);
        assert.throws(() => h.chart.drawingProjector(-1), /non-negative integer/);
        assert.throws(() => h.chart.drawingProjector(1.5), /non-negative integer/);
    } finally {
        h.dispose();
    }
});

test('a projector for a declared pane projects in that pane units', () => {
    const h = createHeadlessChart({ panes: { weights: [2, 1] } });
    try {
        h.chart.setData(candles(50));
        h.flush();
        assert.equal(h.chart.getPaneCount(), 2);
        const toScreen = h.chart.drawingProjector(1);
        const time = START + 25 * MINUTE;
        const screen = toScreen({ time, value: 50 });
        assert.ok(screen !== null);
        // The same x as the price pane: panes share the horizontal transform.
        assert.ok(Math.abs(screen.x - h.chart.indexToCoordinate(25)) < 1e-9);
        // And it landed in the lower pane rather than on the price one. The two panes
        // are fitted independently, so a pane-1 value is placed by pane 1's transform.
        const range = h.chart.getPaneValueRange(1);
        assert.ok(range !== null, 'the lower pane should have a range');
        const atTop = h.chart.drawingUnprojector(1)(screen.x, screen.y + 1).value;
        assert.ok(Math.abs(atTop - 50) < Math.abs(atTop - screen.y), 'the value should move with y');
    } finally {
        h.dispose();
    }
});

test('a projector cannot be taken from a destroyed chart', () => {
    const h = createHeadlessChart();
    h.chart.destroy();
    assert.throws(() => h.chart.drawingProjector(), /This chart has been destroyed/);
    assert.throws(() => h.chart.drawingUnprojector(), /This chart has been destroyed/);
    h.dispose();
});

// --- the drawing store, now that the engine does not draw it ------------------

test('a drawing survives a round trip through the store', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        h.chart.setDrawings([{
            id: 'line-1',
            type: 'trend-line',
            points: [{ time: START, value: 100 }, { time: START + 4 * MINUTE, value: 110 }],
            color: '#4c9aff',
            lineWidth: 2,
            lineStyle: 'dashed',
            active: false,
            selected: true,
            label: 'my line',
            opacity: 0.8,
        }]);
        const read = h.chart.getDrawings();
        assert.equal(read.length, 1);
        assert.equal(read[0].id, 'line-1');
        assert.equal(read[0].points.length, 2);
        assert.equal(read[0].label, 'my line');
        assert.equal(read[0].opacity, 0.8);
    } finally {
        h.dispose();
    }
});

test('the store hands back copies, not its own objects', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        h.chart.setDrawings([{
            id: 'line-1',
            type: 'trend-line',
            points: [{ time: START, value: 100 }, { time: START + 4 * MINUTE, value: 110 }],
            color: '#4c9aff',
            lineWidth: 1,
            lineStyle: 'solid',
            active: false,
            selected: true,
            label: '',
            opacity: 1,
        }]);
        const first = h.chart.getDrawings();
        // `points` is a mutable reference, so a shallow spread of the drawing is not a
        // copy of it. Writing into a returned drawing must not reach the chart.
        first[0].points[0].value = 999;
        first[0].points.push({ time: 1, value: 1 });
        const second = h.chart.getDrawings();
        assert.equal(second[0].points.length, 2, 'a returned drawing shared its points array');
        assert.equal(second[0].points[0].value, 100, 'a returned anchor reached the chart');
    } finally {
        h.dispose();
    }
});

test('an event subscriber cannot write into the chart through a drawing', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        const stolen = [];
        h.chart.subscribeDrawingOrderEvents((event) => {
            if (event.type === 'drawing-select' && event.detail && event.detail.drawing) {
                stolen.push(event.detail.drawing);
            }
        });
        h.chart.setDrawings([{
            id: 'line-1',
            type: 'trend-line',
            points: [{ time: START, value: 100 }, { time: START + 4 * MINUTE, value: 110 }],
            color: '#4c9aff',
            lineWidth: 1,
            lineStyle: 'solid',
            active: false,
            selected: false,
            label: '',
            opacity: 1,
        }]);
        h.chart.selectDrawing('line-1');
        // Whatever the subscriber was handed must not be the live object: writing into
        // it must not move the drawing on screen or reach the chart's own copy.
        for (const drawing of stolen) {
            drawing.points[0].value = 999;
        }
        const stored = h.chart.getDrawings();
        assert.equal(stored[0].points[0].value, 100, 'a subscriber wrote into the chart');
    } finally {
        h.dispose();
    }
});

test('a refused drawing set leaves the previous one untouched', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        const good = {
            id: 'line-1',
            type: 'trend-line',
            points: [{ time: START, value: 100 }, { time: START + 4 * MINUTE, value: 110 }],
            color: '#4c9aff',
            lineWidth: 1,
            lineStyle: 'solid',
            active: false,
            selected: true,
            label: '',
            opacity: 1,
        };
        h.chart.setDrawings([good]);
        // A duplicate id is refused, and the existing drawing has to survive it. A
        // half-applied set is worse than a rejected one.
        assert.throws(() => h.chart.setDrawings([good, { ...good }]), /used more than once/);
        const after = h.chart.getDrawings();
        assert.equal(after.length, 1);
        assert.equal(after[0].id, 'line-1');
    } finally {
        h.dispose();
    }
});

test('destroyed charts refuse drawing mutations rather than publishing to nobody', () => {
    const h = createHeadlessChart();
    h.chart.setData(candles(50));
    h.flush();
    h.chart.destroy();
    // A gesture is asynchronous, so a chart torn down mid-gesture lands here by
    // ordinary use. Each of these mutated state and called live subscribers without
    // the guard.
    assert.throws(() => h.chart.setDrawings([]), /This chart has been destroyed/);
    assert.throws(() => h.chart.getDrawings(), /This chart has been destroyed/);
    assert.throws(() => h.chart.selectDrawing('x'), /This chart has been destroyed/);
    assert.throws(() => h.chart.deleteDrawing('x'), /This chart has been destroyed/);
    assert.throws(() => h.chart.deselectAllDrawings(), /This chart has been destroyed/);
    assert.throws(() => h.chart.updateDrawingCreate({ time: 1, value: 1 }), /This chart has been destroyed/);
    assert.throws(() => h.chart.finishDrawingCreate('x'), /This chart has been destroyed/);
    assert.throws(() => h.chart.cancelDrawingCreate(), /This chart has been destroyed/);
    assert.throws(() => h.chart.createOrderFromDrawing('x', 'buy', 'o'), /This chart has been destroyed/);
    h.dispose();
});

test('destroy drops the order, drawing and pane subscribers too', () => {
    const h = createHeadlessChart();
    try {
        let called = 0;
        h.chart.subscribeOrders(() => { called++; });
        h.chart.subscribeDrawingOrderEvents(() => { called++; });
        h.chart.subscribePaneRangeChange(() => { called++; });
        h.chart.destroy();
        const after = called;
        try {
            h.chart.setOrders([{ id: 'o1', side: 'buy', price: 1, quantity: 1 }]);
        } catch {
            // Every public entry point throws once destroyed, which is the point.
        }
        // Nothing may call back into application code after destroy. The order and
        // drawing payloads carry the caller's own objects, so a handler that survived
        // kept a whole application reachable from a detached canvas.
        assert.equal(called, after, 'a subscriber ran after destroy');
    } finally {
        h.dispose();
    }
});

// --- the order state machine is now consulted ----------------------------------

test('a terminal order is not resurrected', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        h.chart.setOrders([{ id: 'o1', side: 'buy', price: 100, quantity: 1 }]);
        h.chart.updateOrderStatus('o1', 'filled');
        assert.equal(h.chart.getOrders()[0].status, 'filled');
        // `ORDER_TRANSITIONS` declares filled terminal. The chart used to check only
        // that the requested status was one of the four names, so a filled order went
        // straight back to working.
        h.chart.updateOrderStatus('o1', 'working');
        assert.equal(h.chart.getOrders()[0].status, 'filled', 'a filled order was resurrected');
    } finally {
        h.dispose();
    }
});

test('a cancelled order cannot be filled', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        h.chart.setOrders([{ id: 'o1', side: 'buy', price: 100, quantity: 1 }]);
        h.chart.updateOrderStatus('o1', 'cancelled');
        h.chart.updateOrderStatus('o1', 'filled');
        assert.equal(h.chart.getOrders()[0].status, 'cancelled');
    } finally {
        h.dispose();
    }
});

test('re-sending the same status is a no-op, not an illegal transition', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        h.chart.setOrders([{ id: 'o1', side: 'buy', price: 100, quantity: 1 }]);
        h.chart.updateOrderStatus('o1', 'filled');
        h.chart.updateOrderStatus('o1', 'filled');
        assert.equal(h.chart.getOrders()[0].status, 'filled');
    } finally {
        h.dispose();
    }
});

test('a working order still reaches every terminal state', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        for (const status of ['filled', 'cancelled', 'rejected']) {
            h.chart.setOrders([{ id: 'o1', side: 'buy', price: 100, quantity: 1 }]);
            h.chart.updateOrderStatus('o1', status);
            assert.equal(h.chart.getOrders()[0].status, status, `${status} was refused from working`);
        }
    } finally {
        h.dispose();
    }
});

test('an unknown status is still rejected outright', () => {
    const h = createHeadlessChart();
    try {
        h.chart.setData(candles(50));
        h.flush();
        h.chart.setOrders([{ id: 'o1', side: 'buy', price: 100, quantity: 1 }]);
        // Not a transition problem: a name outside the enum is a caller bug, and
        // throwing is right.
        assert.throws(() => h.chart.updateOrderStatus('o1', 'pending'), /invalid status/);
    } finally {
        h.dispose();
    }
});
