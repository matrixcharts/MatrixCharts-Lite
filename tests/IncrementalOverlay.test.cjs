// Tests for the incremental indicator path: `appendOverlayValue`,
// `appendOverlayValues`, `updateOverlayValue`, and the retention shift.
//
// The engine has a complete indicator *rendering* layer — per-pane scales, warm-up
// windows, exact bucket alignment with the candles — and until this path existed there
// was no way to feed it a value without re-supplying the whole series, which on a live
// feed is a reallocation and a full re-validation per tick. These tests pin the O(1)
// path, and pin the retention shift, which was silently wrong before: a chart that
// reached its retention cap drew every overlay on the wrong bars by exactly the trim
// count, with no visible symptom other than an indicator reading as stale.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHeadlessChart } = require('./support/headlessChart.cjs');

const MINUTE = 60_000;
const START = Date.UTC(2024, 0, 1);

function candle(index) {
    return {
        time: START + index * MINUTE,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
    };
}

function series(from, to) {
    const out = [];
    for (let index = from; index < to; index++) out.push(candle(index));
    return out;
}

function point(index, value) {
    return { time: START + index * MINUTE, value };
}

// --- the retention shift -------------------------------------------------------

test('a retention trim shifts overlay values with the candles', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 10 });
    try {
        h.chart.setData(series(0, 10));
        h.flush();
        h.chart.setOverlays([{ id: 'ema', points: series(0, 10).map((_, i) => point(i, i)), color: '#ff0000' }]);
        h.flush();
        assert.equal(h.chart.getOverlayValueAt('ema', 0), 0);
        assert.equal(h.chart.getOverlayValueAt('ema', 3), 3);

        // Six more bars against a cap of ten trims six off the front, so the first
        // retained bar is #6.
        h.chart.appendBatch(series(10, 16));
        h.flush();
        assert.equal(h.chart.getCandleCount(), 10);
        // The values moved left with the candles. Unshifted, these would read 0 and 3.
        assert.equal(h.chart.getOverlayValueAt('ema', 0), 6, 'bar 0 should now hold bar 6 value');
        assert.equal(h.chart.getOverlayValueAt('ema', 3), 9, 'bar 3 should now hold bar 9 value');
    } finally {
        h.dispose();
    }
});

test('a trim past an overlay window leaves it drawing nothing rather than stale values', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 10 });
    try {
        h.chart.setData(series(0, 10));
        h.flush();
        // Covers only the first three bars.
        h.chart.setOverlays([{ id: 'short', points: [point(0, 1), point(1, 2), point(2, 3)], color: '#00ff00' }]);
        h.flush();
        assert.equal(h.chart.getOverlayValueAt('short', 2), 3);

        // Five more bars against a cap of ten trims five off, so the retained window
        // starts at bar 5 and everything the overlay covered is gone.
        h.chart.appendBatch(series(10, 15));
        h.flush();
        assert.equal(h.chart.getCandleCount(), 10);
        // An empty window must read as nothing, rather than leaving the old values in
        // place to be drawn against bars they have nothing to do with.
        assert.equal(h.chart.getOverlayValueAt('short', 0), null, 'a trimmed window must not read as covered');
        assert.equal(h.chart.getOverlayValueAt('short', 2), null);
    } finally {
        h.dispose();
    }
});

test('per-point colours shift with the values', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 10 });
    try {
        h.chart.setData(series(0, 10));
        h.flush();
        // Covers bars 5, 6 and 7, so a two-bar trim leaves most of the window alive.
        h.chart.setOverlays([{
            id: 'signed',
            color: '#ffffff',
            points: [
                { time: START + 5 * MINUTE, value: 50, color: '#ff0000' },
                { time: START + 6 * MINUTE, value: 60, color: '#00ff00' },
                { time: START + 7 * MINUTE, value: 70, color: '#0000ff' },
            ],
        }]);
        h.flush();
        h.chart.appendBatch(series(10, 12));
        h.flush();
        assert.equal(h.chart.getCandleCount(), 10, 'two bars were trimmed off the front');
        // The first retained bar is #2, so absolute bar 5 is retained bar 3.
        assert.equal(h.chart.getOverlayValueAt('signed', 3), 50);
        assert.equal(h.chart.getOverlayValueAt('signed', 4), 60);
        assert.equal(h.chart.getOverlayValueAt('signed', 5), 70);
        // The colours have to shift with the values, or the line is drawn with the
        // wrong colours on the right bars.
    } finally {
        h.dispose();
    }
});

