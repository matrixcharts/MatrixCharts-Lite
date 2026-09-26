// src/core/options.ts
//
// Option resolution for v1. Pure and DOM-free so it can be unit tested without
// a browser: parsing, validation, deep merge, and theme preset seeding all live
// here. Chart keeps the accumulated explicit partials and re-resolves from this
// module on every applyOptions, which is what makes a theme change reset to the
// preset and then re-apply the caller's overrides.

import { DEFAULT_CANDLE_SPACING_PX } from '../math/candlestickBodyWidth.js';
import { resolvePaneOptions } from './panes.js';

export type ChartTheme = 'dark' | 'paper';

export interface PriceFormatOptions {
    /** Maximum fraction digits on price labels. Integer 0-20. */
    precision?: number;
    /** Smallest representable price step. Price ticks snap to a multiple of it. */
    minMove?: number;
}

export interface LayoutOptions {
    /** Plot background. Also used for the chart container and label plates. */
    background?: string;
    /** Axis labels, crosshair readout, and any other text. */
    textColor?: string;
    /**
     * Width reserved for the price axis, in CSS pixels. Price labels are drawn in
     * this gutter, right-aligned against the plot, so no longer overlap a candle.
     *
     * Additive in 1.x. Sized in CSS pixels rather than measured from the label
     * text, because the widest label depends on the visible price range, which
     * depends on the plot height, which depends on this width. The default fits a
     * separated price of up to six digits with two decimals; widen it for
     * instruments quoted with more digits or a longer grouping.
     */
    priceAxisWidth?: number;
    /** Height reserved for the time axis, in CSS pixels. Additive in 1.x. */
    timeAxisHeight?: number;
}

export interface VolumeOptions {
    /**
     * Whether to draw the volume histogram. Additive in 1.x. Off by default, so a
     * series that carries no volume draws nothing extra.
     */
    visible?: boolean;
    /** One colour for every bar. Ignored when `upColor` or `downColor` is set. */
    color?: string;
    /** Bars for candles that closed at or above their open. */
    upColor?: string;
    /** Bars for candles that closed below their open. */
    downColor?: string;
    /**
     * Fraction of the plot height the histogram occupies, from the bottom.
     * Additive in 1.x. Must be greater than 0 and at most 1.
     *
     * The histogram is scaled to its own range rather than the price range, so it
     * never distorts the price axis. It shares the price pane; a separate pane for
     * it is expressed with `panes.weights` and its own `pane` index.
     */
    heightRatio?: number;
}

/**
 * Panes: horizontal bands of the plot area, each with its own vertical scale.
 * Additive in 1.x.
 *
 * Pane 0 is the price pane and always exists. A pane is what lets an indicator
 * that does not measure price — an RSI, a MACD histogram — be drawn readably
 * instead of being squashed into the price range. Every pane shares the
 * horizontal transform, because every series is indexed on the same time axis;
 * only the vertical one differs.
 */
export interface PanesOptions {
    /**
     * Relative heights, one per pane, index 0 being the price pane. Absent means
     * a single pane filling the plot, which is the behaviour without this feature.
     *
     * Declaring the weights is what *creates* the panes, so a series naming a
     * higher index without them is rejected rather than silently dropped into a
     * pane that does not exist. A weight must be greater than zero.
     */
    weights?: number[];
    /**
     * Space reserved between panes, CSS pixels. Defaults to 1. A single pane has
     * nothing to separate from, so it is never subtracted.
     */
    separatorHeight?: number;
    /**
     * Colour of the line between panes. Defaults to the grid colour, so a pane
     * division reads as part of the grid rather than as a new piece of chrome.
     */
    separatorColor?: string;
}

/**
 * How the price pane's vertical axis is scaled. Additive in 1.x.
 *
 * `mode` is a property of the *price* pane only. A pane holding something that is
 * not a price — an RSI, a MACD histogram — stays linear whatever this is set to,
 * because a log axis has no reading for a bounded oscillator and rounding its
 * labels to a tradable increment is meaningless.
 */
