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
    /**
     * Which pane to draw the volume on. 0 is the price pane (default).
     * If set to an index >= 1, volume occupies that dedicated sub-pane.
     */
    pane?: number;
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
    readout?: boolean;
    readoutBorderColor?: string;
    readoutBackgroundColor?: string;
    readoutTextColor?: string;
    /** Background colour of the axis labels for the crosshair. */
    axisLabelBackgroundColor?: string;
    /** Text colour of the axis labels for the crosshair. */
    axisLabelTextColor?: string;
}
/**
 * How closed sessions are drawn.
 *
 * On by default. A traditional equity feed has overnight and weekend gaps that are
 * not missing data, and drawing the series as though time ran continuously through
 * them is simply wrong: a 17-hour break in a chart of 1-minute bars is about a
 * thousand bars wide, and honest about it produces a chart that is thirty screens of
 * white. A break is therefore shown as a break — the series is not drawn across it —
 * but sized in slots rather than in hours.
 *
 * Additive in 1.x: no sessionBreaks block, or enabled false, is the transform that
 * shipped before this existed.
 */
export interface SessionGapOptions {
    /** Whether closed sessions are shown as breaks. Defaults to true. */
    enabled?: boolean;
    /** Fixed gap threshold in milliseconds. Supplying it enables incremental collapsed-gap updates. */
    thresholdMs?: number;
    /**
     * `collapsed` gives every break the same half-bar width, and is the default.
     * `proportional` gives each break width in proportion to its duration, up to
     * the cap. Proportional is the more honest picture and the less usable one, which
     * is why it is not the default.
     */
    mode?: 'collapsed' | 'proportional';
    /**
     * Cap on the *total* whitespace, as a fraction of the series' bar count.
     *
     * A total rather than a per-break limit, because the failure mode is cumulative:
     * thirty individually reasonable breaks are still a chart of nothing. Expressed in
     * slots rather than pixels so it survives a resize instead of quietly changing
     * meaning when the window does.
     */
    maxWhitespaceRatio?: number;
}
export interface TimeScaleOptions {
    /** CSS px per candle index. */
    barSpacing?: number;
    /** Lower clamp applied to wheel and pinch zoom. */
    minBarSpacing?: number;
    /** Upper clamp applied to wheel and pinch zoom. */
    maxBarSpacing?: number;
    /** How closed sessions are drawn. */
    sessionBreaks?: SessionGapOptions;
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
'candlestick'
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
    /** Whether to show a tag on the price axis for the last known price. */
    lastPriceTag?: boolean;
    /** Background colour for the last price tag. */
    lastPriceTagBackgroundColor?: string;
    /** Text colour for the last price tag. */
    lastPriceTagTextColor?: string;
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
export interface ResolvedPriceFormat {
    precision: number;
    minMove: number;
}
export interface ResolvedLayout {
    background: string;
    textColor: string;
    priceAxisWidth: number;
    timeAxisHeight: number;
}
export interface ResolvedGrid {
    vertLines: boolean;
    horzLines: boolean;
    color: string;
}
/** The histogram's RGBA channels, resolved from CSS when options are applied. */
export interface ResolvedVolumeColors {
    up: [number, number, number, number];
    down: [number, number, number, number];
}
export interface ResolvedVolume {
    visible: boolean;
    colors: ResolvedVolumeColors;
    heightRatio: number;
    pane: number;
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
export interface ResolvedCrosshair {
    visible: boolean;
    color: string;
    readout: boolean;
    readoutBorderColor: Rgba;
    readoutBackground: Rgba;
    /** Zero alpha means "choose it against `readoutBackground`". */
    readoutText: Rgba;
    axisLabelBackground: Rgba;
    axisLabelText: Rgba;
}
export interface ResolvedSessionBreaks {
    enabled: boolean;
    thresholdMs: number | null;
    mode: 'collapsed' | 'proportional';
    maxWhitespaceRatio: number;
}
export interface ResolvedTimeScale {
    barSpacing: number;
    minBarSpacing: number;
    maxBarSpacing: number;
    sessionBreaks: ResolvedSessionBreaks;
}
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
    lastPriceTag: boolean;
    lastPriceTagBackground: Rgba;
    lastPriceTagText: Rgba;
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
export declare const DEFAULT_MAX_RETAINED_CANDLES = 1000000;
export declare const DEFAULT_MIN_BAR_SPACING = 0.5;
export declare const DEFAULT_MAX_BAR_SPACING = 400;
/**
 * Parses a CSS colour into normalised RGBA. Accepts `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`, `rgba()` with numeric or percentage channels, and
 * `transparent`. Channels are clamped the way CSS clamps them. Anything else
 * throws, so a typo fails at the apply call rather than rendering black.
 */
export declare function parseCssColor(value: unknown, label: string): Rgba;
/** Calculates luminance for auto-contrast. */
export declare function luminanceOf(rgba: readonly [number, number, number, number]): number;
/** Chooses a high-contrast text colour. */
export declare function contrastText(bgRgba: readonly [number, number, number, number]): readonly [number, number, number, number];
export declare function priceLabelFormatter(locale: string, precision: number): Intl.NumberFormat;
export declare function runtimeLocale(): string;
/** Preset-only snapshot for a theme, with no caller overrides applied. */
export declare function themeDefaults(theme: ChartTheme): ResolvedChartOptions;
/**
 * Resolves caller options over the theme preset. Called fresh on every
 * `applyOptions`, so a `theme` change re-seeds from the new preset and then
 * re-applies whatever the caller set explicitly under the old theme.
 */
export declare function resolveOptions(partial: ChartOptions, fallbackTheme?: ChartTheme): ResolvedChartOptions;
/**
 * Accumulates caller partials. Kept separate from the resolved snapshot so a
 * theme switch can re-seed from the new preset and still honour these.
 *
 * `maxRetainedCandles` is constructor-only in v1: changing it under a live
 * viewport means rebuilding the retained pyramid, so `applyOptions` rejects it
 * rather than silently ignoring it. The constructor is the one place it is legal.
 */
export declare function mergeOptionPartials(base: ChartOptions, patch: ChartOptions, source?: 'constructor' | 'applyOptions'): ChartOptions;
/** Colours converted once per apply, not per candle. */
export interface ResolvedCandleColors {
    up: Rgba;
    down: Rgba;
    borderUp: Rgba;
    borderDown: Rgba;
}
export declare function resolveCandleColors(options: ResolvedChartOptions): ResolvedCandleColors;
