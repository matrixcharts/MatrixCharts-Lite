// src/core/options.ts
//
// Option resolution for v1. Pure and DOM-free so it can be unit tested without
// a browser: parsing, validation, deep merge, and theme preset seeding all live
// here. Chart keeps the accumulated explicit partials and re-resolves from this
// module on every applyOptions, which is what makes a theme change reset to the
// preset and then re-apply the caller's overrides.
import { DEFAULT_CANDLE_SPACING_PX } from '../math/candlestickBodyWidth.js';
import { resolvePaneOptions } from './panes.js';
import { DEFAULT_MAX_WHITESPACE_RATIO } from './sessionScale.js';
export const DEFAULT_MAX_RETAINED_CANDLES = 1000000;
export const DEFAULT_MIN_BAR_SPACING = 0.5;
export const DEFAULT_MAX_BAR_SPACING = 400;
/** Non-theme-dependent defaults. Theme presets override the color fields. */
const BASE_DEFAULTS = {
    maxRetainedCandles: DEFAULT_MAX_RETAINED_CANDLES,
    timeZone: 'UTC',
    priceFormat: { precision: 2, minMove: 0.01 },
    priceScale: { mode: 'linear', inverted: false, autoScale: true },
    // One pane filling the plot, and a hairline between panes. The separator
    // colour is resolved after the grid colour, which it defaults to.
    panes: { weights: [1], separatorHeight: 1, separatorColor: '' },
    timeScale: {
        barSpacing: DEFAULT_CANDLE_SPACING_PX,
        minBarSpacing: DEFAULT_MIN_BAR_SPACING,
        maxBarSpacing: DEFAULT_MAX_BAR_SPACING,
        sessionBreaks: {
            enabled: true,
            thresholdMs: null,
            mode: 'collapsed',
            maxWhitespaceRatio: DEFAULT_MAX_WHITESPACE_RATIO,
        },
    },
};
/** Colors and chrome seeded per theme. Explicit overrides are re-applied on top. */
const THEME_PRESETS = {
    dark: {
        layout: { background: '#0b0f17', textColor: '#c6d0df' },
        volume: { colors: { up: 'rgba(26, 217, 140, 0.5)', down: 'rgba(242, 64, 89, 0.5)' } },
        grid: { vertLines: true, horzLines: true, color: 'rgba(184, 198, 218, 0.13)' },
        crosshair: { visible: true, color: 'rgba(0, 220, 255, 0.9)' },
        candlestick: {
            upColor: '#1ad98c',
            downColor: '#f24059',
            wickVisible: true,
            borderVisible: false,
            borderUpColor: '#1ad98c',
            borderDownColor: '#f24059',
        },
    },
    paper: {
        layout: { background: '#f4f1e8', textColor: '#343b41' },
        volume: { colors: { up: 'rgba(5, 122, 82, 0.45)', down: 'rgba(194, 38, 51, 0.45)' } },
        grid: { vertLines: true, horzLines: true, color: 'rgba(54, 62, 70, 0.15)' },
        crosshair: { visible: true, color: 'rgba(0, 111, 145, 0.9)' },
        candlestick: {
            upColor: '#057a52',
            downColor: '#c22633',
            wickVisible: true,
            borderVisible: false,
            borderUpColor: '#057a52',
            borderDownColor: '#c22633',
        },
    },
};
function fail(message) {
    throw new Error(`MatrixCharts: ${message}`);
}
function requireBoolean(value, label) {
    if (typeof value !== 'boolean')
        fail(`${label} must be a boolean, received ${describe(value)}.`);
    return value;
}
function requireIntegerInRange(value, label, min, max) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        fail(`${label} must be an integer between ${min} and ${max}, received ${describe(value)}.`);
    }
    return value;
}
function requirePositiveFinite(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        fail(`${label} must be a positive finite number, received ${describe(value)}.`);
    }
    return value;
}
const CANDLE_STYLES = [
    'candlestick', 'hollow', 'ohlc', 'baseline', 'line', 'area',
];
function requireCandleStyle(value) {
    if (typeof value !== 'string' || !CANDLE_STYLES.includes(value)) {
        fail(`candlestick.style must be one of ${CANDLE_STYLES.join(', ')}, received ${describe(value)}.`);
    }
    return value;
}
/** The same colour with a replaced alpha, for fills derived from a stroke colour. */
function withAlpha(rgba, alpha) {
    return [rgba[0], rgba[1], rgba[2], alpha];
}
/** A finite number within an inclusive range. */
function requireNumberInRange(value, label, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        fail(`${label} must be a number between ${min} and ${max}, received ${describe(value)}.`);
    }
    return value;
}
function requirePlainObject(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(`${label} must be an object, received ${describe(value)}.`);
    }
    return value;
}
function describe(value) {
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null)
        return String(value);
    if (value === undefined)
        return 'undefined';
    return Object.prototype.toString.call(value);
}
const HEX_PATTERN = /^#([0-9a-f]{3,8})$/;
const RGB_PATTERN = /^rgba?\(([^()]*)\)$/;
function clampChannel(value) {
    return Math.min(255, Math.max(0, value));
}
function parseChannel(text, label, color) {
    const trimmed = text.trim();
    if (trimmed.endsWith('%')) {
        const percent = Number(trimmed.slice(0, -1));
        if (!Number.isFinite(percent))
            fail(`${label} is not a valid colour: ${JSON.stringify(color)}.`);
        return clampChannel((percent / 100) * 255);
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric))
        fail(`${label} is not a valid colour: ${JSON.stringify(color)}.`);
    return clampChannel(numeric);
}
function parseAlpha(text, label, color) {
    const trimmed = text.trim();
    const numeric = trimmed.endsWith('%')
        ? Number(trimmed.slice(0, -1)) / 100
        : Number(trimmed);
    if (!Number.isFinite(numeric))
        fail(`${label} is not a valid colour: ${JSON.stringify(color)}.`);
    return Math.min(1, Math.max(0, numeric));
}
/**
 * Parses a CSS colour into normalised RGBA. Accepts `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`, `rgba()` with numeric or percentage channels, and
 * `transparent`. Channels are clamped the way CSS clamps them. Anything else
 * throws, so a typo fails at the apply call rather than rendering black.
 */