export interface PriceScaleOptions {
    /**
     * `linear` or `log`. Defaults to `linear`, so a chart with no log in it behaves
     * exactly as it did before this option existed.
     *
     * Log is not a different transform: the axis is still affine, over log of the
     * price rather than over the price itself. That is why this needs no new uniform
     * and no second program.
     */
    mode?: 'linear' | 'log';
    /**
     * Whether higher prices sit lower down the pane. Defaults to false.
     */
    inverted?: boolean;
    /**
     * Whether the price pane follows the visible data. Defaults to true, which is
     * the behaviour without this option. Set it false to lock the pane to whatever
     * `setPriceRange` last established, which is what a trader comparing two
     * instruments on the same scale needs.
     */
    autoScale?: boolean;
}

export interface GridOptions {
    vertLines?: boolean;
    horzLines?: boolean;
    /** Any CSS color; alpha is honoured for grid lines. */
    color?: string;
}

export interface CrosshairOptions {
    visible?: boolean;
    /** Additive in 1.x: lets the crosshair be themed alongside the plot. */
    color?: string;
}

export interface TimeScaleOptions {
    /** CSS px per candle index. */
    barSpacing?: number;
    /** Lower clamp applied to wheel and pinch zoom. */
    minBarSpacing?: number;
    /** Upper clamp applied to wheel and pinch zoom. */
    maxBarSpacing?: number;
}

/**
 * How the OHLC series is drawn. All six render the same candle data on the same
 * time axis and the same price scale; they differ only in how vertices are
 * generated, so switching between them costs nothing but a repaint.
 *
 * Additive in 1.x.
 */
export type CandleStyle =
    /** Filled body between open and close, with a wick spanning low to high. */
    | 'candlestick'
    /** Outline only: the body is left unfilled and framed in the body colour. */
    | 'hollow'
    /** No body. A vertical low-to-high line with a left tick at open and a right tick at close. */
    | 'ohlc'
    /** Filled body plus a horizontal reference line across the visible range. */
    | 'baseline'
    /** A polyline through the close of every candle, with no body or wick. */
    | 'line'
    /** The close polyline with the area beneath it filled. */
    | 'area';

export interface CandlestickOptions {
    upColor?: string;
    downColor?: string;
    wickVisible?: boolean;
    /** Draws a 1 device-pixel frame inside the body outline. Needs no extra pass. */
    borderVisible?: boolean;
    borderUpColor?: string;
    borderDownColor?: string;
    /** Additive in 1.x. Defaults to `'candlestick'`. */
    style?: CandleStyle;
    /**
     * Reference price for the `'baseline'` style. Additive in 1.x. When absent the
     * close of the first visible candle is used, so the line is always on screen
     * rather than far outside the fitted range.
     */
    baselinePrice?: number;
    /** Colour of the `'line'` and `'area'` styles. Additive in 1.x. */
    lineColor?: string;
    /**
     * Fill beneath the `'area'` style, as a colour with its own alpha. Additive in
     * 1.x. Defaults to `lineColor` at half alpha.
     */
    areaFillColor?: string;
}

/** Caller-supplied options. Every field is optional and merges over the preset. */
export interface ChartOptions {
    /** Constructor-only in v1. `applyOptions` rejects it. */
    maxRetainedCandles?: number;
    theme?: ChartTheme;
    /** BCP 47 tag for price and time labels. Defaults to the runtime locale. */
    locale?: string;
    /** IANA zone for time labels. Defaults to 'UTC' so labels are deterministic. */
    timeZone?: string;
    priceFormat?: PriceFormatOptions;
    layout?: LayoutOptions;
    volume?: VolumeOptions;
    priceScale?: PriceScaleOptions;
    panes?: PanesOptions;
    grid?: GridOptions;
    crosshair?: CrosshairOptions;
    timeScale?: TimeScaleOptions;
    candlestick?: CandlestickOptions;
}

export interface ResolvedPriceFormat { precision: number; minMove: number }
export interface ResolvedLayout {
    background: string;
    textColor: string;
    priceAxisWidth: number;
    timeAxisHeight: number;
}
export interface ResolvedGrid { vertLines: boolean; horzLines: boolean; color: string }

/** The histogram's RGBA channels, resolved from CSS when options are applied. */
export interface ResolvedVolumeColors {
    up: [number, number, number, number];
    down: [number, number, number, number];
}