test('repeated small trims stay aligned', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 20 });
    try {
        h.chart.setData(series(0, 20));
        h.flush();
        h.chart.setOverlays([{ id: 'x', points: series(0, 20).map((_, i) => point(i, i)), color: '#ff0000' }]);
        h.flush();
        let appended = 20;
        for (let round = 0; round < 6; round++) {
            h.chart.appendBatch(series(appended, appended + 3));
            appended += 3;
            h.flush();
            const firstRetained = appended - 20;
            // Retained bar 0 is absolute bar `firstRetained`, whose value was its own
            // ordinal, so that is what the shifted array must now hold there.
            assert.equal(
                h.chart.getOverlayValueAt('x', 0),
                firstRetained,
                `round ${round}: first retained bar is ${firstRetained}`,
            );
        }
    } finally {
        h.dispose();
    }
});

// --- appending one value -------------------------------------------------------

test('appending a value extends the window and reads back', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        h.chart.setData(series(0, 5));
        h.flush();
        h.chart.setOverlays([{ id: 'ema', points: [], color: '#ff0000' }]);
        h.flush();
        // An overlay supplied with no points has nothing to draw and no window.
        assert.equal(h.chart.getOverlayValueAt('ema', 0), null);

        for (let index = 0; index < 5; index++) {
            const ordinal = h.chart.appendOverlayValue('ema', START + index * MINUTE, 100 + index);
            assert.equal(ordinal, index, 'the ordinal is reported back');
        }
        for (let index = 0; index < 5; index++) {
            assert.equal(h.chart.getOverlayValueAt('ema', index), 100 + index);
        }
    } finally {
        h.dispose();
    }
});

test('a value for a bar that is not a candle is refused', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        h.chart.setData(series(0, 5));
        h.flush();
        h.chart.setOverlays([{ id: 'ema', points: [], color: '#ff0000' }]);
        h.flush();
        // Halfway between two bars. Snapping would make a misaligned indicator look
        // right, which is the rule `setOverlays` enforces for the same reason.
        assert.equal(h.chart.appendOverlayValue('ema', START + MINUTE / 2, 1), -1);
        // Before the series and after it.
        assert.equal(h.chart.appendOverlayValue('ema', START - MINUTE, 1), -1);
        assert.equal(h.chart.appendOverlayValue('ema', START + 99 * MINUTE, 1), -1);
    } finally {
        h.dispose();
    }
});

test('an unknown overlay id is an error, not a silent no-op', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        h.chart.setData(series(0, 5));
        h.flush();
        assert.throws(() => h.chart.appendOverlayValue('nope', START, 1), /No overlay has id/);
        assert.throws(() => h.chart.updateOverlayValue('nope', START, 1), /No overlay has id/);
        assert.throws(() => h.chart.appendOverlayValues('nope', [point(0, 1)]), /No overlay has id/);
    } finally {
        h.dispose();
    }
});

test('a non-finite value or time is refused', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        h.chart.setData(series(0, 5));
        h.flush();
        h.chart.setOverlays([{ id: 'ema', points: [], color: '#ff0000' }]);
        h.flush();
        assert.throws(() => h.chart.appendOverlayValue('ema', START, Number.NaN), /must be finite/);
        assert.throws(() => h.chart.appendOverlayValue('ema', Number.NaN, 1), /non-finite time/);
    } finally {
        h.dispose();
    }
});

test('appending onto an empty chart writes nothing rather than throwing', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        h.chart.setOverlays([{ id: 'ema', points: [], color: '#ff0000' }]);
        h.flush();
        assert.equal(h.chart.appendOverlayValue('ema', START, 1), -1);
    } finally {
        h.dispose();
    }
});

// --- revising a value ----------------------------------------------------------

