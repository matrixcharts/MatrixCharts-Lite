// Pure tests for src/core/panes.ts. The layout invariant — panes exactly cover
// the plot, with no seam and no overlap — is what every rendered pane depends on,
// and it is worth pinning down without a browser.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    fitPaneTransform,
    niceStep,
    paneRects,
    paneTickStep,
    paneValueAt,
    paneValueSpan,
    resolvePaneOptions,
    visibleOverlayRange,
} = require('../.test-build/core/panes.js');
const { resolveOverlays } = require('../.test-build/core/overlays.js');
const { resolveOptions } = require('../.test-build/core/options.js');

const plot = (width, height) => ({ x: 0, y: 0, width, height });
const rects = (weights, plotRect = plot(800, 600), separator = 1) =>
    paneRects(plotRect, weights, separator);

test('a single pane is the plot area exactly', () => {
    // The no-panes case has to be bit-identical to the existing behaviour, or
    // every existing chart changes shape by being recompiled.
    assert.deepEqual(rects([1]), [{ x: 0, y: 0, width: 800, height: 600 }]);
});

test('a single pane ignores the separator', () => {
    // One pane has nothing to separate from, so reserving space would just shrink
    // the chart.
    assert.deepEqual(rects([1], plot(800, 600), 8), [{ x: 0, y: 0, width: 800, height: 600 }]);
});

test('panes stack top to bottom and exactly cover the plot', () => {
    // The invariant: the stack starts at the plot's top, ends at its bottom, and
    // consecutive rects touch without a gap or an overlap. A gap is a stripe of
    // background through the middle of the chart.
    for (const weights of [[1], [1, 1], [3, 1], [1, 2, 3], [5, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1]]) {
        for (const separator of [0, 1, 3]) {
            const stacked = rects(weights, plot(800, 601), separator);
            assert.equal(stacked.length, weights.length);
            assert.equal(stacked[0].y, 0, `weights ${weights}: does not start at the top`);
            const bottom = stacked[stacked.length - 1];
            assert.equal(bottom.y + bottom.height, 601,
                `weights ${weights} separator ${separator}: does not reach the bottom`);
            for (let i = 1; i < stacked.length; i++) {
                assert.equal(stacked[i].y - (stacked[i - 1].y + stacked[i - 1].height), separator,
                    `weights ${weights} separator ${separator}: pane ${i} does not abut pane ${i - 1}`);
            }
            for (const r of stacked) {
                assert.ok(Number.isInteger(r.y), 'a pane boundary is not a whole pixel');
                assert.ok(Number.isInteger(r.height), 'a pane extent is not a whole pixel');
                assert.equal(r.x, 0);
                assert.equal(r.width, 800);
            }
        }
    }
});

test('a pane keeps the plot origin rather than starting at zero', () => {
    // A plot that does not start at the canvas origin — because a gutter is
    // reserved — must be divided, not overwritten.
    const inset = { x: 78, y: 4, width: 700, height: 596 };
    const stacked = paneRects(inset, [1, 1], 1);
    assert.equal(stacked[0].x, 78);
    assert.equal(stacked[0].y, 4);
    assert.equal(stacked[0].width, 700);
    assert.equal(stacked[stacked.length - 1].y + stacked[stacked.length - 1].height, 600);
});

test('weights are relative, not absolute pixels', () => {
    // Within a pixel, because boundaries are snapped: an exact 3:1 split of an
    // awkward height cannot land on whole pixels, and rounding it to a half
    // pixel would reintroduce the seam.
    const [top, bottom] = rects([3, 1]);
    assert.ok(Math.abs(bottom.height - top.height / 3) <= 1,
        `expected roughly 3:1, got ${top.height}:${bottom.height}`);
    // Doubling the weight doubles the pane, which is the property being claimed.
    const [wide] = rects([2, 1]);
    const [tall] = rects([4, 1]);
    assert.ok(tall.height > wide.height);
});

