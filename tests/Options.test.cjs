// Pure tests for src/core/options.ts: colour parsing, validation, deep merge,
// theme preset seeding, and override precedence. No DOM, no canvas.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    DEFAULT_MAX_BAR_SPACING,
    DEFAULT_MIN_BAR_SPACING,
    contrastText,
    mergeOptionPartials,
    parseCssColor,
    resolveCandleColors,
    resolveOptions,
    themeDefaults,
    measureDynamicPriceAxisWidth,
} = require('../.test-build/core/options.js');

/**
 * The two inks `contrastText` chooses between, named so a failure says which one moved.
 * Channels are 0-to-1, which is what `parseCssColor` returns and what every colour in this
 * file is in — a hand-written `[233, 237, 242, 255]` is a clipped pure white.
 */
const DARK_INK = [11 / 255, 15 / 255, 20 / 255, 1];
const LIGHT_INK = [240 / 255, 246 / 255, 252 / 255, 1];

/** WCAG relative luminance, so "is this ink lighter or darker than that" has one answer. */
const luminanceOf = (rgba) => {
    const linear = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * linear(rgba[0]) + 0.7152 * linear(rgba[1]) + 0.0722 * linear(rgba[2]);
};
/** WCAG contrast ratio between two colours, on the 1-to-21 scale. */
const contrastRatio = (a, b) => {
    const hi = Math.max(luminanceOf(a), luminanceOf(b));
    const lo = Math.min(luminanceOf(a), luminanceOf(b));
    return (hi + 0.05) / (lo + 0.05);
};

test('one chart\'s options never become the next chart\'s defaults', () => {
    // A shipped defect, and the reason this file's tests all construct their own options
    // rather than sharing a fixture: `themeDefaults` built its result with a shallow
    // spread of the time scale, so every resolved options object shared *one* nested
    // `sessionBreaks` with the module-level defaults — and `applyOptions` merges that
    // block field by field in place, because it is a patch. Configuring the gaps on one
    // chart therefore rewrote the defaults for every chart created afterwards, in the same
    // process: two charts on a page where the first turned session breaks off silently
    // turned them off for the second, and for a third that never mentioned them.
    //
    // It is invisible to a single-chart test and to a suite where every chart asks for
    // the same thing, which is all of them until one test happens to disable them.
    const themed = themeDefaults('dark');
    const configured = resolveOptions({ timeScale: { sessionBreaks: { enabled: false, mode: 'proportional' } } });
    assert.equal(configured.timeScale.sessionBreaks.enabled, false);
    assert.equal(configured.timeScale.sessionBreaks.mode, 'proportional');

    // A fresh resolve must see the shipped defaults, not the previous call's patch.
    const afterwards = resolveOptions({});
    assert.equal(afterwards.timeScale.sessionBreaks.enabled, true, 'enabled leaked between resolves');
    assert.equal(afterwards.timeScale.sessionBreaks.mode, 'collapsed', 'mode leaked between resolves');
    assert.equal(
        themed.timeScale.sessionBreaks.enabled,
        true,
        'a theme snapshot is mutated by a later resolve',
    );

    // The same shape of hazard one level over: `panes.weights` is an array, and a shared
    // reference is one `push` away from the identical bug even though it is currently
    // replaced rather than mutated.
    const resolved = resolveOptions({ panes: { weights: [2, 1] } });
    resolved.panes.weights.push(99);
    assert.deepEqual(resolveOptions({}).panes.weights, [1], 'pane weights leaked between resolves');
});

const round = (rgba) => rgba.map((channel) => Math.round(channel * 255));
const throws = (fn, pattern, message) => {
    assert.throws(fn, pattern, message);
};

// --- colour parsing ---------------------------------------------------------

test('hex colours parse to normalised channels', () => {
    assert.deepEqual(round(parseCssColor('#1ad98c', 'c')), [26, 217, 140, 255]);
    assert.deepEqual(round(parseCssColor('#fff', 'c')), [255, 255, 255, 255]);
    assert.deepEqual(round(parseCssColor('#00000080', 'c')), [0, 0, 0, 128]);
    assert.deepEqual(round(parseCssColor('#f00f', 'c')), [255, 0, 0, 255]);
});

