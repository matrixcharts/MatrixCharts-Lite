// Tests for the three changes that came out of one report: the grid not closing where
// there are no candles, a time axis that repeated "Sep 1" on every tick, and a price
// panel showing `100` and `100.1000001` where `100.10` was wanted.
//
// The first two share a cause and are tested together because they are one fix: the axis
// is candle-derived, so it could not describe a region with no candles, and every label
// it did produce carried the whole date. Both are pure functions, which is the only reason
// they are testable at all — the previous grid defect lived in a renderer loop that no
// headless test could reach, and survived 231 green tests.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    timeAxisDetail,
    timeAxisLabels,
    timeAxisTicks,
} = require('../.test-build/core/timeAxis.js');
const {
    barsBeforeSlotExtended,
    computeSlotOffsets,
    resolveSessionBreaks,
    sizeSessionBreaks,
    slotAtIndex,
    totalSlots,
} = require('../.test-build/core/sessionScale.js');
const { priceLabelFormatter } = require('../.test-build/core/options.js');
const { createHeadlessChart } = require('./support/headlessChart.cjs');

const MINUTE = 60_000;
const SESSION_OPEN = Date.UTC(2025, 0, 6, 14, 30); // a Monday, mid-afternoon UTC

function minutes(count, from = SESSION_OPEN) {
    const times = [];
    for (let i = 0; i < count; i++) times.push(from + i * MINUTE);
    return times;
}

/** The same instants as candles, for the paths that need a chart rather than a function. */
function candles(count, from = SESSION_OPEN) {
    return minutes(count, from).map((time, i) => ({
        time,
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100.5 + i,
    }));
}

/** The slot table `Chart.rebuildSlots` would build, mirrors it option for option. */
function slotTable(times, { mode = 'proportional', maxWhitespaceRatio } = {}) {
    const resolved = resolveSessionBreaks(times, { mode, maxWhitespaceRatio });
    return computeSlotOffsets(times, sizeSessionBreaks(times, resolved));
}

/** `sessions` runs of one-minute bars, separated by an overnight gap. */
function sessions(count, sessionCount = 3, gapHours = 17) {
    const times = [];
    let cursor = SESSION_OPEN;
    for (let session = 0; session < sessionCount; session++) {
        for (let i = 0; i < count; i++) times.push(cursor + i * MINUTE);
        cursor += count * MINUTE + gapHours * 60 * MINUTE;
    }
    return times;
}

// --- the grid closes past the data -------------------------------------------------

test('a window running past the newest candle is labelled where it is', () => {
    // The report, as a test. The window was clamped to the series, so extending it into
    // empty space produced *exactly* the same ticks — no vertical grid line was drawn
    // there, while the horizontal ones, coming from the price scale, ran the full width
    // regardless. The cells never closed, and a caller who parked the view in the space
    // past the last candle got a grid with nothing in it.
    const times = minutes(300);
    const inRange = timeAxisTicks({ times, slots: null, fromSlot: 0, toSlot: 300, widthPx: 1122 });
    const past = timeAxisTicks({ times, slots: null, fromSlot: 0, toSlot: 400, widthPx: 1122 });

    assert.ok(
        past.length > inRange.length,
        `a wider window should get more ticks, got ${past.length} against ${inRange.length}`,
    );
    const lastSlot = past[past.length - 1].slot;
    assert.ok(
        lastSlot > 300,
        `the last label is at slot ${lastSlot}, so nothing is drawn past the newest candle`,
    );
});

test('a window entirely past the data does not collapse onto the newest candle', () => {
    // The second half of the same defect, and the more absurd of the two: every label
    // resolved through `indexToCoordinate`, which clamps an index to the slot table, so a
    // window in the void returned one label on the last candle rather than the ten the
    // window asked for. Distinct positions, ascending.
    const times = minutes(300);
    const ticks = timeAxisTicks({ times, slots: null, fromSlot: 400, toSlot: 500, widthPx: 1122 });
    assert.ok(ticks.length >= 2, `expected a label per rung, got ${ticks.length}`);
    const distinct = new Set(ticks.map((tick) => tick.slot));
    assert.equal(distinct.size, ticks.length, 'every label sits at its own position');
    for (let i = 1; i < ticks.length; i++) {
        assert.ok(ticks[i].slot > ticks[i - 1].slot, 'positions ascend');
        assert.ok(ticks[i].time > ticks[i - 1].time, 'times ascend, rather than repeating the last candle');
    }
});

