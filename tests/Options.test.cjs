// Pure tests for src/core/options.ts: colour parsing, validation, deep merge,
// theme preset seeding, and override precedence. No DOM, no canvas.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    DEFAULT_MAX_BAR_SPACING,
    DEFAULT_MIN_BAR_SPACING,
    mergeOptionPartials,
    parseCssColor,
    resolveCandleColors,
    resolveOptions,
    themeDefaults,
} = require('../.test-build/core/options.js');

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