test('rgb and rgba parse, including percentages', () => {
    assert.deepEqual(round(parseCssColor('rgb(26, 217, 140)', 'c')), [26, 217, 140, 255]);
    assert.deepEqual(round(parseCssColor('rgba(26,217,140,0.5)', 'c')), [26, 217, 140, 128]);
    assert.deepEqual(round(parseCssColor('rgb(100%, 0%, 50%)', 'c')), [255, 0, 128, 255]);
    assert.deepEqual(round(parseCssColor('TRANSPARENT', 'c')), [0, 0, 0, 0]);
});

test('channels clamp the way CSS clamps them', () => {
    assert.deepEqual(round(parseCssColor('rgb(300, -20, 10)', 'c')), [255, 0, 10, 255]);
    assert.deepEqual(round(parseCssColor('rgba(0,0,0,5)', 'c')), [0, 0, 0, 255]);
    assert.deepEqual(round(parseCssColor('rgba(0,0,0,-1)', 'c')), [0, 0, 0, 0]);
});

test('invalid colours throw with the option path in the message', () => {
    throws(() => parseCssColor('chartreuse', 'candlestick.upColor'), /candlestick\.upColor/);
    throws(() => parseCssColor('#12345', 'layout.background'), /hex colour/);
    throws(() => parseCssColor('rgb(1,2)', 'grid.color'), /3 or 4/);
    throws(() => parseCssColor('rgb(a,b,c)', 'grid.color'), /not a valid colour/);
    throws(() => parseCssColor(42, 'layout.textColor'), /must be a CSS color string/);
    throws(() => parseCssColor(null, 'crosshair.color'), /must be a CSS color string/);
});

test('every theme preset colour is parseable', () => {
    for (const theme of ['dark', 'paper']) {
        const options = themeDefaults(theme);
        for (const value of [
            options.layout.background,
            options.layout.textColor,
            options.grid.color,
            options.crosshair.color,
            options.candlestick.upColor,
            options.candlestick.downColor,
            options.candlestick.borderUpColor,
            options.candlestick.borderDownColor,
        ]) {
            assert.doesNotThrow(() => parseCssColor(value, `${theme} preset`), `${theme} preset colour ${value}`);
        }
    }
});

// --- resolution and presets -------------------------------------------------

test('a theme seeds a complete, self-consistent snapshot', () => {
    for (const theme of ['dark', 'paper']) {
        const options = themeDefaults(theme);
        assert.equal(options.theme, theme);
        assert.equal(options.timeZone, 'UTC');
        assert.equal(options.priceFormat.precision, 2);
        assert.equal(options.priceFormat.minMove, 0.01);
        assert.equal(options.candlestick.wickVisible, true);
        assert.equal(options.candlestick.borderVisible, false);
        assert.equal(options.crosshair.visible, true);
        assert.ok(options.locale.length > 0);
    }
    // The two presets must actually differ, or the theme switch is a no-op.
    assert.notEqual(themeDefaults('dark').candlestick.upColor, themeDefaults('paper').candlestick.upColor);
    assert.notEqual(themeDefaults('dark').layout.background, themeDefaults('paper').layout.background);
});

test('an empty partial resolves to the theme defaults', () => {
    assert.deepEqual(resolveOptions({}), themeDefaults('dark'));
    assert.deepEqual(resolveOptions({}, 'paper'), themeDefaults('paper'));
    assert.deepEqual(resolveOptions({ theme: 'paper' }), themeDefaults('paper'));
});

test('a nested partial overrides only the fields it names', () => {
    const resolved = resolveOptions({ candlestick: { upColor: '#ff00ff' } });
    assert.equal(resolved.candlestick.upColor, '#ff00ff');
    assert.equal(resolved.candlestick.downColor, themeDefaults('dark').candlestick.downColor);
    assert.equal(resolved.layout.background, themeDefaults('dark').layout.background);
});