test('the same is true of a gapped series, which is the case that used to differ', () => {
    // `barsBeforeSlot` extrapolates for a break-free series and clamps for a gapped one,
    // so the empty space got labels on a continuous chart and none on a chart with an
    // overnight break in it. The difference being whether the instrument trades
    // overnight, which is what makes a code branch look like a data bug.
    const times = sessions(60, 5);
    const slots = slotTable(times);
    const extent = totalSlots(slots);
    const plain = timeAxisTicks({ times, slots: null, fromSlot: 0, toSlot: 300, widthPx: 1122 });
    const gapped = timeAxisTicks({ times, slots, fromSlot: 0, toSlot: extent + 100, widthPx: 1122 });
    assert.ok(
        gapped[gapped.length - 1].slot > extent,
        'a gapped window past the data gets labels past the data',
    );
    assert.ok(plain.length > 0 && gapped.length > 0);
});

test('a tick inside the series sits exactly where the old index-based path put it', () => {
    // The change has to be additive in effect as well as in type: `slot` is carried so a
    // renderer *can* use it, and if it disagreed with `indexToCoordinate` for an ordinary
    // bar every existing chart's labels and grid lines would shift.
    //
    // Filtered on the *slot* rather than on `index`, because `index` is clamped to the
    // series and so says nothing about whether a tick's position is out there. A slot
    // below the extent is a real bar's, and for one of those the two must agree.
    const times = sessions(60, 4);
    const slots = slotTable(times);
    const extent = totalSlots(slots);
    const ticks = timeAxisTicks({ times, slots, fromSlot: 0, toSlot: extent, widthPx: 1200 });
    const inSeries = ticks.filter((tick) => tick.slot < extent);
    assert.ok(inSeries.length > 0);
    for (const tick of inSeries) {
        assert.equal(
            tick.slot,
            slotAtIndex(slots, tick.index),
            `tick ${tick.index} moved: slot ${tick.slot} against ${slotAtIndex(slots, tick.index)}`,
        );
    }
});

test('a tick never invents a bar, even when its position is out of series', () => {
    // The distinction the old code conflated. Position and ordinal are separate fields
    // now, so the axis can label a place that has no candle while `index` — which every
    // reader's index arithmetic depends on — stays inside the series.
    const times = minutes(50);
    const ticks = timeAxisTicks({ times, slots: null, fromSlot: 20, toSlot: 400, widthPx: 800 });
    assert.ok(ticks.length > 0);
    for (const tick of ticks) {
        assert.ok(Number.isInteger(tick.index), 'the index stays an integer');
        assert.ok(tick.index >= 0 && tick.index < times.length, `index ${tick.index} is out of series`);
    }
});

test('every label lands inside the window it was asked for', () => {
    // Otherwise the axis draws ticks the caller has panned off screen and the pixel budget
    // is spent on labels nobody sees.
    const times = sessions(80, 4);
    const slots = slotTable(times);
    const ticks = timeAxisTicks({ times, slots, fromSlot: 40, toSlot: 260, widthPx: 900 });
    assert.ok(ticks.length > 1);
    for (const tick of ticks) {
        assert.ok(tick.slot >= 40 && tick.slot <= 260, `slot ${tick.slot} is outside the window`);
    }
});

test('barsBeforeSlotExtended is continuous across the end of the series', () => {
    // At the boundary the extended form and the clamped one must agree, or a window
    // scrolled to exactly the end of the data would jump by a bar.
    const times = sessions(60, 3);
    const slots = slotTable(times);
    const extent = totalSlots(slots);
    assert.equal(barsBeforeSlotExtended(slots, extent, times.length), times.length);
    assert.equal(barsBeforeSlotExtended(slots, extent + 0.5, times.length), times.length + 1);
    assert.equal(barsBeforeSlotExtended(slots, -1, times.length), -1);
    // And inside the series it is the plain answer, not an approximation of it.
    assert.equal(barsBeforeSlotExtended(slots, 12.5, times.length), 13);
});