export interface ResolvedVolume {
    visible: boolean;
    colors: ResolvedVolumeColors;
    heightRatio: number;
}
export interface ResolvedPriceScale {
    mode: 'linear' | 'log';
    inverted: boolean;
    autoScale: boolean;
}
export interface ResolvedPanes {
    weights: number[];
    separatorHeight: number;
    separatorColor: string;
}
export interface ResolvedCrosshair { visible: boolean; color: string }
export interface ResolvedTimeScale { barSpacing: number; minBarSpacing: number; maxBarSpacing: number }
export interface ResolvedCandlestick {
    upColor: string;
    downColor: string;
    wickVisible: boolean;
    borderVisible: boolean;
    borderUpColor: string;
    borderDownColor: string;
    style: CandleStyle;
    /** Null means "use the first visible candle's close". */
    baselinePrice: number | null;
    /** RGBA for the line and area styles, parsed from CSS when options are applied. */
    lineColor: Rgba;
    areaFillColor: Rgba;
}

/** Every option resolved to a concrete value. Returned by `chart.options()`. */
export interface ResolvedChartOptions {
    maxRetainedCandles: number;
    theme: ChartTheme;
    locale: string;
    timeZone: string;
    priceFormat: ResolvedPriceFormat;
    layout: ResolvedLayout;
    volume: ResolvedVolume;
    priceScale: ResolvedPriceScale;
    panes: ResolvedPanes;
    grid: ResolvedGrid;
    crosshair: ResolvedCrosshair;
    timeScale: ResolvedTimeScale;
    candlestick: ResolvedCandlestick;
}

/** Normalised RGBA, each channel 0-1. */
export type Rgba = [number, number, number, number];

export const DEFAULT_MAX_RETAINED_CANDLES = 1_000_000;
export const DEFAULT_MIN_BAR_SPACING = 0.5;
export const DEFAULT_MAX_BAR_SPACING = 400;

/** Non-theme-dependent defaults. Theme presets override the color fields. */
const BASE_DEFAULTS: Omit<ResolvedChartOptions, 'theme' | 'locale' | 'candlestick' | 'layout' | 'volume' | 'grid' | 'crosshair'> = {
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
    },
};

/** Colors and chrome seeded per theme. Explicit overrides are re-applied on top. */
const THEME_PRESETS: Record<ChartTheme, {
    layout: Omit<ResolvedLayout, 'priceAxisWidth' | 'timeAxisHeight'>;
    /** Volume colours are theme colours, but visibility and height are not. */
    volume: { colors: { up: string; down: string } };
    grid: ResolvedGrid;
    crosshair: ResolvedCrosshair;
    /** Style choice and baseline are not theme colours, so they are omitted. */
    candlestick: Omit<
        ResolvedCandlestick,
        'style' | 'baselinePrice' | 'lineColor' | 'areaFillColor'
    >;
}> = {
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

function fail(message: string): never {
    throw new Error(`MatrixCharts: ${message}`);
}

function requireBoolean(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') fail(`${label} must be a boolean, received ${describe(value)}.`);
    return value;
}

function requireIntegerInRange(value: unknown, label: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        fail(`${label} must be an integer between ${min} and ${max}, received ${describe(value)}.`);
    }
    return value;
}

function requirePositiveFinite(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        fail(`${label} must be a positive finite number, received ${describe(value)}.`);
    }
    return value;
}

const CANDLE_STYLES: readonly CandleStyle[] = [
    'candlestick', 'hollow', 'ohlc', 'baseline', 'line', 'area',
];

function requireCandleStyle(value: unknown): CandleStyle {
    if (typeof value !== 'string' || !CANDLE_STYLES.includes(value as CandleStyle)) {
        fail(
            `candlestick.style must be one of ${CANDLE_STYLES.join(', ')}, received ${describe(value)}.`,
        );
    }
    return value as CandleStyle;
}

/** The same colour with a replaced alpha, for fills derived from a stroke colour. */
function withAlpha(rgba: Rgba, alpha: number): Rgba {
    return [rgba[0], rgba[1], rgba[2], alpha];
}

/** A finite number within an inclusive range. */
function requireNumberInRange(value: unknown, label: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        fail(`${label} must be a number between ${min} and ${max}, received ${describe(value)}.`);
    }
    return value;
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(`${label} must be an object, received ${describe(value)}.`);
    }
    return value as Record<string, unknown>;
}

function describe(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
    if (value === undefined) return 'undefined';
    return Object.prototype.toString.call(value);
}

const HEX_PATTERN = /^#([0-9a-f]{3,8})$/;
const RGB_PATTERN = /^rgba?\(([^()]*)\)$/;