test('a collapsed plot yields one empty rect per pane rather than throwing', () => {
    // Every index into the pane table has to stay valid. Throwing here would take
    // down a frame for a chart that is merely too small to draw.
    const stacked = paneRects(plot(800, 0), [1, 1, 1], 1);
    assert.equal(stacked.length, 3);
    for (const r of stacked) assert.equal(r.height, 0);
    const zeroWidth = paneRects(plot(0, 600), [1, 1], 1);
    assert.equal(zeroWidth.length, 2);
    assert.equal(zeroWidth[0].width, 0);
});

test('more separators than the plot can hold does not go negative', () => {
    const stacked = paneRects(plot(800, 3), [1, 1, 1, 1], 1);
    assert.equal(stacked.length, 4);
    for (const r of stacked) assert.ok(r.height >= 0, 'a pane has negative height');
    assert.equal(stacked[stacked.length - 1].y + stacked[stacked.length - 1].height, 3);
});

test('pane options default to one full-height pane', () => {
    assert.deepEqual(resolvePaneOptions(undefined), { weights: [1], separatorHeight: 1 });
    assert.deepEqual(resolvePaneOptions({}), { weights: [1], separatorHeight: 1 });
});

test('bad pane options are rejected rather than repaired', () => {
    for (const weights of [[], [0], [-1], [1, 0], [1, Number.NaN], [1, Number.POSITIVE_INFINITY]]) {
        assert.throws(() => resolvePaneOptions({ weights }), /panes\.weights/,
            `weights ${JSON.stringify(weights)} was not rejected`);
    }
    assert.throws(() => resolvePaneOptions({ separatorHeight: -1 }), /panes\.separatorHeight/);
    assert.throws(() => resolvePaneOptions({ separatorHeight: Number.NaN }), /panes\.separatorHeight/);
});

test('a fitted transform puts the extremes on the pane edges and round-trips', () => {
    const rect = { x: 78, y: 300, width: 700, height: 200 };
    // Zero padding, so the mapping is exact rather than merely close. Compared
    // with an epsilon because a fit is a division and the round trip is another.
    const transform = fitPaneTransform(rect, 20, 80, 0);
    const near = (actual, expected, what) => assert.ok(
        Math.abs(actual - expected) < 1e-6,
        `${what}: expected ${expected}, got ${actual}`,
    );
    near(paneValueAt(transform, rect.y), 80, 'the maximum is not at the top edge');
    near(paneValueAt(transform, rect.y + rect.height), 20, 'the minimum is not at the bottom edge');
    near(paneValueAt(transform, rect.y + 100), 50, 'the midpoint does not round-trip');
    // And forward: the same y the viewport transform would produce.
    const y = transform.offsetY + 50 * transform.scaleY;
    near(y, rect.y + 100, 'the forward mapping disagrees with the inverse');
});

test('padding keeps content off the pane edges', () => {
    const rect = { x: 0, y: 0, width: 800, height: 200 };
    const transform = fitPaneTransform(rect, 20, 80, 0.1);
    assert.ok(paneValueAt(transform, 0) > 80, 'the maximum reaches the top edge despite padding');
    assert.ok(paneValueAt(transform, 200) < 20, 'the minimum reaches the bottom edge despite padding');
});

test('a flat or empty series gets a usable band instead of dividing by zero', () => {
    const rect = { x: 0, y: 0, width: 800, height: 200 };
    const flat = fitPaneTransform(rect, 50, 50);
    assert.ok(Number.isFinite(flat.scaleY) && flat.scaleY < 0, 'a flat series produced no usable scale');
    // The value it is flat at lands in the middle of the pane.
    const y = flat.offsetY + 50 * flat.scaleY;
    assert.ok(y > 0 && y < 200, `a flat series drew at y=${y}, outside its pane`);

    for (const bad of [[Number.NaN, 1], [1, Number.POSITIVE_INFINITY], [Number.NaN, Number.NaN]]) {
        const t = fitPaneTransform(rect, bad[0], bad[1]);
        assert.ok(Number.isFinite(t.scaleY) && Number.isFinite(t.offsetY), `non-finite range ${bad} survived`);
    }
});