test('a preset colour is overridden but survives a later theme change', () => {
    let explicit = mergeOptionPartials({}, { candlestick: { upColor: '#ff00ff' } });
    let resolved = resolveOptions(explicit);
    assert.equal(resolved.candlestick.upColor, '#ff00ff', 'override applied over the preset');

    // Switching theme re-seeds from the new preset, then re-applies the override.
    explicit = mergeOptionPartials(explicit, { theme: 'paper' });
    resolved = resolveOptions(explicit);
    assert.equal(resolved.theme, 'paper');
    assert.equal(resolved.candlestick.upColor, '#ff00ff', 'explicit override survives the theme change');
    assert.equal(
        resolved.candlestick.downColor,
        themeDefaults('paper').candlestick.downColor,
        'untouched fields come from the new preset',
    );
    assert.equal(resolved.layout.background, themeDefaults('paper').layout.background);
});

test('an override set before any theme is re-applied on top of the preset', () => {
    const explicit = mergeOptionPartials(
        mergeOptionPartials({}, { layout: { textColor: '#123456' } }),
        { theme: 'paper' },
    );
    const resolved = resolveOptions(explicit);
    assert.equal(resolved.layout.textColor, '#123456');
    assert.equal(resolved.candlestick.upColor, themeDefaults('paper').candlestick.upColor);
});

test('merging accumulates nested fields without dropping siblings', () => {
    let explicit = mergeOptionPartials({}, { candlestick: { upColor: '#111111' } });
    explicit = mergeOptionPartials(explicit, { candlestick: { downColor: '#222222' } });
    const resolved = resolveOptions(explicit);
    assert.equal(resolved.candlestick.upColor, '#111111', 'earlier sibling survives');
    assert.equal(resolved.candlestick.downColor, '#222222');
});

test('merging leaves unrelated sections alone', () => {
    const explicit = mergeOptionPartials(
        mergeOptionPartials({}, { grid: { vertLines: false } }),
        { priceFormat: { precision: 4 } },
    );
    const resolved = resolveOptions(explicit);
    assert.equal(resolved.grid.vertLines, false);
    assert.equal(resolved.grid.horzLines, true);
    assert.equal(resolved.priceFormat.precision, 4);
    assert.equal(resolved.priceFormat.minMove, 0.01);
});

// --- validation -------------------------------------------------------------

test('maxRetainedCandles is rejected by applyOptions but allowed in the constructor', () => {
    throws(() => mergeOptionPartials({}, { maxRetainedCandles: 10 }), /constructor-only/);
    throws(() => mergeOptionPartials({}, { maxRetainedCandles: 10, theme: 'paper' }), /constructor-only/);
    throws(() => mergeOptionPartials({}, { maxRetainedCandles: 10 }, 'applyOptions'), /constructor-only/);
    // The constructor is the one place it is legal, and it must survive the merge
    // so the resolved snapshot reports it.
    const merged = mergeOptionPartials({}, { maxRetainedCandles: 10, theme: 'paper' }, 'constructor');
    assert.equal(merged.maxRetainedCandles, 10);
    assert.equal(merged.theme, 'paper');
    assert.equal(resolveOptions(merged).maxRetainedCandles, 10);
    assert.equal(resolveOptions({ maxRetainedCandles: 10 }).maxRetainedCandles, 10);
});

test('numeric ranges are validated', () => {
    throws(() => resolveOptions({ maxRetainedCandles: 0 }), /maxRetainedCandles/);
    throws(() => resolveOptions({ maxRetainedCandles: 1.5 }), /maxRetainedCandles/);
    throws(() => resolveOptions({ priceFormat: { precision: -1 } }), /precision/);
    throws(() => resolveOptions({ priceFormat: { precision: 21 } }), /precision/);
    throws(() => resolveOptions({ priceFormat: { precision: 1.5 } }), /precision/);
    throws(() => resolveOptions({ priceFormat: { minMove: 0 } }), /minMove/);
    throws(() => resolveOptions({ priceFormat: { minMove: -1 } }), /minMove/);
});