// --- the time axis stops repeating the date ---------------------------------------

test('the date is written once per day, not on every label', () => {
    // The screenshot: `Sep 17, 01:30 PM  Sep 1 Sep 1 Sep 1 ...`. Every label carried the
    // date, which is far wider than the space between labels, so they overlapped into a
    // row of clipped half-dates. Only a label that changes the date needs to say it.
    const times = minutes(300);
    const ticks = timeAxisTicks({ times, slots: null, fromSlot: 0, toSlot: 300, widthPx: 1122 });
    const labels = timeAxisLabels({
        ticks, locale: 'en-US', timeZone: 'UTC', detail: timeAxisDetail(ticks[0].time, ticks[ticks.length - 1].time),
    });
    assert.ok(labels.length > 3, 'the fixture needs several labels to mean anything');
    const majors = labels.filter((label) => label.major);
    // One day is in view, so exactly one label introduces it — plus the first, which is
    // always full so a view opening mid-day still says what day it is.
    assert.equal(majors.length, 1, `expected one dated label, got ${majors.length}`);
    assert.ok(majors[0].text.includes('Jan'), `the major label names the date, got "${majors[0].text}"`);
    for (const label of labels.filter((l) => !l.major)) {
        assert.ok(!label.text.includes('Jan'), `a short label repeated the date: "${label.text}"`);
    }
});

test('a new day brings the date back', () => {
    // The compaction has to be reversible: a reader scanning the axis has to be able to
    // find out what day any given label is on, and a label that changes the day is where
    // they find it.
    const times = sessions(120, 3);
    const ticks = timeAxisTicks({ times, slots: null, fromSlot: 0, toSlot: 360, widthPx: 4000 });
    const labels = timeAxisLabels({
        ticks, locale: 'en-US', timeZone: 'UTC', detail: timeAxisDetail(ticks[0].time, ticks[ticks.length - 1].time),
    });
    const majors = labels.filter((label) => label.major);
    assert.ok(majors.length >= 2, `expected a label per day, got ${majors.length}`);
    // Consecutive major labels name different days.
    const days = new Set(majors.map((label) => label.text));
    assert.equal(days.size, majors.length, 'each dated label names a different day');
});

test('the first label is full whatever else is true of it', () => {
    // A view that opens in the middle of a day must still say what day it is, or the
    // axis has no date on it anywhere and the reader is left guessing.
    const times = minutes(300, SESSION_OPEN + 6 * 60 * MINUTE);
    const ticks = timeAxisTicks({ times, slots: null, fromSlot: 0, toSlot: 300, widthPx: 1122 });
    const labels = timeAxisLabels({
        ticks, locale: 'en-US', timeZone: 'UTC', detail: timeAxisDetail(ticks[0].time, ticks[ticks.length - 1].time),
    });
    assert.ok(labels.length > 2);
    assert.equal(labels[0].major, true, 'the first label is full');
    assert.ok(labels[0].text.includes('Jan'), `and it names the date, got "${labels[0].text}"`);
});

test('a short label is strictly shorter than the full one beside it', () => {
    // The property the whole change is for. Not "different" — shorter, because width is
    // what decides whether two labels collide.
    const times = minutes(300);
    const ticks = timeAxisTicks({ times, slots: null, fromSlot: 0, toSlot: 300, widthPx: 1122 });
    const labels = timeAxisLabels({
        ticks, locale: 'en-US', timeZone: 'UTC', detail: timeAxisDetail(ticks[0].time, ticks[ticks.length - 1].time),
    });
    const major = labels.find((label) => label.major);
    const short = labels.find((label) => !label.major);
    assert.ok(major && short);
    assert.ok(short.text.length < major.text.length, `"${short.text}" is not shorter than "${major.text}"`);
});