test('a value can be revised on a bar already covered', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        h.chart.setData(series(0, 5));
        h.flush();
        h.chart.setOverlays([{ id: 'ema', points: [], color: '#ff0000' }]);
        h.flush();
        h.chart.appendOverlayValue('ema', START + 2 * MINUTE, 1);
        // A forming candle is revised many times before it closes.
        for (const value of [10, 20, 30]) {
            assert.equal(h.chart.updateOverlayValue('ema', START + 2 * MINUTE, value), 2);
        }
        assert.equal(h.chart.getOverlayValueAt('ema', 2), 30);
    } finally {
        h.dispose();
    }
});

test('revising a bar the overlay does not cover is refused', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        h.chart.setData(series(0, 5));
        h.flush();
        // A warm-up: covers bars 2 and 3 only.
        h.chart.setOverlays([{
            id: 'ema',
            color: '#ff0000',
            points: [point(2, 20), point(3, 30)],
        }]);
        h.flush();
        // Extending the window across a gap the indicator never produced a value for
        // would draw a line through a stretch the caller has said nothing about.
        assert.equal(h.chart.updateOverlayValue('ema', START + 4 * MINUTE, 40), -1);
        assert.equal(h.chart.getOverlayValueAt('ema', 4), null);
        // And a bar inside the window is fine.
        assert.equal(h.chart.updateOverlayValue('ema', START + 3 * MINUTE, 33), 3);
        assert.equal(h.chart.getOverlayValueAt('ema', 3), 33);
    } finally {
        h.dispose();
    }
});

test('a revision with a colour sets that point colour', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        h.chart.setData(series(0, 5));
        h.flush();
        h.chart.setOverlays([{ id: 'macd', color: '#ffffff', points: [point(0, 1), point(1, 2)] }]);
        h.flush();
        // A histogram that flips sign partway through: the colour has to follow.
        assert.doesNotThrow(() => h.chart.updateOverlayValue('macd', START + 1 * MINUTE, -2, '#ff0000'));
        assert.equal(h.chart.getOverlayValueAt('macd', 1), -2);
    } finally {
        h.dispose();
    }
});

// --- the batch form -------------------------------------------------------------

/**
 * Reads back `count` values, with a null for any bar the overlay does not cover.
 *
 * The harness installs a module-level renderer override, so two live charts in one
 * test nest rather than compose and the second comes up half-built. Everything that
 * needs a comparison therefore builds, reads, and disposes one chart at a time.
 */
function readBack(id, count, build) {
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        build(h);
        const out = [];
        for (let index = 0; index < count; index++) out.push(h.chart.getOverlayValueAt(id, index));
        return out;
    } finally {
        h.dispose();
    }
}

test('a batch of values matches appending them one at a time', () => {
    const values = (from, to) => {
        const out = [];
        for (let index = from; index < to; index++) out.push(point(index, index * 2));
        return out;
    };
    const oneAtATime = readBack('e', 40, (h) => {
        h.chart.setData(series(0, 40));
        h.flush();
        h.chart.setOverlays([{ id: 'e', points: [], color: '#ff0000' }]);
        h.flush();
        for (const p of values(0, 40)) h.chart.appendOverlayValue('e', p.time, p.value);
    });
    const inABatch = readBack('e', 40, (h) => {
        h.chart.setData(series(0, 40));
        h.flush();
        h.chart.setOverlays([{ id: 'e', points: [], color: '#ff0000' }]);
        h.flush();
        const written = h.chart.appendOverlayValues('e', values(0, 40));
        assert.equal(written, 40, 'every value should land');
    });
    assert.deepEqual(inABatch, oneAtATime);
});

test('a batch skips the points that are not candles and reports how many landed', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        h.chart.setData(series(0, 5));
        h.flush();
        h.chart.setOverlays([{ id: 'e', points: [], color: '#ff0000' }]);
        h.flush();
        const written = h.chart.appendOverlayValues('e', [
            point(0, 1),
            { time: START + MINUTE / 2, value: 99 },
            { time: START - MINUTE, value: 99 },
            point(1, 2),
        ]);
        assert.equal(written, 2, 'the two real candles');
        assert.equal(h.chart.getOverlayValueAt('e', 0), 1);
        assert.equal(h.chart.getOverlayValueAt('e', 1), 2);
    } finally {
        h.dispose();
    }
});

