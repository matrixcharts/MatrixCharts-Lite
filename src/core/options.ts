// src/core/options.ts
//
// Option resolution for v1. Pure and DOM-free so it can be unit tested without
// a browser: parsing, validation, deep merge, and theme preset seeding all live
// here. Chart keeps the accumulated explicit partials and re-resolves from this
// module on every applyOptions, which is what makes a theme change reset to the
// preset and then re-apply the caller's overrides.

import { DEFAULT_CANDLE_SPACING_PX } from '../math/candlestickBodyWidth.js';

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

export interface CandlestickOptions {
    upColor?: string;
    downColor?: string;
    wickVisible?: boolean;
    /** Draws a 1 device-pixel frame inside the body outline. Needs no extra pass. */
    borderVisible?: boolean;
    borderUpColor?: string;
    borderDownColor?: string;
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
export interface ResolvedCrosshair { visible: boolean; color: string }
export interface ResolvedTimeScale { barSpacing: number; minBarSpacing: number; maxBarSpacing: number }
export interface ResolvedCandlestick {
    upColor: string;
    downColor: string;
    wickVisible: boolean;
    borderVisible: boolean;
    borderUpColor: string;
    borderDownColor: string;
}

/** Every option resolved to a concrete value. Returned by `chart.options()`. */
export interface ResolvedChartOptions {
    maxRetainedCandles: number;
    theme: ChartTheme;
    locale: string;
    timeZone: string;
    priceFormat: ResolvedPriceFormat;
    layout: ResolvedLayout;
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
const BASE_DEFAULTS: Omit<ResolvedChartOptions, 'theme' | 'locale' | 'candlestick' | 'layout' | 'grid' | 'crosshair'> = {
    maxRetainedCandles: DEFAULT_MAX_RETAINED_CANDLES,
    timeZone: 'UTC',
    priceFormat: { precision: 2, minMove: 0.01 },
    timeScale: {
        barSpacing: DEFAULT_CANDLE_SPACING_PX,
        minBarSpacing: DEFAULT_MIN_BAR_SPACING,
        maxBarSpacing: DEFAULT_MAX_BAR_SPACING,
    },
};

/** Colors and chrome seeded per theme. Explicit overrides are re-applied on top. */
const THEME_PRESETS: Record<ChartTheme, {
    layout: Omit<ResolvedLayout, 'priceAxisWidth' | 'timeAxisHeight'>;
    grid: ResolvedGrid;
    crosshair: ResolvedCrosshair;
    candlestick: ResolvedCandlestick;
}> = {
    dark: {
        layout: { background: '#0b0f17', textColor: '#c6d0df' },
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

/** Preset-only snapshot for a theme, with no caller overrides applied. */
export function themeDefaults(theme: ChartTheme): ResolvedChartOptions {
    const preset = THEME_PRESETS[theme];
    return {
        ...BASE_DEFAULTS,
        theme,
        locale: runtimeLocale(),
        priceFormat: { ...BASE_DEFAULTS.priceFormat },
        layout: { ...preset.layout, ...DEFAULT_LAYOUT_METRICS },
        grid: { ...preset.grid },
        crosshair: { ...preset.crosshair },
        timeScale: { ...BASE_DEFAULTS.timeScale },
        candlestick: { ...preset.candlestick },
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
    const nestedKeys = ['priceFormat', 'layout', 'grid', 'crosshair', 'timeScale', 'candlestick'] as const;
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