test('the same compaction applies at day and month detail', () => {
    // Not a minute-level problem: a daily chart repeating "Sep 17" on every label has
    // the same defect one rung up, and a monthly one repeating "Sep 2025" is worse.
    const day = [];
    for (let i = 0; i < 200; i++) day.push(SESSION_OPEN + i * 24 * 60 * MINUTE);
    const dayTicks = timeAxisTicks({ times: day, slots: null, fromSlot: 0, toSlot: 200, widthPx: 1400 });
    const dayLabels = timeAxisLabels({
        ticks: dayTicks, locale: 'en-US', timeZone: 'UTC', detail: 'day',
    });
    assert.ok(dayLabels.length > 3);
    const dayMajors = dayLabels.filter((label) => label.major);
    assert.ok(dayMajors.length < dayLabels.length, 'a daily axis does not repeat the month on every label');
    for (const label of dayLabels.filter((l) => !l.major)) {
        assert.ok(!label.text.includes('/'), `a short daily label repeated the month: "${label.text}"`);
    }

    const month = [];
    for (let i = 0; i < 200; i++) month.push(SESSION_OPEN + i * 30 * 24 * 60 * MINUTE);
    const monthTicks = timeAxisTicks({ times: month, slots: null, fromSlot: 0, toSlot: 200, widthPx: 1400 });
    const monthLabels = timeAxisLabels({
        ticks: monthTicks, locale: 'en-US', timeZone: 'UTC', detail: 'month',
    });
    const monthMajors = monthLabels.filter((label) => label.major);
    assert.ok(
        monthMajors.length < monthLabels.length,
        'a monthly axis does not repeat the year on every label',
    );
});

test('a day is a calendar day in the configured zone, not 86400000 milliseconds', () => {
    // "The same day" is a calendar question in the reader's zone, and dividing epoch
    // milliseconds answers it in UTC's. The pair below is an hour apart and straddles
    // *Kolkata's* midnight rather than UTC's, so a UTC implementation calls it one day and
    // a zone-aware one does not. That is the whole assertion: the two zones disagree, and
    // only one of them agrees with naive UTC arithmetic.
    //
    // (An earlier version of this used London and asserted the wrong thing — London is
    // GMT in January, so 23:00Z and 01:00Z really are two different days there.)
    const beforeKolkataMidnight = Date.UTC(2025, 0, 6, 18, 0);
    const ticks = [
        { index: 0, time: beforeKolkataMidnight, slot: 0 },
        { index: 1, time: beforeKolkataMidnight + 60 * MINUTE, slot: 1 },
    ];
    const kolkata = timeAxisLabels({
        ticks, locale: 'en-IN', timeZone: 'Asia/Kolkata', detail: 'minute',
    });
    const newYork = timeAxisLabels({
        ticks, locale: 'en-US', timeZone: 'America/New_York', detail: 'minute',
    });
    assert.equal(kolkata[1].major, true, 'Kolkata reads 23:30 and 00:30 as two days');
    assert.equal(newYork[1].major, false, 'New York reads 13:00 and 14:00 as one day');
    // And the naive answer — grouping by UTC day — is the one New York gives here and
    // Kolkata does not, which is what makes this a test rather than a coincidence.
    assert.notEqual(kolkata[1].major, newYork[1].major);
});

test('detail follows the span, and nothing else', () => {
    assert.equal(timeAxisDetail(0, 90 * MINUTE), 'minute');
    assert.equal(timeAxisDetail(0, 2 * 24 * 60 * MINUTE), 'day');
    assert.equal(timeAxisDetail(0, 200 * 24 * 60 * MINUTE), 'day');
    assert.equal(timeAxisDetail(0, 400 * 24 * 60 * MINUTE), 'month');
    // A series with no span, or a nonsense one, is the minute case rather than a throw.
    assert.equal(timeAxisDetail(Number.NaN, 1), 'minute');
});

test('an empty tick list is an empty label list', () => {
    assert.deepEqual(timeAxisLabels({ ticks: [], locale: 'en-US', timeZone: 'UTC', detail: 'minute' }), []);
});

// --- the price panel ---------------------------------------------------------------

test('a price label is written with a fixed number of decimals', () => {
    // The ask: `100` and `100.1000001` should read `100.10`. Fixed digits rather than a
    // maximum, because a price axis where `100` sits beside `100.1` makes the reader
    // count decimals to find the tick spacing, which is the one job an axis has.
    const format = priceLabelFormatter('en-US', 2);
    assert.equal(format.format(100), '100.00');
    assert.equal(format.format(100.1), '100.10');
    assert.equal(format.format(763.25), '763.25');
    assert.equal(format.format(0), '0.00');
});