test('an empty batch is a no-op', () => {
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        h.chart.setData(series(0, 5));
        h.flush();
        h.chart.setOverlays([{ id: 'e', points: [], color: '#ff0000' }]);
        h.flush();
        assert.equal(h.chart.appendOverlayValues('e', []), 0);
    } finally {
        h.dispose();
    }
});

// --- equivalence with the batch path --------------------------------------------

test('an overlay fed incrementally equals one supplied wholesale', () => {
    // The whole point of the incremental path: it must produce the same chart state as
    // `setOverlays`, not merely a faster approximation of it. A divergence here would
    // show up as an indicator that draws differently depending on how it was fed, which
    // is the hardest kind of defect to find.
    const N = 60;
    const values = (from, to) => {
        const out = [];
        for (let index = from; index < to; index++) {
            out.push(point(index, 100 + Math.sin(index * 0.2) * 10));
        }
        return out;
    };

    const wholesale = readBack('e', N, (h) => {
        h.chart.setData(series(0, N));
        h.flush();
        h.chart.setOverlays([{ id: 'e', points: values(0, N), color: '#ff0000' }]);
        h.flush();
    });
    const incremental = readBack('e', N, (h) => {
        h.chart.setData(series(0, N));
        h.flush();
        h.chart.setOverlays([{ id: 'e', points: [], color: '#ff0000' }]);
        h.flush();
        h.chart.appendOverlayValues('e', values(0, N));
    });
    assert.deepEqual(incremental, wholesale, 'the two paths must agree bar for bar');
});

test('the two paths reject a misaligned timestamp the same way', () => {
    // Not merely the same result for good input, but the same refusal for bad. A
    // snapping incremental path and a strict wholesale path would produce different
    // charts for the same misaligned indicator, and the difference would only show on
    // the bars where the snap moved the value.
    const h = createHeadlessChart({ maxRetainedCandles: 1000 });
    try {
        h.chart.setData(series(0, 5));
        h.flush();
        h.chart.setOverlays([{ id: 'e', points: [], color: '#ff0000' }]);
        h.flush();
        assert.throws(
            () => h.chart.setOverlays([{
                id: 'e',
                points: [{ time: START + MINUTE / 2, value: 1 }],
                color: '#ff0000',
            }]),
            /must land on a candle/,
        );
        assert.equal(h.chart.appendOverlayValue('e', START + MINUTE / 2, 1), -1);
        assert.equal(h.chart.getOverlayValueAt('e', 0), null, 'and neither wrote a value');
    } finally {
        h.dispose();
    }
});

test('an incrementally fed overlay works alongside a retention trim', () => {
    // The two paths meet on a live feed: values arrive per tick while the window
    // trims underneath them. If either is not shift-aware the indicator ends up
    // plotted against the wrong bars, which is the bug the retention shift fixes.
    const h = createHeadlessChart({ maxRetainedCandles: 15 });
    try {
        h.chart.setData(series(0, 15));
        h.flush();
        h.chart.setOverlays([{ id: 'e', points: [], color: '#ff0000' }]);
        h.flush();
        for (let index = 0; index < 15; index++) {
            h.chart.appendOverlayValue('e', START + index * MINUTE, index);
        }
        assert.equal(h.chart.getOverlayValueAt('e', 14), 14);

        // Five more bars, trimming five off the front.
        h.chart.appendBatch(series(15, 20));
        h.flush();
        assert.equal(h.chart.getCandleCount(), 15);
        assert.equal(h.chart.getOverlayValueAt('e', 9), 14, 'retained bar 9 is absolute bar 14');
        // And a value on the newest bar still lands on the newest bar.
        const ordinal = h.chart.appendOverlayValue('e', START + 19 * MINUTE, 999);
        assert.equal(ordinal, 14);
        assert.equal(h.chart.getOverlayValueAt('e', 14), 999);
    } finally {
        h.dispose();
    }
});