export function parseCssColor(value, label) {
    if (typeof value !== 'string')
        fail(`${label} must be a CSS color string, received ${describe(value)}.`);
    const text = value.trim().toLowerCase();
    if (text === 'transparent')
        return [0, 0, 0, 0];
    const hex = HEX_PATTERN.exec(text);
    if (hex) {
        const digits = hex[1];
        const expand = (part) => parseInt(part.length === 1 ? part + part : part, 16);
        if (digits.length === 3 || digits.length === 4) {
            return [
                expand(digits[0]) / 255,
                expand(digits[1]) / 255,
                expand(digits[2]) / 255,
                digits.length === 4 ? expand(digits[3]) / 255 : 1,
            ];
        }
        if (digits.length === 6 || digits.length === 8) {
            const pair = (index) => parseInt(digits.slice(index * 2, index * 2 + 2), 16) / 255;
            return [pair(0), pair(1), pair(2), digits.length === 8 ? pair(3) : 1];
        }
        fail(`${label} is not a valid hex colour: ${JSON.stringify(value)}.`);
    }
    const functional = RGB_PATTERN.exec(text);
    if (functional) {
        const parts = functional[1].split(/[,/\s]+/).filter((part) => part.length > 0);
        if (parts.length !== 3 && parts.length !== 4) {
            fail(`${label} needs 3 or 4 colour components, received ${describe(value)}.`);
        }
        const alpha = parts.length === 4 ? parseAlpha(parts[3], label, value) : 1;
        return [
            parseChannel(parts[0], label, value) / 255,
            parseChannel(parts[1], label, value) / 255,
            parseChannel(parts[2], label, value) / 255,
            alpha,
        ];
    }
    return fail(`${label} is not a CSS color this chart understands: ${describe(value)}. `
        + 'Use #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), or transparent.');
}
/** Validates a colour and returns it unchanged, so resolution stays declarative. */
function requireColor(value, label) {
    parseCssColor(value, label);
    return value;
}
/** Calculates luminance for auto-contrast. */
export function luminanceOf(rgba) {
    const sRGB = [rgba[0], rgba[1], rgba[2]].map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * sRGB[0] + 0.7152 * sRGB[1] + 0.0722 * sRGB[2];
}
/** Chooses a high-contrast text colour. */
export function contrastText(bgRgba) {
    const bgLum = luminanceOf(bgRgba);
    const darkInk = [11 / 255, 15 / 255, 20 / 255, bgRgba[3]];
    const lightInk = [240 / 255, 246 / 255, 252 / 255, bgRgba[3]];
    const darkLum = luminanceOf(darkInk);
    const lightLum = luminanceOf(lightInk);
    const darkRatio = (Math.max(bgLum, darkLum) + 0.05) / (Math.min(bgLum, darkLum) + 0.05);
    const lightRatio = (Math.max(bgLum, lightLum) + 0.05) / (Math.min(bgLum, lightLum) + 0.05);
    return darkRatio >= lightRatio ? darkInk : lightInk;
}
export function priceLabelFormatter(locale, precision) {
    const clamped = Math.max(0, Math.min(20, isNaN(precision) ? 0 : Math.floor(precision)));
    return new Intl.NumberFormat(locale, {
        minimumFractionDigits: clamped,
        maximumFractionDigits: clamped,
    });
}
function requireLocale(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        fail(`locale must be a non-empty BCP 47 tag, received ${describe(value)}.`);
    }
    try {
        return new Intl.NumberFormat(value).resolvedOptions().locale;
    }
    catch {
        return fail(`locale is not a valid BCP 47 tag: ${JSON.stringify(value)}.`);
    }
}
/**
 * A CSS-pixel measurement for a reserved gutter. Must be a finite, non-negative
 * number: a negative width would invert the plot rect, and `Infinity` or `NaN`
 * would collapse it, both of which reach the geometry rather than failing here.
 */
function requireNonNegativeNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(`${label} must be a finite, non-negative number of CSS pixels, received ${describe(value)}.`);
    }
    return value;
}
function requireTimeZone(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        fail(`timeZone must be a non-empty IANA zone name, received ${describe(value)}.`);
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
    }
    catch {
        return fail(`timeZone is not a valid IANA zone name: ${JSON.stringify(value)}.`);
    }
    return value;
}
function requireTheme(value) {
    if (value !== 'dark' && value !== 'paper') {
        fail(`theme must be either dark or paper, received ${describe(value)}.`);
    }
    return value;
}
export function runtimeLocale() {
    return new Intl.NumberFormat().resolvedOptions().locale;
}
/**
 * Default gutter sizes, in CSS pixels. Not theme-dependent: they are layout
 * metrics rather than colours, so a theme change must not resize the plot.
 */
/**
 * Calculates the dynamic price axis gutter width in CSS pixels based on
 * the configured price precision, locale, font metrics, and sample price values.
 */
export function measureDynamicPriceAxisWidth(precision = 2, samplePrice = 100000, locale = 'en-US', ctx) {
    let formatted;
    try {
        formatted = new Intl.NumberFormat(locale, {
            minimumFractionDigits: precision,
            maximumFractionDigits: precision,
            useGrouping: true,
        }).format(samplePrice);
    }
    catch {
        formatted = samplePrice.toFixed(precision);
    }
    let textWidth = 0;
    if (ctx && typeof ctx.measureText === 'function') {
        ctx.save();
        ctx.font = '11px sans-serif';
        textWidth = ctx.measureText(formatted).width;
        ctx.restore();
    }
    if (!(textWidth > 0)) {
        let w = 0;
        for (const ch of formatted) {
            if (ch === ',' || ch === '.')
                w += 3.5;
            else if (ch >= '0' && ch <= '9')
                w += 6.8;
            else
                w += 7.0;
        }
        textWidth = w;
    }
    return Math.max(50, Math.round(textWidth + 17));
}
const DEFAULT_LAYOUT_METRICS = {
    priceAxisWidth: 78,
    timeAxisHeight: 22,
    priceAxisPosition: 'left',
    autoPriceAxisWidth: true,
};
/**
 * Volume defaults that are not theme colours. The histogram is off by default,
 * so a series with no volume is unaffected, and occupies the bottom fifth of the
 * plot when switched on.
 */