function clampChannel(value: number): number {
    return Math.min(255, Math.max(0, value));
}

function parseChannel(text: string, label: string, color: string): number {
    const trimmed = text.trim();
    if (trimmed.endsWith('%')) {
        const percent = Number(trimmed.slice(0, -1));
        if (!Number.isFinite(percent)) fail(`${label} is not a valid colour: ${JSON.stringify(color)}.`);
        return clampChannel((percent / 100) * 255);
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) fail(`${label} is not a valid colour: ${JSON.stringify(color)}.`);
    return clampChannel(numeric);
}

function parseAlpha(text: string, label: string, color: string): number {
    const trimmed = text.trim();
    const numeric = trimmed.endsWith('%')
        ? Number(trimmed.slice(0, -1)) / 100
        : Number(trimmed);
    if (!Number.isFinite(numeric)) fail(`${label} is not a valid colour: ${JSON.stringify(color)}.`);
    return Math.min(1, Math.max(0, numeric));
}

/**
 * Parses a CSS colour into normalised RGBA. Accepts `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`, `rgba()` with numeric or percentage channels, and
 * `transparent`. Channels are clamped the way CSS clamps them. Anything else
 * throws, so a typo fails at the apply call rather than rendering black.
 */
export function parseCssColor(value: unknown, label: string): Rgba {
    if (typeof value !== 'string') fail(`${label} must be a CSS color string, received ${describe(value)}.`);
    const text = value.trim().toLowerCase();
    if (text === 'transparent') return [0, 0, 0, 0];

    const hex = HEX_PATTERN.exec(text);
    if (hex) {
        const digits = hex[1];
        const expand = (part: string): number => parseInt(part.length === 1 ? part + part : part, 16);
        if (digits.length === 3 || digits.length === 4) {
            return [
                expand(digits[0]) / 255,
                expand(digits[1]) / 255,
                expand(digits[2]) / 255,
                digits.length === 4 ? expand(digits[3]) / 255 : 1,
            ];
        }
        if (digits.length === 6 || digits.length === 8) {
            const pair = (index: number): number => parseInt(digits.slice(index * 2, index * 2 + 2), 16) / 255;
            return [pair(0), pair(1), pair(2), digits.length === 8 ? pair(3) : 1];
        }
        fail(`${label} is not a valid hex colour: ${JSON.stringify(value)}.`);
    }

    const functional = RGB_PATTERN.exec(text);
    if (functional) {
        const parts = functional[1].split(/[,/\s]+/).filter((part: string): boolean => part.length > 0);
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
function requireColor(value: unknown, label: string): string {
    parseCssColor(value, label);
    return value as string;
}

function requireLocale(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        fail(`locale must be a non-empty BCP 47 tag, received ${describe(value)}.`);
    }
    try {
        return new Intl.NumberFormat(value).resolvedOptions().locale;
    } catch {
        return fail(`locale is not a valid BCP 47 tag: ${JSON.stringify(value)}.`);
    }
}

/**
 * A CSS-pixel measurement for a reserved gutter. Must be a finite, non-negative
 * number: a negative width would invert the plot rect, and `Infinity` or `NaN`
 * would collapse it, both of which reach the geometry rather than failing here.
 */
function requireNonNegativeNumber(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(`${label} must be a finite, non-negative number of CSS pixels, received ${describe(value)}.`);
    }
    return value;
}

function requireTimeZone(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        fail(`timeZone must be a non-empty IANA zone name, received ${describe(value)}.`);
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
    } catch {
        return fail(`timeZone is not a valid IANA zone name: ${JSON.stringify(value)}.`);
    }
    return value;
}

function requireTheme(value: unknown): ChartTheme {
    if (value !== 'dark' && value !== 'paper') {
        fail(`theme must be either dark or paper, received ${describe(value)}.`);
    }
    return value;
}

export function runtimeLocale(): string {
    return new Intl.NumberFormat().resolvedOptions().locale;
}

/**
 * Default gutter sizes, in CSS pixels. Not theme-dependent: they are layout
 * metrics rather than colours, so a theme change must not resize the plot.
 */
const DEFAULT_LAYOUT_METRICS = {
    priceAxisWidth: 78,
    timeAxisHeight: 22,
} as const;