test('axis gutter sizes are validated', () => {
    // A negative gutter would invert the plot rect and flip the price axis; a
    // non-finite one would collapse it. Both are rejected at the option boundary
    // rather than reaching the geometry.
    throws(() => resolveOptions({ layout: { priceAxisWidth: -1 } }), /priceAxisWidth/);
    throws(() => resolveOptions({ layout: { priceAxisWidth: Number.NaN } }), /priceAxisWidth/);
    throws(() => resolveOptions({ layout: { priceAxisWidth: Infinity } }), /priceAxisWidth/);
    throws(() => resolveOptions({ layout: { priceAxisWidth: '80' } }), /priceAxisWidth/);
    throws(() => resolveOptions({ layout: { timeAxisHeight: -1 } }), /timeAxisHeight/);
    throws(() => resolveOptions({ layout: { timeAxisHeight: Number.NaN } }), /timeAxisHeight/);
    // Zero is allowed: it means "reserve nothing", which is the old behaviour.
    assert.equal(resolveOptions({ layout: { priceAxisWidth: 0 } }).layout.priceAxisWidth, 0);
    assert.equal(resolveOptions({ layout: { timeAxisHeight: 0 } }).layout.timeAxisHeight, 0);
});

test('gutter sizes default per theme and are not reseeded by a theme change', () => {
    // They are layout metrics, not colours: switching theme must not resize the
    // plot out from under an integrator.
    const dark = resolveOptions({ theme: 'dark' });
    const paper = resolveOptions({ theme: 'paper' });
    assert.equal(dark.layout.priceAxisWidth, paper.layout.priceAxisWidth);
    assert.equal(dark.layout.timeAxisHeight, paper.layout.timeAxisHeight);
    assert.ok(dark.layout.priceAxisWidth > 0);
    assert.ok(dark.layout.timeAxisHeight > 0);

    // An explicit width survives a later theme change, like every other override.
    let explicit = mergeOptionPartials({}, { layout: { priceAxisWidth: 120 } });
    assert.equal(resolveOptions(explicit).layout.priceAxisWidth, 120);
    explicit = mergeOptionPartials(explicit, { theme: 'paper' });
    const recoloured = resolveOptions(explicit);
    assert.equal(recoloured.layout.priceAxisWidth, 120, 'explicit width survives the theme change');
    assert.equal(recoloured.layout.background, themeDefaults('paper').layout.background);
    // Only the one field was overridden; the sibling metric keeps its default.
    assert.equal(recoloured.layout.timeAxisHeight, paper.layout.timeAxisHeight);
});

test('minMove finer than precision is rejected', () => {
    throws(
        () => resolveOptions({ priceFormat: { precision: 2, minMove: 0.0001 } }),
        /finer than/,
    );
    // Exactly at the precision limit is fine.
    assert.equal(resolveOptions({ priceFormat: { precision: 2, minMove: 0.01 } }).priceFormat.minMove, 0.01);
    assert.equal(resolveOptions({ priceFormat: { precision: 0, minMove: 1 } }).priceFormat.minMove, 1);
});

test('bar spacing bounds are validated and barSpacing is clamped into them', () => {
    throws(() => resolveOptions({ timeScale: { barSpacing: 0 } }), /barSpacing/);
    throws(() => resolveOptions({ timeScale: { barSpacing: Number.NaN } }), /barSpacing/);
    throws(() => resolveOptions({ timeScale: { minBarSpacing: 10, maxBarSpacing: 5 } }), /must not exceed/);
    // A barSpacing outside the bounds is pulled in rather than rejected.
    const low = resolveOptions({ timeScale: { barSpacing: 0.01, minBarSpacing: 2 } });
    assert.equal(low.timeScale.barSpacing, 2);
    const high = resolveOptions({ timeScale: { barSpacing: 9999 } });
    assert.equal(high.timeScale.barSpacing, DEFAULT_MAX_BAR_SPACING);
});

test('booleans must be booleans', () => {
    throws(() => resolveOptions({ grid: { vertLines: 'no' } }), /grid\.vertLines must be a boolean/);
    throws(() => resolveOptions({ crosshair: { visible: 1 } }), /crosshair\.visible must be a boolean/);
    throws(() => resolveOptions({ candlestick: { wickVisible: null } }), /wickVisible must be a boolean/);
    assert.equal(resolveOptions({ candlestick: { wickVisible: false } }).candlestick.wickVisible, false);
});