test('a float artefact in a tick value never reaches the canvas', () => {
    // Tick values come out of the tick arithmetic as doubles, so `100.1000001` is
    // reachable and was being displayed. Rounding to a fixed width is what stops it.
    const format = priceLabelFormatter('en-US', 2);
    assert.equal(format.format(100.1000001), '100.10');
    assert.equal(format.format(763.20436), '763.20');
    assert.equal(format.format(0.1 + 0.2), '0.30');
});

test('precision is honoured as given, including zero and more than two', () => {
    assert.equal(priceLabelFormatter('en-US', 0).format(100.6), '101');
    assert.equal(priceLabelFormatter('en-US', 4).format(100.1), '100.1000');
    // A crypto quote or a FX rate, and the artifact is still rounded rather than shown.
    assert.equal(priceLabelFormatter('en-US', 8).format(100.1000001), '100.10000010');
});

test('a nonsense precision is clamped rather than thrown at Intl', () => {
    // `Intl` throws a RangeError on a negative or over-20 digit count, and an options
    // object is caller-supplied. Resolving it to something drawable is better than taking
    // the chart down over a number.
    assert.equal(priceLabelFormatter('en-US', -3).format(100.5), '101');
    // Clamped to Intl's own ceiling of 20 rather than passed through, which throws.
    const wide = priceLabelFormatter('en-US', 99).format(100.5);
    assert.equal(wide.slice(0, 4), '100.', 'and still reads as the number it is');
    assert.equal(wide.length - 4, 20, 'clamped to twenty fraction digits');
    assert.equal(priceLabelFormatter('en-US', 2.7).format(100.5), '100.50');
});

test('grouping and locale are left to Intl', () => {
    // Deliberately not reimplemented, so a locale that groups differently gets it right
    // without anything here knowing which locales those are.
    assert.equal(priceLabelFormatter('en-US', 2).format(1234567.5), '1,234,567.50');
    assert.equal(priceLabelFormatter('de-DE', 2).format(1234567.5).replace(/\u00a0/g, ' '), '1.234.567,50');
});
// --- through the chart -------------------------------------------------------------
//
// Chart-level, and in this file on purpose. The first version of the label work read the
// detail off `ticks[0].time` and threw on an empty tick list, which took the whole page
// down on an empty series. Every one of the 315 headless tests was green, because all of
// them put data on the chart first - the same blind spot that hid the original grid
// defect, where a renderer loop no headless test could reach survived 231 green tests. A
// guard only the renderer can reach needs a test only the renderer can run.

test('a chart rendered before any data arrives does not throw', () => {
    // The reachable path, and a common one: a panel that mounts before its first snapshot
    // is on screen, and a live feed is empty until the socket opens. `setData([])` is
    // rejected by validation, so the empty series is not something a caller can ask for
    // directly — it is the state every chart passes through on the way to having data,
    // and it is the state the interaction harness was in when this was found.
    const harness = createHeadlessChart();
    try {
        harness.flush();
        assert.equal(harness.chart.getCandleCount(), 0);
        assert.deepEqual(harness.chart.getVisibleLogicalRange(), { from: 0, to: 0 });
        // And it recovers: data arriving later still renders.
        harness.chart.setData(candles(30));
        harness.flush();
        assert.equal(harness.chart.getCandleCount(), 30);
    } finally {
        harness.dispose();
    }
});

test('a chart held at zero height keeps its data and does not throw', () => {
    // The other way to reach a degenerate window: a container measured at nothing, which
    // is what a divider dragged through zero looks like. The collapse guard means no frame
    // is drawn, and the data still has to land.
    const harness = createHeadlessChart({ dom: { width: 1200, height: 0 } });
    try {
        harness.chart.setData(candles(30));
        harness.flush();
        assert.equal(harness.chart.getCandleCount(), 30, 'data is held even while collapsed');
    } finally {
        harness.dispose();
    }
});