/**
 * Volume defaults that are not theme colours. The histogram is off by default,
 * so a series with no volume is unaffected, and occupies the bottom fifth of the
 * plot when switched on.
 */
const DEFAULT_VOLUME_METRICS = {
    visible: false,
    heightRatio: 0.2,
} as const;

/**
 * Default candlestick rendering and colours for the non-candlestick styles.
 * Not theme colours for `style` and `baselinePrice`, which are choices rather
 * than appearance; the line and area colours follow each theme's up colour so a
 * line chart reads as belonging to the same chart as its candles.
 */
const DEFAULT_CANDLE_STYLE: CandleStyle = 'candlestick';

/** Preset-only snapshot for a theme, with no caller overrides applied. */
export function themeDefaults(theme: ChartTheme): ResolvedChartOptions {
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
        panes: { ...BASE_DEFAULTS.panes, separatorColor: preset.grid.color },
        crosshair: { ...preset.crosshair },
        timeScale: { ...BASE_DEFAULTS.timeScale },
        candlestick: {
            ...preset.candlestick,
            style: DEFAULT_CANDLE_STYLE,
            baselinePrice: null,
            lineColor: parseCssColor(preset.candlestick.upColor, 'candlestick.upColor'),
            areaFillColor: withAlpha(
                parseCssColor(preset.candlestick.upColor, 'candlestick.upColor'),
                0.25,
            ),
        },
    };
}

/**
 * Resolves caller options over the theme preset. Called fresh on every
 * `applyOptions`, so a `theme` change re-seeds from the new preset and then
 * re-applies whatever the caller set explicitly under the old theme.
 */
