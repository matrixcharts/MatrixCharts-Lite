import type { CandleStyle, ResolvedCandleColors, ResolvedVolumeColors } from '../core/options.js';
import type { OverlayType } from '../core/overlays.js';
import type { IDataRenderer } from '../core/IDataRenderer.js';
import type { EventEmitter, ChartEvents } from '../core/EventEmitter.js';
import { type VerticalTransform } from './WebGLSeries.js';
/** Normalised RGBA, matching the shape the option resolver produces. */
export type Rgba = [number, number, number, number];
/**
 * Everything the OHLC renderer needs beyond the candle buffer. Passed as one
 * object rather than a widening parameter list, because the style decides which
 * of the fields are read at all.
 */
export interface CandleRenderSpec {
    colors: ResolvedCandleColors;
    style: CandleStyle;
    wickVisible: boolean;
    borderVisible: boolean;
    /** Reference price for the `baseline` style; ignored by every other style. */
    baselinePrice: number | null;
}
export declare class WebGL2Renderer implements IDataRenderer {
    private gl;
    private emitter;
    private canvas;
    /**
     * One program for every series on the layer. The vertex layout is
     * `[x, y, r, g, b, a]` in data coordinates with per-vertex colour, and the
     * transform is device pixels in, device pixels out.
     *
     * There was a second program for lines that worked in CSS pixels while the
     * viewport was the device buffer, so it placed geometry in the top-left
     * quarter of the canvas at any pixel ratio above one. Unifying on the
     * device-pixel transform is what makes a second series correct rather than
     * merely present.
     */
    private program;
    private vertexShader;
    private fragmentShader;
    private positionLocation;
    private colorLocation;
    private resolutionLocation;
    private offsetLocation;
    private scaleLocation;
    private pixelRatioLocation;
    private snapOffsetLocation;
    /**
     * Series in draw order, back to front. Each owns its buffers, so uploading one
     * cannot disturb another.
     */
    private series;
    private candleSeries;
    private lineSeries;
    private volumeSeries;
    private areaSeries;
    /** One batch per named overlay, created on first draw and kept until removed. */
    private overlaySeries;
    private currentOffset;
    private currentScale;
    /**
     * Region data is confined to, in CSS pixels. Starts degenerate so a draw
     * before the first viewport event covers nothing rather than everything.
     */
    private currentPlot;
    /** Pane rects in CSS pixels, index-aligned with the series' pane indices. */
    private currentPanes;
    private devicePixelRatio;
    init(canvas: HTMLCanvasElement, emitter: EventEmitter<ChartEvents>): void;
    clear(): void;
    resize(width: number, height: number, dpr: number): void;
    private handleViewportEvent;
    /**
     * Uploads a polyline as a line series. `points` is interleaved `[x, y]` in
     * data coordinates; the vertex format carries colour per vertex, so the
     * colour is expanded to match. Positions go through the same device-pixel
     * transform as every other series, which is what makes a line land where the
     * candles are at any pixel ratio.
     */
    drawLine(points: Float32Array, color: [number, number, number, number]): void;
    /**
     * Uploads one named overlay as its own line series, so overlays cannot
     * overwrite each other's geometry and each keeps an independent pass.
     *
     * The batch is created on first use and kept: overlays are re-uploaded every
     * frame, but their buffers are not, and recreating a vertex array per frame
     * per overlay is exactly the cost this design set out to avoid.
     */
    drawOverlay(id: string, points: Float32Array, stride: 2 | 6, color: Rgba, vertical: VerticalTransform | null, pane?: number, type?: OverlayType, baseline?: number, points2?: Float32Array | null, fillColor?: Rgba | null): void;
    /**
     * Drops overlays that are no longer supplied, so removing one releases its
     * buffers instead of leaving an invisible series alive for the chart's life.
     */
    retainOverlays(activeIds: ReadonlySet<string>): void;
    /**
     * Uploads an area: the close polyline with the region beneath it filled down
     * to `basePrice`. Built as an indexed triangle strip over the same points the
     * line uses, so the fill edge and the stroke edge cannot disagree.
     *
     * `points` is interleaved `[x, y]` in data coordinates.
     */
    drawArea(points: Float32Array, fill: Rgba, basePrice: number): void;
    /** Clears the area fill so a frame without one does not keep drawing it. */
    clearArea(): void;
    /**
     * OHLC bars: no body, just a vertical low-to-high line with a tick to the
     * left at the open and a tick to the right at the close. Three line segments
     * per candle, so six vertices drawn as `gl.LINES` with no index buffer.
     *
     * The ticks are capped at half the bar gap on each side, because a bar gap can
     * be a single pixel and a tick wider than the bar would make the series
     * unreadable rather than merely tight.
     */
    private drawOhlcBars;
    /**
     * Uploads a volume histogram as its own series.
     *
     * `levels` is the same interleaved candle record the candlestick series reads,
     * so both series slice the same pyramid level and cannot drift apart in time.
     * Each bar grows from the bottom of a region of the plot to the height implied
     * by its own volume, scaled against the largest volume on screen rather than
     * against the price range, so volume never distorts the price axis.
     *
     * The bar's vertical transform is set per series, which is why this cannot
     * simply share the viewport's price scale.
     */
    drawHistogram(levels: Float32Array, colors: ResolvedVolumeColors, scaleY: number, offsetY: number, pane?: number): void;
    /**
     * Clears the candle series so a frame that draws line or area geometry does
     * not leave the previous style's candle bodies behind it.
     */
    clearCandlesticks(): void;
    /** Clears the line polyline. */
    clearLine(): void;
    /**
     * Clears the histogram so a frame where volume is switched off or the data
     * carries none does not keep drawing the previous frame's bars.
     */
    clearHistogram(): void;
    /**
     * Uploads [x, open, high, low, close, width, volume] candles to the GPU.
     *
     * `colors` arrives already parsed from CSS, so this per-frame path never
     * touches colour strings. `wickVisible` skips generating and drawing the
     * wick segments entirely. `borderVisible` adds a 1 device-pixel frame
     * inside the body outline, drawn ahead of the fill in the same indexed
     * pass, so no extra shader or draw call is needed.
     */
    drawCandlesticks(candles: Float32Array, spec: CandleRenderSpec): void;
    render(): void;
    destroy(): void;
    private requireContext;
    private compileShader;
    private linkProgram;
}
//# sourceMappingURL=WebGL2Renderer.d.ts.map