test('nested sections must be objects', () => {
    throws(() => resolveOptions({ grid: 'dark' }), /grid must be an object/);
    throws(() => resolveOptions({ layout: [] }), /layout must be an object/);
    throws(() => resolveOptions({ candlestick: null }), /candlestick must be an object/);
});

test('theme, locale, and timeZone are validated', () => {
    throws(() => resolveOptions({ theme: 'midnight' }), /theme must be either dark or paper/);
    throws(() => resolveOptions({ locale: '' }), /non-empty BCP 47/);
    throws(() => resolveOptions({ locale: 'not a locale' }), /BCP 47/);
    throws(() => resolveOptions({ timeZone: 'Mars/Olympus' }), /IANA/);
    assert.equal(resolveOptions({ timeZone: 'America/New_York' }).timeZone, 'America/New_York');
    assert.equal(resolveOptions({ locale: 'de-DE' }).locale, 'de-DE');
});

test('an invalid option leaves a valid one resolvable', () => {
    // Resolution is pure, so a throw cannot corrupt anything.
    throws(() => resolveOptions({ candlestick: { upColor: 'nope' } }), /upColor/);
    assert.deepEqual(resolveOptions({}), themeDefaults('dark'));
});

// --- colour resolution for the renderer -------------------------------------

test('candle colours are parsed once and cover both directions plus borders', () => {
    const colors = resolveCandleColors(resolveOptions({
        candlestick: {
            upColor: '#00ff00',
            downColor: '#ff0000',
            borderUpColor: '#0000ff',
            borderDownColor: '#ffff00',
        },
    }));
    assert.deepEqual(round(colors.up), [0, 255, 0, 255]);
    assert.deepEqual(round(colors.down), [255, 0, 0, 255]);
    assert.deepEqual(round(colors.borderUp), [0, 0, 255, 255]);
    assert.deepEqual(round(colors.borderDown), [255, 255, 0, 255]);
});

test('default spacing bounds are sane and ordered', () => {
    const timeScale = themeDefaults('dark').timeScale;
    assert.ok(timeScale.minBarSpacing > 0);
    assert.ok(timeScale.minBarSpacing < timeScale.barSpacing);
    assert.ok(timeScale.barSpacing < timeScale.maxBarSpacing);
    assert.equal(timeScale.minBarSpacing, DEFAULT_MIN_BAR_SPACING);
});

// --- the UI toggles -------------------------------------------------------------------
//
// The library reports state and the caller draws the UI, so both chrome elements the
// renderer used to draw unconditionally are now options that default to off. What is
// asserted here is the *option* � that it exists, defaults off, merges, and validates. That
// the drawing honours it cannot be asserted here at all: the headless 2D layer is a
// deliberate no-op double, so `fillText` records nothing, and that is enforced in the
// browser harness instead.

test('the crosshair readout and the last-price tag are off by default, in both themes', () => {
    for (const theme of ['dark', 'paper']) {
        const resolved = themeDefaults(theme);
        assert.equal(resolved.crosshair.readout, false, `${theme} draws no OHLC panel`);
        assert.deepEqual(resolved.crosshair.readoutBorderColor, [0, 0, 0, 0], `${theme} has no border override`);
        assert.equal(resolved.candlestick.lastPriceTag, false, `${theme} draws no last-price tag`);
        // The crosshair itself is untouched: this is about the panel, not the crosshair.
        assert.equal(resolved.crosshair.visible, true, `${theme} still shows the crosshair`);
    }
});

test('a theme switch does not resurrect the chrome', () => {
    // `themeDefaults` is called per resolve and the presets are shared objects, so a
    // caller who turned the panel on and then switched theme is the case where a leaked
    // mutation would show up as a panel nobody asked for.
    const on = resolveOptions({ theme: 'dark', crosshair: { readout: true } });
    assert.equal(on.crosshair.readout, true);
    const after = resolveOptions({ theme: 'paper' });
    assert.equal(after.crosshair.readout, false, 'the paper preset leaked the dark resolve');
});

test('the two toggles apply independently of the crosshair being visible', () => {
    const resolved = resolveOptions({ crosshair: { visible: false, readout: true } });
    assert.equal(resolved.crosshair.visible, false);
    assert.equal(resolved.crosshair.readout, true, 'a hidden crosshair can still be asked for the panel');
});