export function resolveOptions(partial: ChartOptions, fallbackTheme: ChartTheme = 'dark'): ResolvedChartOptions {
    const theme = partial.theme === undefined ? fallbackTheme : requireTheme(partial.theme);
    const resolved = themeDefaults(theme);

    if (partial.maxRetainedCandles !== undefined) {
        resolved.maxRetainedCandles = requireIntegerInRange(
            partial.maxRetainedCandles,
            'maxRetainedCandles',
            1,
            Number.MAX_SAFE_INTEGER,
        );
    }
    if (partial.locale !== undefined) resolved.locale = requireLocale(partial.locale);
    if (partial.timeZone !== undefined) resolved.timeZone = requireTimeZone(partial.timeZone);

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
                separatorHeight: panes.separatorHeight as number,
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
            resolved.volume.heightRatio = requireNumberInRange(
                volume.heightRatio,
                'volume.heightRatio',
                0,
                1,
            );
            if (resolved.volume.heightRatio <= 0) {
                fail('volume.heightRatio must be greater than 0; a histogram with no height draws nothing.');
            }
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
            resolved.volume.colors.up = parseCssColor(
                requireColor(volume.upColor, 'volume.upColor'),
                'volume.upColor',
            );
        }
        if (volume.downColor !== undefined) {
            resolved.volume.colors.down = parseCssColor(
                requireColor(volume.downColor, 'volume.downColor'),
                'volume.downColor',
            );
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
            fail(
                `priceFormat.minMove (${resolved.priceFormat.minMove}) is finer than `
                + `priceFormat.precision (${resolved.priceFormat.precision}) can show.`,
            );
        }
    }

    if (partial.layout !== undefined) {
        const layout = requirePlainObject(partial.layout, 'layout');
        if (layout.background !== undefined) resolved.layout.background = requireColor(layout.background, 'layout.background');
        if (layout.textColor !== undefined) resolved.layout.textColor = requireColor(layout.textColor, 'layout.textColor');
        if (layout.priceAxisWidth !== undefined) {
            resolved.layout.priceAxisWidth = requireNonNegativeNumber(
                layout.priceAxisWidth,
                'layout.priceAxisWidth',
            );
        }
        if (layout.timeAxisHeight !== undefined) {
            resolved.layout.timeAxisHeight = requireNonNegativeNumber(
                layout.timeAxisHeight,
                'layout.timeAxisHeight',
            );
        }
    }

    if (partial.grid !== undefined) {
        const grid = requirePlainObject(partial.grid, 'grid');
        if (grid.vertLines !== undefined) resolved.grid.vertLines = requireBoolean(grid.vertLines, 'grid.vertLines');
        if (grid.horzLines !== undefined) resolved.grid.horzLines = requireBoolean(grid.horzLines, 'grid.horzLines');
        if (grid.color !== undefined) resolved.grid.color = requireColor(grid.color, 'grid.color');
    }

    if (partial.crosshair !== undefined) {
        const crosshair = requirePlainObject(partial.crosshair, 'crosshair');
        if (crosshair.visible !== undefined) resolved.crosshair.visible = requireBoolean(crosshair.visible, 'crosshair.visible');
        if (crosshair.color !== undefined) resolved.crosshair.color = requireColor(crosshair.color, 'crosshair.color');
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
            fail(
                `timeScale.minBarSpacing (${resolved.timeScale.minBarSpacing}) must not exceed `
                + `timeScale.maxBarSpacing (${resolved.timeScale.maxBarSpacing}).`,
            );
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
        if (candlestick.upColor !== undefined) resolved.candlestick.upColor = requireColor(candlestick.upColor, 'candlestick.upColor');
        if (candlestick.downColor !== undefined) resolved.candlestick.downColor = requireColor(candlestick.downColor, 'candlestick.downColor');
        if (candlestick.borderUpColor !== undefined) resolved.candlestick.borderUpColor = requireColor(candlestick.borderUpColor, 'candlestick.borderUpColor');
        if (candlestick.borderDownColor !== undefined) resolved.candlestick.borderDownColor = requireColor(candlestick.borderDownColor, 'candlestick.borderDownColor');
        if (candlestick.wickVisible !== undefined) resolved.candlestick.wickVisible = requireBoolean(candlestick.wickVisible, 'candlestick.wickVisible');
        if (candlestick.borderVisible !== undefined) resolved.candlestick.borderVisible = requireBoolean(candlestick.borderVisible, 'candlestick.borderVisible');
        if (candlestick.style !== undefined) {
            resolved.candlestick.style = requireCandleStyle(candlestick.style);
        }
        if (candlestick.baselinePrice !== undefined) {
            resolved.candlestick.baselinePrice = requireNonNegativeNumber(
                candlestick.baselinePrice,
                'candlestick.baselinePrice',
            );
        }
        if (candlestick.lineColor !== undefined) {
            resolved.candlestick.lineColor = parseCssColor(
                requireColor(candlestick.lineColor, 'candlestick.lineColor'),
                'candlestick.lineColor',
            );
        }
        if (candlestick.areaFillColor !== undefined) {
            resolved.candlestick.areaFillColor = parseCssColor(
                requireColor(candlestick.areaFillColor, 'candlestick.areaFillColor'),
                'candlestick.areaFillColor',
            );
        }
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
export function mergeOptionPartials(
    base: ChartOptions,
    patch: ChartOptions,
    source: 'constructor' | 'applyOptions' = 'applyOptions',
): ChartOptions {
    if (source === 'applyOptions' && patch.maxRetainedCandles !== undefined) {
        fail('maxRetainedCandles is constructor-only in v1 and cannot be changed with applyOptions().');
    }

    const merged: ChartOptions = { ...base };
    const nestedKeys = ['priceFormat', 'layout', 'volume', 'priceScale', 'panes', 'grid', 'crosshair', 'timeScale', 'candlestick'] as const;
    for (const key of nestedKeys) {
        const patchValue = patch[key];
        if (patchValue === undefined) continue;
        merged[key] = { ...(base[key] ?? {}), ...patchValue } as never;
    }
    for (const key of ['theme', 'locale', 'timeZone'] as const) {
        if (patch[key] !== undefined) merged[key] = patch[key] as never;
    }
    if (patch.maxRetainedCandles !== undefined) {
        merged.maxRetainedCandles = patch.maxRetainedCandles;
    }
    return merged;
}

/** Colours converted once per apply, not per candle. */
export interface ResolvedCandleColors {
    up: Rgba;
    down: Rgba;
    borderUp: Rgba;
    borderDown: Rgba;
}

export function resolveCandleColors(options: ResolvedChartOptions): ResolvedCandleColors {
    return {
        up: parseCssColor(options.candlestick.upColor, 'candlestick.upColor'),
        down: parseCssColor(options.candlestick.downColor, 'candlestick.downColor'),
        borderUp: parseCssColor(options.candlestick.borderUpColor, 'candlestick.borderUpColor'),
        borderDown: parseCssColor(options.candlestick.borderDownColor, 'candlestick.borderDownColor'),
    };
}