test('a collapsed pane has a scale rather than an infinite one', () => {
    const t = fitPaneTransform({ x: 0, y: 40, width: 800, height: 0 }, 1, 2);
    assert.ok(Number.isFinite(t.scaleY));
    assert.equal(t.offsetY, 40);
});

test('the visible range of an overlay respects its coverage and the viewport', () => {
    const values = Float32Array.from({ length: 20 }, (_, i) => i);
    // Covered 5..19, viewport showing 8..13.
    assert.deepEqual(visibleOverlayRange(values, 5, 19, 8, 13), [8, 13]);
    // A viewport that runs off the start of the coverage clamps to it.
    assert.deepEqual(visibleOverlayRange(values, 5, 19, 0, 2), null);
    // A viewport past the end clamps to it.
    assert.deepEqual(visibleOverlayRange(values, 5, 19, 15, 100), [15, 19]);
    // A fractional viewport includes the bars it partially shows.
    assert.deepEqual(visibleOverlayRange(values, 0, 19, 4.5, 6.2), [4, 7]);
});

test('an overlay with no finite value in view has no range', () => {
    const values = Float32Array.from([Number.NaN, Number.NaN, 1, 2]);
    assert.equal(visibleOverlayRange(values, 0, 3, 0, 1), null);
    assert.deepEqual(visibleOverlayRange(values, 0, 3, 2, 3), [1, 2]);
});

test('panes default to one, and are created by declaring weights', () => {
    assert.equal(resolveOptions({}).panes.weights.length, 1);
    assert.equal(resolveOptions({ panes: { weights: [3, 1, 1] } }).panes.weights.length, 3);
    assert.deepEqual(resolveOptions({ panes: { weights: [3, 1] } }).panes.weights, [3, 1]);
});

test('a pane separator defaults to the grid colour and can be overridden', () => {
    // A pane division reading as part of the grid beats inventing new chrome.
    const themed = resolveOptions({ theme: 'dark' });
    assert.equal(themed.panes.separatorColor, resolveOptions({ theme: 'dark' }).grid.color);
    const custom = resolveOptions({ theme: 'dark', panes: { separatorColor: '#ff0000' } });
    assert.equal(custom.panes.separatorColor, '#ff0000');
});

test('pane options survive a theme change and a bad value changes nothing', () => {
    const base = resolveOptions({ panes: { weights: [2, 1], separatorHeight: 4 } });
    const dark = resolveOptions({ panes: { weights: [2, 1], separatorHeight: 4 } }, 'dark');
    assert.deepEqual(dark.panes.weights, [2, 1]);
    assert.equal(dark.panes.separatorHeight, 4);
    assert.equal(base.panes.weights.length, 2);
    assert.throws(() => resolveOptions({ panes: { weights: [1, -2] } }), /panes\.weights/);
});

const times = Array.from({ length: 16 }, (_, i) => Date.UTC(2025, 0, 1) + i * 60_000);
const color = () => [1, 0, 0, 1];
const points = (values, from = 0) => values.map((value, i) => ({ time: times[from + i], value }));

test('an overlay names the pane it was given, defaulting to the price pane', () => {
    const onPrice = resolveOverlays([{ id: 'a', points: points([1, 2]) }], times, color, undefined, 1);
    assert.equal(onPrice[0].pane, 0);
    const onSecond = resolveOverlays([{ id: 'a', points: points([1, 2]), pane: 1 }], times, color, undefined, 2);
    assert.equal(onSecond[0].pane, 1);
});