test('the readout border colour is a colour, and an unset one is transparent', () => {
    const set = resolveOptions({ crosshair: { readoutBorderColor: '#ff00ff' } });
    assert.deepEqual(set.crosshair.readoutBorderColor, [1, 0, 1, 1]);
    // Empty rather than null, because it merges as a string and `transparent` is the honest
    // "nothing configured, follow the candle" answer.
    assert.deepEqual(resolveOptions({}).crosshair.readoutBorderColor, [0, 0, 0, 0]);
    throws(
        () => resolveOptions({ crosshair: { readoutBorderColor: 'not-a-colour' } }),
        /readoutBorderColor/,
        'a bad border colour is rejected by name',
    );
});

test('both toggles reject a non-boolean', () => {
    // A string `"false"` is truthy, so accepting one would turn the panel *on* for a caller
    // who asked for it off. The library validates option types rather than coercing them.
    throws(() => resolveOptions({ crosshair: { readout: 'yes' } }), /crosshair\.readout/);
    throws(() => resolveOptions({ candlestick: { lastPriceTag: 1 } }), /candlestick\.lastPriceTag/);
});

// --- badge legibility ------------------------------------------------------------------
//
// A price-gutter tag is filled with its own colour so it reads as belonging to the line it
// labels, and the text over it was painted in `layout.textColor`. On the dark theme that is
// a light text on a saturated green or red box: reported as "the price line badge text is
// not visible", and not fixable through options, because the only knob was the *text*
// colour, which is a statement about the plot rather than a contrast calculation.
//
// So the text colour is chosen against the fill, and the badges are chips rather than holes
// punched in the plot.

test('text ink is chosen against the fill it sits on', () => {
    // The fill is given as a CSS colour and parsed, so the test says "the dark theme's own
    // down colour" rather than a hand-typed triple that could be in the wrong scale.
    const inkOn = (css) => contrastText(parseCssColor(css, 'fill'));
    assert.deepEqual(inkOn('#1ad98c'), DARK_INK, 'the dark theme up colour takes dark ink');
    assert.deepEqual(inkOn('#f24059'), DARK_INK, 'the dark theme down colour takes dark ink');
    assert.deepEqual(inkOn('#e9edf2'), DARK_INK, 'near-white takes dark ink');
    assert.deepEqual(inkOn('#0d1117'), LIGHT_INK, 'near-black takes light ink');
    assert.deepEqual(inkOn('#000000'), LIGHT_INK);
    assert.deepEqual(inkOn('#ffffff'), DARK_INK);
    assert.deepEqual(inkOn('#057a52'), LIGHT_INK, 'the paper theme up colour is dark enough for light ink');
    // The paper theme's down colour takes *light* ink even though it is a red, and the dark
    // theme's takes *dark* ink: the ratio decides, not the hue. `#c22633` is deep enough that
    // light ink is 5.3:1 against dark ink's 3.3:1, which is the whole reason this computes
    // both ratios rather than thresholding brightness.
    assert.deepEqual(inkOn('#c22633'), LIGHT_INK, 'the paper theme down colour is deep enough for light ink');
});

test('whichever ink is chosen is the legible one, by contrast ratio', () => {
    // The property, rather than a list of expected triples: for every colour the library
    // ships or a caller is likely to pick, the ink actually returned is the better of the
    // two. A threshold on brightness gets this wrong — `#f24059` reads as 120/255 and so
    // looks "dark" to a threshold near the midpoint, when dark ink on it is 5.1:1 against
    // light ink's 3.4:1.
    for (const css of ['#1ad98c', '#f24059', '#e9edf2', '#0d1117', '#22272e', '#e6edf3',
        '#057a52', '#c22633', '#f4f1e8', '#343b41', '#000000', '#ffffff', '#808080']) {
        const fill = parseCssColor(css, 'fill');
        const chosen = contrastText(fill);
        const other = chosen[0] === DARK_INK[0] ? LIGHT_INK : DARK_INK;
        assert.ok(
            contrastRatio(fill, chosen) >= contrastRatio(fill, other),
            `${css}: chose the worse ink (${contrastRatio(fill, chosen).toFixed(2)} against ` +
            `${contrastRatio(fill, other).toFixed(2)})`,
        );
        // And legible in absolute terms, not merely the better of two poor options.
        assert.ok(
            contrastRatio(fill, chosen) >= 4.5,
            `${css}: ${contrastRatio(fill, chosen).toFixed(2)}:1 is below 4.5:1`,
        );
    }
});