const DEFAULT_VOLUME_METRICS = {
    visible: false,
    heightRatio: 0.2,
    pane: 0,
};
/**
 * Default candlestick rendering and colours for the non-candlestick styles.
 * Not theme colours for `style` and `baselinePrice`, which are choices rather
 * than appearance; the line and area colours follow each theme's up colour so a
 * line chart reads as belonging to the same chart as its candles.
 */
const DEFAULT_CANDLE_STYLE = 'candlestick';
/** Preset-only snapshot for a theme, with no caller overrides applied. */
export function themeDefaults(theme) {
    const preset = THEME_PRESETS[theme];
    return {
        ...BASE_DEFAULTS,
        theme,
        locale: runtimeLocale(),
        priceFormat: { ...BASE_DEFAULTS.priceFormat },
        layout: { ...preset.layout, ...DEFAULT_LAYOUT_METRICS },
        priceScale: { ...BASE_DEFAULTS.priceScale },
        volume: {
            ...DEFAULT_VOLUME_METRICS,
            colors: {
                up: parseCssColor(preset.volume.colors.up, 'volume.upColor'),
                down: parseCssColor(preset.volume.colors.down, 'volume.downColor'),
            },
        },
        grid: { ...preset.grid },
        // A pane division reads as part of the grid, so it defaults to the grid
        // colour rather than inventing a colour of its own.
        // `sessionBreaks` is copied, not shared. `applyOptions` merges it field by field
        // *in place* — it is a patch, so it writes into whatever object it is handed — and
        // a shallow spread here handed it `BASE_DEFAULTS`' own nested object. One chart
        // configuring its gaps therefore rewrote the defaults for every chart created
        // after it, in the same process: two charts on a page where the first disabled
        // session breaks silently disabled them for the second, and for a third that never
        // mentioned them. `panes.weights` is copied for the same reason — it is currently
        // replaced rather than mutated, which is one `push` away from the identical bug.
        timeScale: {
            ...BASE_DEFAULTS.timeScale,
            sessionBreaks: { ...BASE_DEFAULTS.timeScale.sessionBreaks },
        },
        panes: {
            ...BASE_DEFAULTS.panes,
            weights: [...BASE_DEFAULTS.panes.weights],
            separatorColor: preset.grid.color,
        },
        crosshair: {
            ...preset.crosshair,
            readout: false,
            readoutBorderColor: parseCssColor('transparent', ''),
            readoutBackground: parseCssColor('transparent', ''),
            readoutText: parseCssColor('transparent', ''),
            axisLabelBackground: parseCssColor(preset.crosshair.color, ''),
            axisLabelText: parseCssColor('transparent', ''),
        },
        candlestick: {
            ...preset.candlestick,
            style: DEFAULT_CANDLE_STYLE,
            baselinePrice: null,
            lineColor: parseCssColor(preset.candlestick.upColor, 'candlestick.upColor'),
            areaFillColor: withAlpha(parseCssColor(preset.candlestick.upColor, 'candlestick.upColor'), 0.25),
            lastPriceTag: false,
            lastPriceTagBackground: parseCssColor('transparent', ''),
            lastPriceTagText: parseCssColor('transparent', ''),
        },
    };
}
/**
 * Resolves caller options over the theme preset. Called fresh on every
 * `applyOptions`, so a `theme` change re-seeds from the new preset and then
 * re-applies whatever the caller set explicitly under the old theme.
 */