test('a pane value span is height over scale, not height times it', () => {
    // scaleY is pixels per value unit, so a pane 119px tall showing 45.1 units has
    // scaleY = -119/45.1. Multiplying instead of dividing reports 314 units for
    // that same pane, which is wrong by a factor of the pane's height and is
    // completely silent: a tick step chosen from it comes out too coarse and the
    // pane ends up with one label instead of several.
    const rect = { x: 0, y: 359, width: 800, height: 119 };
    // Fitted with no padding, so the pane shows exactly 32.3 to 77.4.
    const transform = fitPaneTransform(rect, 32.3, 77.4, 0);
    const reported = paneValueSpan(rect, transform);
    assert.ok(Math.abs(reported - 45.1) < 0.01, `expected 45.1, got ${reported.toFixed(1)}`);
    assert.ok(reported < 60, `a 45-unit pane reported a span of ${reported.toFixed(1)}`);
    assert.equal(paneValueSpan(rect, { scaleY: 0, offsetY: 0 }), 0);
    // And with the default padding, the reported span is the padded one.
    const padded = paneValueSpan(rect, fitPaneTransform(rect, 32.3, 77.4));
    assert.ok(padded > reported && padded < 60, `padded span was ${padded.toFixed(1)}`);
});

test('a short pane is guaranteed several labels, not one', () => {
    // The regression this pins: a 45-unit pane asked for a step of 21 snapped up
    // the 1/2/5 ladder to 50, which fits inside the range exactly once, so the axis
    // showed a single "50" on an RSI you could not read a level off.
    const step = paneTickStep(45.1, 56 / 2.639);
    const labels = [];
    for (let v = 32.3; v <= 77.4 + 1e-9; v += step) labels.push(v);
    assert.ok(labels.length >= 4, `a 45-unit pane got ${labels.length} labels at step ${step}`);
    assert.ok(labels.length <= 12, `a 45-unit pane got ${labels.length} labels at step ${step}`);
});

test('a tall pane still gets a coarse, readable step', () => {
    // The guarantee must not turn a full-height pane into a ladder of labels. The
    // pixel target is derived the way the renderer derives it — from the same scale
    // that produced the span — because a span and a pixel target chosen
    // independently describe two different panes.
    const rect = { x: 0, y: 0, width: 800, height: 500 };
    const transform = fitPaneTransform(rect, 0, 100000, 0);
    const step = paneTickStep(paneValueSpan(rect, transform), 56 / Math.abs(transform.scaleY));
    assert.ok(step >= 1000, `a 100000-unit span got step ${step}`);
    assert.ok(100000 / step <= 12, `a 100000-unit span got ${(100000 / step).toFixed(1)} ticks`);
});

test('a degenerate span still produces a usable step', () => {
    for (const span of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const step = paneTickStep(span, 1);
        assert.ok(Number.isFinite(step) && step > 0, `span ${span} produced step ${step}`);
    }
});

test('the tick step lands on round values', () => {
    for (const target of [0.5, 1, 2.5, 7, 11.3, 21.2, 45, 314, 1000]) {
        const step = niceStep(target);
        const normalized = step / Math.pow(10, Math.floor(Math.log10(step)));
        assert.ok([1, 2, 5, 10].includes(normalized), `niceStep(${target}) gave ${step}`);
    }
    assert.equal(niceStep(0), 1);
    assert.equal(niceStep(Number.NaN), 1);
});

test('an overlay naming a pane that was never declared is rejected', () => {
    // Silently drawing it on whichever pane now occupies that index would put an
    // RSI on the price scale, which is precisely the thing panes exist to prevent.
    assert.throws(
        () => resolveOverlays([{ id: 'rsi', points: points([1, 2]), pane: 1 }], times, color, undefined, 1),
        /the chart has 1 pane/,
    );
    assert.throws(
        () => resolveOverlays([{ id: 'rsi', points: points([1, 2]), pane: 5 }], times, color, undefined, 2),
        /the chart has 2 panes/,
    );
});

test('a pane index that is not a non-negative integer is rejected', () => {
    for (const pane of [-1, 1.5, Number.NaN, '1']) {
        assert.throws(
            () => resolveOverlays([{ id: 'a', points: points([1]), pane }], times, color, undefined, 4),
            /pane/,
            `pane ${pane} was not rejected`,
        );
    }
});

test('a pane index is checked before the data, so a typo is reported as a typo', () => {
    assert.throws(
        () => resolveOverlays([{ id: 'a', points: points([1]), pane: 9 }], times, color, undefined, 1),
        /is on pane 9/,
    );
});