test('the ink keeps the fill alpha, so a translucent chip is not made opaque', () => {
    assert.equal(contrastText(parseCssColor('#e9edf280', 'fill'))[3], 128 / 255);
    assert.equal(contrastText(parseCssColor('#0d111740', 'fill'))[3], 64 / 255);
});



test('the badge colours are settable, and a bad one is rejected by name', () => {
    const set = resolveOptions({
        crosshair: { readoutBackgroundColor: '#ff0000', readoutTextColor: '#00ff00' },
        candlestick: { lastPriceTagBackgroundColor: '#0000ff', lastPriceTagTextColor: '#ffff00' },
    });
    assert.deepEqual(set.crosshair.readoutBackground, parseCssColor('#ff0000', 'x'));
    assert.deepEqual(set.crosshair.readoutText, parseCssColor('#00ff00', 'x'));
    assert.deepEqual(set.candlestick.lastPriceTagBackground, parseCssColor('#0000ff', 'x'));
    assert.deepEqual(set.candlestick.lastPriceTagText, parseCssColor('#ffff00', 'x'));
    throws(() => resolveOptions({ crosshair: { readoutBackgroundColor: 'nope' } }), /readoutBackgroundColor/);
    throws(() => resolveOptions({ crosshair: { readoutTextColor: 'nope' } }), /readoutTextColor/);
    throws(() => resolveOptions({ candlestick: { lastPriceTagBackgroundColor: 'nope' } }), /lastPriceTagBackgroundColor/);
    throws(() => resolveOptions({ candlestick: { lastPriceTagTextColor: 'nope' } }), /lastPriceTagTextColor/);
});

test('setting a badge background without a text colour leaves the ink to be chosen', () => {
    // The asymmetric case, and the one a caller hits by setting only what they care about.
    // The theme deliberately leaves the ink unset for exactly this reason: had it pinned one,
    // a caller who overrode only the background would keep the theme's ink and could put dark
    // ink on their own dark background with no way to see that from the option they set.
    const resolved = resolveOptions({ crosshair: { readoutBackgroundColor: '#ffff00' } });
    assert.deepEqual(resolved.crosshair.readoutBackground, parseCssColor('#ffff00', 'x'));
    assert.equal(resolved.crosshair.readoutText[3], 0, 'unset, so the renderer chooses');
    // And the theme leaves it unset too, which is what makes the promise above true.
    assert.equal(themeDefaults('dark').crosshair.readoutText[3], 0);
    assert.equal(themeDefaults('dark').candlestick.lastPriceTagText[3], 0);
});

test('layout.priceAxisPosition accepts left, right, both and rejects invalid strings', () => {
    assert.equal(resolveOptions({ layout: { priceAxisPosition: 'left' } }).layout.priceAxisPosition, 'left');
    assert.equal(resolveOptions({ layout: { priceAxisPosition: 'right' } }).layout.priceAxisPosition, 'right');
    assert.equal(resolveOptions({ layout: { priceAxisPosition: 'both' } }).layout.priceAxisPosition, 'both');
    throws(() => resolveOptions({ layout: { priceAxisPosition: 'middle' } }), /priceAxisPosition/);
    throws(() => resolveOptions({ layout: { priceAxisPosition: 123 } }), /priceAxisPosition/);
});

test('measureDynamicPriceAxisWidth dynamically adapts to decimal precision and sample price', () => {
    const width2 = measureDynamicPriceAxisWidth(2, 100000, 'en-US');
    assert.equal(width2, 78);
    const width0 = measureDynamicPriceAxisWidth(0, 100000, 'en-US');
    assert.ok(width0 < width2);
    assert.equal(width0, 61);
    const width8 = measureDynamicPriceAxisWidth(8, 100000, 'en-US');
    assert.ok(width8 > width2);
    assert.equal(width8, 119);
});