export function resolveOptions(partial, fallbackTheme = 'dark') {
    const theme = partial.theme === undefined ? fallbackTheme : requireTheme(partial.theme);
    const resolved = themeDefaults(theme);
    if (partial.maxRetainedCandles !== undefined) {
        resolved.maxRetainedCandles = requireIntegerInRange(partial.maxRetainedCandles, 'maxRetainedCandles', 1, Number.MAX_SAFE_INTEGER);
    }
    if (partial.locale !== undefined)
        resolved.locale = requireLocale(partial.locale);
    if (partial.timeZone !== undefined)
        resolved.timeZone = requireTimeZone(partial.timeZone);
    if (partial.priceScale !== undefined) {
        const scale = requirePlainObject(partial.priceScale, 'priceScale');
        if (scale.mode !== undefined) {
            if (scale.mode !== 'linear' && scale.mode !== 'log') {
                fail('priceScale.mode must be \'linear\' or \'log\'.');
            }
            resolved.priceScale.mode = scale.mode;
        }
        if (scale.inverted !== undefined) {
            resolved.priceScale.inverted = requireBoolean(scale.inverted, 'priceScale.inverted');
        }
        if (scale.autoScale !== undefined) {
            resolved.priceScale.autoScale = requireBoolean(scale.autoScale, 'priceScale.autoScale');
        }
    }
    if (partial.timeScale?.sessionBreaks !== undefined) {
        const gaps = requirePlainObject(partial.timeScale.sessionBreaks, 'timeScale.sessionBreaks');
        const target = resolved.timeScale.sessionBreaks;
        if (gaps.enabled !== undefined)
            target.enabled = requireBoolean(gaps.enabled, 'timeScale.sessionBreaks.enabled');
        if (gaps.thresholdMs !== undefined) {
            target.thresholdMs = requireNonNegativeNumber(gaps.thresholdMs, 'timeScale.sessionBreaks.thresholdMs');
        }
        if (gaps.mode !== undefined) {
            if (gaps.mode !== 'collapsed' && gaps.mode !== 'proportional') {
                fail('timeScale.sessionBreaks.mode must be \'collapsed\' or \'proportional\'.');
            }
            target.mode = gaps.mode;
        }
        if (gaps.maxWhitespaceRatio !== undefined) {
            const ratio = requireNonNegativeNumber(gaps.maxWhitespaceRatio, 'timeScale.sessionBreaks.maxWhitespaceRatio');
            // A negative cap is not a tight cap, it is a sign error, and it would make
            // the sizing maths return negative slots — bars drawn inside each other.
            if (ratio < 0)
                fail('timeScale.sessionBreaks.maxWhitespaceRatio cannot be negative.');
            if (!Number.isFinite(ratio))
                fail('timeScale.sessionBreaks.maxWhitespaceRatio must be finite.');
            target.maxWhitespaceRatio = ratio;
        }
    }
    if (partial.panes !== undefined) {
        const panes = requirePlainObject(partial.panes, 'panes');
        if (panes.weights !== undefined) {
            if (!Array.isArray(panes.weights)) {
                fail('panes.weights must be an array of one positive weight per pane.');
            }
            // Validated by the pane module, which owns the layout rule and its
            // error strings, rather than restated here.
            resolved.panes.weights = [...resolvePaneOptions({
                    weights: panes.weights,
                    separatorHeight: resolved.panes.separatorHeight,
                }).weights];
        }
        if (panes.separatorHeight !== undefined) {
            // requirePlainObject widens its fields, so the value is handed to the
            // pane resolver as a number and validated there rather than cast.
            resolved.panes.separatorHeight = resolvePaneOptions({
                weights: resolved.panes.weights,
                separatorHeight: panes.separatorHeight,
            }).separatorHeight;
        }
        if (panes.separatorColor !== undefined) {
            resolved.panes.separatorColor = requireColor(panes.separatorColor, 'panes.separatorColor');
        }
    }
    if (partial.volume !== undefined) {
        const volume = requirePlainObject(partial.volume, 'volume');
        if (volume.visible !== undefined) {
            resolved.volume.visible = requireBoolean(volume.visible, 'volume.visible');
        }
        if (volume.heightRatio !== undefined) {
            resolved.volume.heightRatio = requireNumberInRange(volume.heightRatio, 'volume.heightRatio', 0, 1);
            if (resolved.volume.heightRatio <= 0) {
                fail('volume.heightRatio must be greater than 0; a histogram with no height draws nothing.');
            }
        }
        if (volume.pane !== undefined) {
            resolved.volume.pane = requireIntegerInRange(volume.pane, 'volume.pane', 0, 50);
        }
        // A single colour applies to both directions unless a direction overrides
        // it, so the common case is one option rather than two identical ones.
        if (volume.color !== undefined) {
            const shared = requireColor(volume.color, 'volume.color');
            resolved.volume.colors = {
                up: parseCssColor(shared, 'volume.color'),
                down: parseCssColor(shared, 'volume.color'),
            };
        }
        if (volume.upColor !== undefined) {
            resolved.volume.colors.up = parseCssColor(requireColor(volume.upColor, 'volume.upColor'), 'volume.upColor');
        }
        if (volume.downColor !== undefined) {
            resolved.volume.colors.down = parseCssColor(requireColor(volume.downColor, 'volume.downColor'), 'volume.downColor');
        }
    }
    if (partial.priceFormat !== undefined) {
        const priceFormat = requirePlainObject(partial.priceFormat, 'priceFormat');
        if (priceFormat.precision !== undefined) {
            resolved.priceFormat.precision = requireIntegerInRange(priceFormat.precision, 'priceFormat.precision', 0, 20);
        }
        if (priceFormat.minMove !== undefined) {
            resolved.priceFormat.minMove = requirePositiveFinite(priceFormat.minMove, 'priceFormat.minMove');
        }
        if (resolved.priceFormat.minMove < Math.pow(10, -resolved.priceFormat.precision)) {
            fail(`priceFormat.minMove (${resolved.priceFormat.minMove}) is finer than `
                + `priceFormat.precision (${resolved.priceFormat.precision}) can show.`);
        }
    }
    if (partial.layout !== undefined) {
        const layout = requirePlainObject(partial.layout, 'layout');
        if (layout.background !== undefined)
            resolved.layout.background = requireColor(layout.background, 'layout.background');
        if (layout.textColor !== undefined)
            resolved.layout.textColor = requireColor(layout.textColor, 'layout.textColor');
        if (layout.priceAxisWidth !== undefined) {
            resolved.layout.priceAxisWidth = requireNonNegativeNumber(layout.priceAxisWidth, 'layout.priceAxisWidth');
            resolved.layout.autoPriceAxisWidth = false;
        }
        if (layout.autoPriceAxisWidth !== undefined) {
            resolved.layout.autoPriceAxisWidth = requireBoolean(layout.autoPriceAxisWidth, 'layout.autoPriceAxisWidth');
        }
        if (layout.timeAxisHeight !== undefined) {
            resolved.layout.timeAxisHeight = requireNonNegativeNumber(layout.timeAxisHeight, 'layout.timeAxisHeight');
        }
        if (layout.priceAxisPosition !== undefined) {
            if (layout.priceAxisPosition !== 'left' && layout.priceAxisPosition !== 'right' && layout.priceAxisPosition !== 'both') {
                fail(`layout.priceAxisPosition must be 'left', 'right', or 'both'; received ${JSON.stringify(layout.priceAxisPosition)}.`);
            }
            resolved.layout.priceAxisPosition = layout.priceAxisPosition;
        }
    }
    if (resolved.layout.autoPriceAxisWidth && partial.layout?.priceAxisWidth === undefined) {
        resolved.layout.priceAxisWidth = measureDynamicPriceAxisWidth(resolved.priceFormat.precision, 100000, resolved.locale);
    }
    if (partial.grid !== undefined) {
        const grid = requirePlainObject(partial.grid, 'grid');
        if (grid.vertLines !== undefined)
            resolved.grid.vertLines = requireBoolean(grid.vertLines, 'grid.vertLines');
        if (grid.horzLines !== undefined)
            resolved.grid.horzLines = requireBoolean(grid.horzLines, 'grid.horzLines');
        if (grid.color !== undefined)
            resolved.grid.color = requireColor(grid.color, 'grid.color');
    }
    if (partial.crosshair !== undefined) {
        const crosshair = requirePlainObject(partial.crosshair, 'crosshair');
        if (crosshair.visible !== undefined)
            resolved.crosshair.visible = requireBoolean(crosshair.visible, 'crosshair.visible');
        if (crosshair.color !== undefined)
            resolved.crosshair.color = requireColor(crosshair.color, 'crosshair.color');
        if (crosshair.readout !== undefined)
            resolved.crosshair.readout = requireBoolean(crosshair.readout, 'crosshair.readout');
        if (crosshair.readoutBorderColor !== undefined)
            resolved.crosshair.readoutBorderColor = parseCssColor(requireColor(crosshair.readoutBorderColor, 'crosshair.readoutBorderColor'), 'crosshair.readoutBorderColor');
        if (crosshair.readoutBackgroundColor !== undefined)
            resolved.crosshair.readoutBackground = parseCssColor(requireColor(crosshair.readoutBackgroundColor, 'crosshair.readoutBackgroundColor'), 'crosshair.readoutBackgroundColor');
        if (crosshair.readoutTextColor !== undefined)
            resolved.crosshair.readoutText = parseCssColor(requireColor(crosshair.readoutTextColor, 'crosshair.readoutTextColor'), 'crosshair.readoutTextColor');
        if (crosshair.axisLabelBackgroundColor !== undefined)
            resolved.crosshair.axisLabelBackground = parseCssColor(requireColor(crosshair.axisLabelBackgroundColor, 'crosshair.axisLabelBackgroundColor'), 'crosshair.axisLabelBackgroundColor');
        if (crosshair.axisLabelTextColor !== undefined)
            resolved.crosshair.axisLabelText = parseCssColor(requireColor(crosshair.axisLabelTextColor, 'crosshair.axisLabelTextColor'), 'crosshair.axisLabelTextColor');
    }
    if (partial.timeScale !== undefined) {
        const timeScale = requirePlainObject(partial.timeScale, 'timeScale');
        if (timeScale.barSpacing !== undefined) {
            resolved.timeScale.barSpacing = requirePositiveFinite(timeScale.barSpacing, 'timeScale.barSpacing');
        }
        if (timeScale.minBarSpacing !== undefined) {
            resolved.timeScale.minBarSpacing = requirePositiveFinite(timeScale.minBarSpacing, 'timeScale.minBarSpacing');
        }
        if (timeScale.maxBarSpacing !== undefined) {
            resolved.timeScale.maxBarSpacing = requirePositiveFinite(timeScale.maxBarSpacing, 'timeScale.maxBarSpacing');
        }
        if (resolved.timeScale.minBarSpacing > resolved.timeScale.maxBarSpacing) {
            fail(`timeScale.minBarSpacing (${resolved.timeScale.minBarSpacing}) must not exceed `
                + `timeScale.maxBarSpacing (${resolved.timeScale.maxBarSpacing}).`);
        }
        if (resolved.timeScale.barSpacing < resolved.timeScale.minBarSpacing) {
            resolved.timeScale.barSpacing = resolved.timeScale.minBarSpacing;
        }
        if (resolved.timeScale.barSpacing > resolved.timeScale.maxBarSpacing) {
            resolved.timeScale.barSpacing = resolved.timeScale.maxBarSpacing;
        }
    }
    if (partial.candlestick !== undefined) {
        const candlestick = requirePlainObject(partial.candlestick, 'candlestick');
        if (candlestick.upColor !== undefined)
            resolved.candlestick.upColor = requireColor(candlestick.upColor, 'candlestick.upColor');
        if (candlestick.downColor !== undefined)
            resolved.candlestick.downColor = requireColor(candlestick.downColor, 'candlestick.downColor');
        if (candlestick.borderUpColor !== undefined)
            resolved.candlestick.borderUpColor = requireColor(candlestick.borderUpColor, 'candlestick.borderUpColor');
        if (candlestick.borderDownColor !== undefined)
            resolved.candlestick.borderDownColor = requireColor(candlestick.borderDownColor, 'candlestick.borderDownColor');
        if (candlestick.wickVisible !== undefined)
            resolved.candlestick.wickVisible = requireBoolean(candlestick.wickVisible, 'candlestick.wickVisible');
        if (candlestick.borderVisible !== undefined)
            resolved.candlestick.borderVisible = requireBoolean(candlestick.borderVisible, 'candlestick.borderVisible');
        if (candlestick.style !== undefined) {
            resolved.candlestick.style = requireCandleStyle(candlestick.style);
        }
        if (candlestick.baselinePrice !== undefined) {
            resolved.candlestick.baselinePrice = requireNonNegativeNumber(candlestick.baselinePrice, 'candlestick.baselinePrice');
        }
        if (candlestick.lineColor !== undefined) {
            resolved.candlestick.lineColor = parseCssColor(requireColor(candlestick.lineColor, 'candlestick.lineColor'), 'candlestick.lineColor');
        }
        if (candlestick.areaFillColor !== undefined) {
            resolved.candlestick.areaFillColor = parseCssColor(requireColor(candlestick.areaFillColor, 'candlestick.areaFillColor'), 'candlestick.areaFillColor');
        }
        if (candlestick.lastPriceTag !== undefined)
            resolved.candlestick.lastPriceTag = requireBoolean(candlestick.lastPriceTag, 'candlestick.lastPriceTag');
        if (candlestick.lastPriceTagBackgroundColor !== undefined)
            resolved.candlestick.lastPriceTagBackground = parseCssColor(requireColor(candlestick.lastPriceTagBackgroundColor, 'candlestick.lastPriceTagBackgroundColor'), 'candlestick.lastPriceTagBackgroundColor');
        if (candlestick.lastPriceTagTextColor !== undefined)
            resolved.candlestick.lastPriceTagText = parseCssColor(requireColor(candlestick.lastPriceTagTextColor, 'candlestick.lastPriceTagTextColor'), 'candlestick.lastPriceTagTextColor');
    }
    return resolved;
}
/**
 * Accumulates caller partials. Kept separate from the resolved snapshot so a
 * theme switch can re-seed from the new preset and still honour these.
 *
 * `maxRetainedCandles` is constructor-only in v1: changing it under a live
 * viewport means rebuilding the retained pyramid, so `applyOptions` rejects it
 * rather than silently ignoring it. The constructor is the one place it is legal.
 */
export function mergeOptionPartials(base, patch, source = 'applyOptions') {
    if (source === 'applyOptions' && patch.maxRetainedCandles !== undefined) {
        fail('maxRetainedCandles is constructor-only in v1 and cannot be changed with applyOptions().');
    }
    const merged = { ...base };
    const nestedKeys = ['priceFormat', 'layout', 'volume', 'priceScale', 'panes', 'grid', 'crosshair', 'timeScale', 'candlestick'];
    for (const key of nestedKeys) {
        const patchValue = patch[key];
        if (patchValue === undefined)
            continue;
        merged[key] = { ...(base[key] ?? {}), ...patchValue };
    }
    for (const key of ['theme', 'locale', 'timeZone']) {
        if (patch[key] !== undefined)
            merged[key] = patch[key];
    }
    if (patch.maxRetainedCandles !== undefined) {
        merged.maxRetainedCandles = patch.maxRetainedCandles;
    }
    return merged;
}
export function resolveCandleColors(options) {
    return {
        up: parseCssColor(options.candlestick.upColor, 'candlestick.upColor'),
        down: parseCssColor(options.candlestick.downColor, 'candlestick.downColor'),
        borderUp: parseCssColor(options.candlestick.borderUpColor, 'candlestick.borderUpColor'),
        borderDown: parseCssColor(options.candlestick.borderDownColor, 'candlestick.borderDownColor'),
    };
}
