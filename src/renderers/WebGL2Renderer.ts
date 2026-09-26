// src/renderers/WebGL2Renderer.ts
import type { CandleStyle, ResolvedCandleColors, ResolvedVolumeColors } from '../core/options.js';
import type { IRenderer } from '../core/IRenderer.js';
import type { EventEmitter, ChartEvents } from '../core/EventEmitter.js';
import type { PlotRect } from '../core/coordinates.js';
import { candlestickBodyEdgesData } from '../math/candlestickBodyWidth.js';
import {
    WebGLSeries,
    VERTEX_STRIDE,
    type SeriesPass,
    type SeriesUniforms,
    type VerticalTransform,
} from './WebGLSeries.js';
import {
    CANDLE_CLOSE,
    CANDLE_HIGH,
    CANDLE_LOW,
    CANDLE_OPEN,
    CANDLE_STRIDE,
    CANDLE_VOLUME,
    CANDLE_WIDTH,
    CANDLE_X,
} from '../math/candleLayout.js';

/** Normalised RGBA, matching the shape the option resolver produces. */
type Rgba = [number, number, number, number];

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

/** A fully transparent body, used by the hollow style. */
const TRANSPARENT: Rgba = [0, 0, 0, 0];

export class WebGL2Renderer implements IRenderer {
    private gl: WebGL2RenderingContext | null = null;
    private emitter!: EventEmitter<ChartEvents>;
    private canvas: HTMLCanvasElement | null = null;

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
    private program: WebGLProgram | null = null;
    private vertexShader: WebGLShader | null = null;
    private fragmentShader: WebGLShader | null = null;

    private positionLocation: number = -1;
    private colorLocation: number = -1;
    private resolutionLocation: WebGLUniformLocation | null = null;
    private offsetLocation: WebGLUniformLocation | null = null;
    private scaleLocation: WebGLUniformLocation | null = null;
    private pixelRatioLocation: WebGLUniformLocation | null = null;
    private snapOffsetLocation: WebGLUniformLocation | null = null;

    /**
     * Series in draw order, back to front. Each owns its buffers, so uploading one
     * cannot disturb another.
     */
    private series: WebGLSeries[] = [];
    private candleSeries: WebGLSeries | null = null;
    private lineSeries: WebGLSeries | null = null;
    private volumeSeries: WebGLSeries | null = null;
    private areaSeries: WebGLSeries | null = null;
    /** One batch per named overlay, created on first draw and kept until removed. */
    private overlaySeries: Map<string, WebGLSeries> = new Map<string, WebGLSeries>();

    private currentOffset: [number, number] = [0, 0];
    private currentScale: [number, number] = [1, 1];
    /**
     * Region data is confined to, in CSS pixels. Starts degenerate so a draw
     * before the first viewport event covers nothing rather than everything.
     */
    private currentPlot: PlotRect = { x: 0, y: 0, width: 0, height: 0 };
    private devicePixelRatio: number = 1;

    public init(canvas: HTMLCanvasElement, emitter: EventEmitter<ChartEvents>): void {
        this.destroy();
        this.emitter = emitter;
        this.emitter.on('viewport', this.handleViewportEvent);
        const gl: WebGL2RenderingContext | null = canvas.getContext('webgl2');
        if (!gl) {
            // Stable, documented, and safe to string-match. v1 has no Canvas2D
            // fallback, so there is nothing to degrade to.
            throw new Error('MatrixCharts: WebGL2 is required.');
        }

        // u_offset is referenced even though the transform is affine, so the
        // compiler cannot optimise the uniform out and leave the location null.
        const vertexShaderSource: string = `#version 300 es
            in vec2 a_position;
            in vec4 a_color;
            uniform vec2 u_resolution;
            uniform vec2 u_offset;
            uniform vec2 u_scale;
            uniform float u_pixelRatio;
            uniform float u_snapOffset;
            out vec4 v_color;
            void main() {
                vec2 transformedPosition = ((a_position * u_scale) + u_offset) * u_pixelRatio;
                transformedPosition = floor(transformedPosition + vec2(0.5 - u_snapOffset)) + vec2(u_snapOffset);
                vec2 zeroToOne = transformedPosition / u_resolution;
                vec2 clipSpace = (zeroToOne * 2.0) - 1.0;
                gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);
                v_color = a_color;
            }
        `;
        const fragmentShaderSource: string = `#version 300 es
            precision highp float;
            in vec4 v_color;
            out vec4 outColor;
            void main() {
                // Premultiplied output. The layer beneath this canvas is opaque
                // (the grid draws the background), and the browser composites this
                // canvas over it, so the alpha here is applied once by the GL blend
                // and once more by the compositor. Emitting premultiplied colour and
                // blending with ONE keeps that to a single application: blending
                // with SRC_ALPHA would square the alpha channel instead, making a
                // 25% fill land at 6% and a 50% one at 25%.
                outColor = vec4(v_color.rgb * v_color.a, v_color.a);
            }
        `;

        this.gl = gl;
        this.canvas = canvas;

        try {
            this.vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexShaderSource);
            this.fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
            this.program = this.linkProgram(this.vertexShader, this.fragmentShader);
            const program = this.program;

            this.positionLocation = gl.getAttribLocation(program, 'a_position');
            this.colorLocation = gl.getAttribLocation(program, 'a_color');
            this.resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
            this.offsetLocation = gl.getUniformLocation(program, 'u_offset');
            this.scaleLocation = gl.getUniformLocation(program, 'u_scale');
            this.pixelRatioLocation = gl.getUniformLocation(program, 'u_pixelRatio');
            this.snapOffsetLocation = gl.getUniformLocation(program, 'u_snapOffset');
            if (
                this.positionLocation < 0 ||
                this.colorLocation < 0 ||
                !this.resolutionLocation ||
                !this.offsetLocation ||
                !this.scaleLocation ||
                !this.pixelRatioLocation ||
                !this.snapOffsetLocation
            ) {
                throw new Error('MatrixCharts: Required WebGL shader inputs were not found.');
            }

            this.candleSeries = new WebGLSeries(
                gl, program, this.positionLocation, this.colorLocation, 'candlestick',
            );
            this.lineSeries = new WebGLSeries(
                gl, program, this.positionLocation, this.colorLocation, 'line',
            );
            this.volumeSeries = new WebGLSeries(
                gl, program, this.positionLocation, this.colorLocation, 'volume',
            );
            this.areaSeries = new WebGLSeries(
                gl, program, this.positionLocation, this.colorLocation, 'area',
            );
            // Back to front: the volume histogram and any area fill sit behind the
            // price series, which is what the overlay line then sits on top of.
            this.series = [
                this.volumeSeries, this.areaSeries, this.candleSeries, this.lineSeries,
            ];

            gl.bindVertexArray(null);
            gl.enable(gl.BLEND);
            // Premultiplied-alpha blending, matching the fragment shader. The
            // context is created with premultipliedAlpha: true, which is the
            // default, so what the shader writes is what the compositor reads.
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        } catch (error: unknown) {
            this.destroy();
            throw error;
        }
    }

    public clear(): void {
        const gl: WebGL2RenderingContext = this.requireContext();
        // The scissor box is confined to the plot for drawing only. Clearing
        // under it would leave the gutters holding whatever was last drawn there,
        // so the whole backing store is cleared with clipping off.
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    public resize(width: number, height: number, dpr: number): void {
        if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(dpr)) return;
        if (width < 0 || height < 0 || dpr <= 0) return;

        if (this.canvas) {
            this.devicePixelRatio = dpr;
            this.canvas.width = Math.round(width * dpr);
            this.canvas.height = Math.round(height * dpr);
            this.canvas.style.width = `${width}px`;
            this.canvas.style.height = `${height}px`;
            if (this.gl) {
                this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            }
        }
    }

    private handleViewportEvent = (payload: ChartEvents['viewport']): void => {
        this.currentOffset = [payload.offsetX, payload.offsetY];
        this.currentScale = [payload.scaleX, payload.scaleY];
        this.currentPlot = payload.plot;
    };

    /**
     * Uploads a polyline as a line series. `points` is interleaved `[x, y]` in
     * data coordinates; the vertex format carries colour per vertex, so the
     * colour is expanded to match. Positions go through the same device-pixel
     * transform as every other series, which is what makes a line land where the
     * candles are at any pixel ratio.
     */
    public drawLine(points: Float32Array, color: [number, number, number, number]): void {
        const series = this.lineSeries;
        if (!series) return;
        if (points.length % 2 !== 0) {
            throw new Error('MatrixCharts: Line points must contain interleaved x/y pairs.');
        }
        const pointCount = points.length / 2;
        if (pointCount < 2) {
            series.setPasses([]);
            return;
        }

        const vertices = new Float32Array(pointCount * VERTEX_STRIDE);
        for (let index = 0; index < pointCount; index++) {
            const source = index * 2;
            const target = index * VERTEX_STRIDE;
            vertices[target] = points[source];
            vertices[target + 1] = points[source + 1];
            vertices[target + 2] = color[0];
            vertices[target + 3] = color[1];
            vertices[target + 4] = color[2];
            vertices[target + 5] = color[3];
        }

        series.upload(vertices, null);
        // Pixel centres, so a one-pixel line does not straddle two pixel columns.
        series.setPasses([{
            primitive: this.requireContext().LINE_STRIP,
            count: pointCount,
            first: 0,
            indexed: false,
            snapOffset: 0.5,
        }]);
    }

    /**
     * Uploads one named overlay as its own line series, so overlays cannot
     * overwrite each other's geometry and each keeps an independent pass.
     *
     * The batch is created on first use and kept: overlays are re-uploaded every
     * frame, but their buffers are not, and recreating a vertex array per frame
     * per overlay is exactly the cost this design set out to avoid.
     */
    public drawOverlay(
        id: string,
        points: Float32Array,
        stride: 2 | 6,
        color: Rgba,
        vertical: VerticalTransform | null,
    ): void {
        const gl: WebGL2RenderingContext = this.requireContext();
        let series: WebGLSeries | undefined = this.overlaySeries.get(id);
        if (!series) {
            if (!this.program) return;
            series = new WebGLSeries(
                gl, this.program, this.positionLocation, this.colorLocation, `overlay:${id}`,
            );
            this.overlaySeries.set(id, series);
            // Appended so overlays draw over the candles but under nothing else.
            this.series.splice(this.series.length - 1, 0, series);
        }
        series.setVerticalTransform(vertical);

        const pointCount = Math.floor(points.length / stride);
        if (pointCount < 2) {
            series.setPasses([]);
            return;
        }
        const vertices = new Float32Array(pointCount * VERTEX_STRIDE);
        for (let index = 0; index < pointCount; index++) {
            const source = index * stride;
            const target = index * VERTEX_STRIDE;
            vertices[target] = points[source];
            vertices[target + 1] = points[source + 1];
            // A stride of 6 carries this point's own colour; otherwise the whole
            // overlay is the one colour the caller supplied.
            const hasOwn = stride === 6;
            vertices[target + 2] = hasOwn ? points[source + 2] : color[0];
            vertices[target + 3] = hasOwn ? points[source + 3] : color[1];
            vertices[target + 4] = hasOwn ? points[source + 4] : color[2];
            vertices[target + 5] = hasOwn ? points[source + 5] : color[3];
        }
        series.upload(vertices, null);
        series.setPasses([{
            primitive: gl.LINE_STRIP,
            count: pointCount,
            first: 0,
            indexed: false,
            snapOffset: 0.5,
        }]);
    }

    /**
     * Drops overlays that are no longer supplied, so removing one releases its
     * buffers instead of leaving an invisible series alive for the chart's life.
     */
    public retainOverlays(activeIds: ReadonlySet<string>): void {
        for (const [id, series] of Array.from(this.overlaySeries.entries())) {
            if (activeIds.has(id)) continue;
            const index = this.series.indexOf(series);
            if (index >= 0) this.series.splice(index, 1);
            series.destroy();
            this.overlaySeries.delete(id);
        }
    }

    /**
     * Uploads an area: the close polyline with the region beneath it filled down
     * to `basePrice`. Built as an indexed triangle strip over the same points the
     * line uses, so the fill edge and the stroke edge cannot disagree.
     *
     * `points` is interleaved `[x, y]` in data coordinates.
     */
    public drawArea(
        points: Float32Array,
        fill: Rgba,
        basePrice: number,
    ): void {
        const gl: WebGL2RenderingContext = this.requireContext();
        const series = this.areaSeries;
        if (!series) return;
        if (points.length % 2 !== 0) {
            throw new Error('MatrixCharts: Area points must contain interleaved x/y pairs.');
        }
        const pointCount: number = points.length / 2;
        if (pointCount < 2) {
            series.setPasses([]);
            return;
        }

        // Two vertices per point: the point itself and its twin on the baseline.
        const vertices = new Float32Array(pointCount * 2 * VERTEX_STRIDE);
        for (let index = 0; index < pointCount; index++) {
            const source = index * 2;
            const top = index * 2 * VERTEX_STRIDE;
            const bottom = top + VERTEX_STRIDE;
            vertices[top] = points[source];
            vertices[top + 1] = points[source + 1];
            vertices[top + 2] = fill[0]; vertices[top + 3] = fill[1];
            vertices[top + 4] = fill[2]; vertices[top + 5] = fill[3];
            vertices[bottom] = points[source];
            vertices[bottom + 1] = basePrice;
            vertices[bottom + 2] = fill[0]; vertices[bottom + 3] = fill[1];
            vertices[bottom + 4] = fill[2]; vertices[bottom + 5] = fill[3];
        }

        // One quad per segment between the points, as two triangles.
        const indices = new Uint32Array((pointCount - 1) * 6);
        let cursor = 0;
        for (let index = 0; index < pointCount - 1; index++) {
            const topLeft = index * 2;
            const bottomLeft = topLeft + 1;
            const topRight = topLeft + 2;
            const bottomRight = topLeft + 3;
            indices[cursor++] = topLeft; indices[cursor++] = bottomLeft; indices[cursor++] = topRight;
            indices[cursor++] = topRight; indices[cursor++] = bottomLeft; indices[cursor++] = bottomRight;
        }

        series.upload(vertices, indices);
        series.setPasses([{
            primitive: gl.TRIANGLES,
            count: cursor,
            first: 0,
            indexed: true,
            snapOffset: 0.0,
        }]);
    }

    /** Clears the area fill so a frame without one does not keep drawing it. */
    public clearArea(): void {
        this.areaSeries?.setPasses([]);
    }

    /**
     * OHLC bars: no body, just a vertical low-to-high line with a tick to the
     * left at the open and a tick to the right at the close. Three line segments
     * per candle, so six vertices drawn as `gl.LINES` with no index buffer.
     *
     * The ticks are capped at half the bar gap on each side, because a bar gap can
     * be a single pixel and a tick wider than the bar would make the series
     * unreadable rather than merely tight.
     */
    private drawOhlcBars(candles: Float32Array, colors: ResolvedCandleColors): void {
        const gl: WebGL2RenderingContext = this.requireContext();
        const series = this.candleSeries;
        if (!series) return;
        const candleCount: number = candles.length / CANDLE_STRIDE;
        if (candleCount === 0) {
            series.setPasses([]);
            return;
        }

        const scaleX: number = Math.abs(this.currentScale[0]);
        if (scaleX === 0) {
            throw new Error('MatrixCharts: OHLC bar viewport scale must be non-zero.');
        }

        const vertices = new Float32Array(candleCount * 6 * VERTEX_STRIDE);
        let cursor = 0;
        for (let candleIndex = 0; candleIndex < candleCount; candleIndex++) {
            const inputIndex: number = candleIndex * CANDLE_STRIDE;
            const x: number = candles[inputIndex + CANDLE_X];
            const open: number = candles[inputIndex + CANDLE_OPEN];
            const high: number = candles[inputIndex + CANDLE_HIGH];
            const low: number = candles[inputIndex + CANDLE_LOW];
            const close: number = candles[inputIndex + CANDLE_CLOSE];
            const width: number = candles[inputIndex + CANDLE_WIDTH];
            if (![x, open, high, low, close, width].every(Number.isFinite) || width <= 0) {
                throw new Error('MatrixCharts: OHLC bar values must be finite and width must be positive.');
            }

            let neighborSpacing: number = Number.POSITIVE_INFINITY;
            if (candleIndex > 0) {
                const previous = Math.abs(x - candles[inputIndex - CANDLE_STRIDE]);
                if (previous > 0) neighborSpacing = Math.min(neighborSpacing, previous);
            }
            if (candleIndex + 1 < candleCount) {
                const next = Math.abs(candles[inputIndex + CANDLE_STRIDE] - x);
                if (next > 0) neighborSpacing = Math.min(neighborSpacing, next);
            }
            if (!Number.isFinite(neighborSpacing)) neighborSpacing = width;

            // Half the gap, in data x, so the two ticks of neighbouring bars meet
            // at the midpoint rather than overlapping.
            const tick: number = Math.min(neighborSpacing, width) / 2;
            const color: Rgba = close >= open ? colors.up : colors.down;

            const segments: Array<[number, number, number, number]> = [
                [x, low, x, high],
                [x, open, x - tick, open],
                [x, close, x + tick, close],
            ];
            for (const [x0, y0, x1, y1] of segments) {
                vertices[cursor++] = x0; vertices[cursor++] = y0;
                vertices[cursor++] = color[0]; vertices[cursor++] = color[1];
                vertices[cursor++] = color[2]; vertices[cursor++] = color[3];
                vertices[cursor++] = x1; vertices[cursor++] = y1;
                vertices[cursor++] = color[0]; vertices[cursor++] = color[1];
                vertices[cursor++] = color[2]; vertices[cursor++] = color[3];
            }
        }

        series.upload(vertices, null);
        // Pixel centres, so a one-pixel tick does not straddle two pixel columns.
        series.setPasses([{
            primitive: gl.LINES,
            count: candleCount * 6,
            first: 0,
            indexed: false,
            snapOffset: 0.5,
        }]);
    }

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
    public drawHistogram(
        levels: Float32Array,
        colors: ResolvedVolumeColors,
        scaleY: number,
        offsetY: number,
    ): void {
        const gl: WebGL2RenderingContext = this.requireContext();
        const series = this.volumeSeries;
        if (!series) return;
        if (levels.length % CANDLE_STRIDE !== 0) {
            throw new Error('MatrixCharts: Histogram input must contain candle records.');
        }
        const count: number = levels.length / CANDLE_STRIDE;
        if (count === 0) {
            series.setPasses([]);
            return;
        }

        const barScaleX: number = Math.abs(this.currentScale[0]);
        if (barScaleX === 0 || scaleY === 0) {
            throw new Error('MatrixCharts: Histogram viewport scales must be non-zero.');
        }

        // Four vertices and six indices per bar, one triangle-pair. Bars are drawn
        // back to front in index order, which is also the time order.
        const vertices = new Float32Array(count * 4 * VERTEX_STRIDE);
        const indices = new Uint32Array(count * 6);
        let vertexFloat = 0;
        let indexOffset = 0;

        for (let barIndex: number = 0; barIndex < count; barIndex++) {
            const inputIndex: number = barIndex * CANDLE_STRIDE;
            const x: number = levels[inputIndex + CANDLE_X];
            const open: number = levels[inputIndex + CANDLE_OPEN];
            const close: number = levels[inputIndex + CANDLE_CLOSE];
            const volume: number = levels[inputIndex + CANDLE_VOLUME];
            const weight: number = levels[inputIndex + CANDLE_WIDTH];

            if (![x, open, close, volume, weight].every(Number.isFinite) || weight <= 0) {
                throw new Error('MatrixCharts: Histogram values must be finite and width must be positive.');
            }

            let neighborSpacing: number = Number.POSITIVE_INFINITY;
            if (barIndex > 0) {
                const previous = Math.abs(x - levels[inputIndex - CANDLE_STRIDE]);
                if (previous > 0) neighborSpacing = Math.min(neighborSpacing, previous);
            }
            if (barIndex + 1 < count) {
                const next = Math.abs(levels[inputIndex + CANDLE_STRIDE] - x);
                if (next > 0) neighborSpacing = Math.min(neighborSpacing, next);
            }
            if (!Number.isFinite(neighborSpacing)) neighborSpacing = weight;

            // The same bar-edge helper the candlesticks use, so a volume bar lines
            // up with the candle above it on the same pixel columns.
            const { left, right } = candlestickBodyEdgesData(
                x,
                neighborSpacing,
                barScaleX,
                this.currentOffset[0],
                this.devicePixelRatio,
            );
            // Bars grow from the baseline up, so a zero volume is a zero-height
            // bar rather than a bar hanging from the top.
            const baseline: number = 0;
            const top: number = volume > 0 ? volume : baseline;
            const color: [number, number, number, number] = close >= open ? colors.up : colors.down;

            const base: number = barIndex * 4;
            // Bottom-left, bottom-right, top-left, top-right.
            const corners: Array<[number, number]> = [
                [left, baseline], [right, baseline], [left, top], [right, top],
            ];
            for (const [cornerX, cornerY] of corners) {
                vertices[vertexFloat++] = cornerX;
                vertices[vertexFloat++] = cornerY;
                vertices[vertexFloat++] = color[0];
                vertices[vertexFloat++] = color[1];
                vertices[vertexFloat++] = color[2];
                vertices[vertexFloat++] = color[3];
            }
            indices[indexOffset++] = base;
            indices[indexOffset++] = base + 1;
            indices[indexOffset++] = base + 2;
            indices[indexOffset++] = base + 2;
            indices[indexOffset++] = base + 1;
            indices[indexOffset++] = base + 3;
        }

        series.setVerticalTransform({ scaleY, offsetY });
        series.upload(vertices, indices);
        // Pixel boundaries, so a bar's edge lands on exactly one pixel column.
        series.setPasses([{
            primitive: gl.TRIANGLES, count: indexOffset, first: 0, indexed: true, snapOffset: 0.0,
        }]);
    }

    /**
     * Clears the candle series so a frame that draws line or area geometry does
     * not leave the previous style's candle bodies behind it.
     */
    public clearCandlesticks(): void {
        this.candleSeries?.setPasses([]);
    }

    /** Clears the line polyline. */
    public clearLine(): void {
        this.lineSeries?.setPasses([]);
    }

    /**
     * Clears the histogram so a frame where volume is switched off or the data
     * carries none does not keep drawing the previous frame's bars.
     */
    public clearHistogram(): void {
        this.volumeSeries?.setPasses([]);
    }

    /**
     * Uploads [x, open, high, low, close, width, volume] candles to the GPU.
     *
     * `colors` arrives already parsed from CSS, so this per-frame path never
     * touches colour strings. `wickVisible` skips generating and drawing the
     * wick segments entirely. `borderVisible` adds a 1 device-pixel frame
     * inside the body outline, drawn ahead of the fill in the same indexed
     * pass, so no extra shader or draw call is needed.
     */
    public drawCandlesticks(candles: Float32Array, spec: CandleRenderSpec): void {
        const gl: WebGL2RenderingContext = this.requireContext();
        const series = this.candleSeries;
        if (!series) return;

        if (spec.style === 'ohlc') {
            this.drawOhlcBars(candles, spec.colors);
            return;
        }

        // A hollow candle is outlined in its own body colour and left unfilled, so
        // the frame is the entire visual and is drawn whether or not borders were
        // asked for. The fill becomes transparent and the frame takes over the
        // border colours, which is the whole difference between the two styles.
        const hollow: boolean = spec.style === 'hollow';
        const colors: ResolvedCandleColors = hollow
            ? { ...spec.colors, borderUp: spec.colors.up, borderDown: spec.colors.down }
            : spec.colors;
        const wickVisible: boolean = spec.wickVisible;
        const borderVisible: boolean = hollow ? true : spec.borderVisible;

        if (candles.length % CANDLE_STRIDE !== 0) {
            throw new Error('MatrixCharts: Candles must contain x/open/high/low/close/width values.');
        }

        const candleCount: number = candles.length / CANDLE_STRIDE;
        if (candleCount === 0) {
            // Nothing to draw. Skipping the upload avoids handing WebGL zero-length
            // buffers on the empty first frame, which buys nothing.
            series.setPasses([]);
            return;
        }
        const scaleX: number = Math.abs(this.currentScale[0]);
        const scaleY: number = Math.abs(this.currentScale[1]);
        if (scaleX === 0 || scaleY === 0) {
            throw new Error('MatrixCharts: Candlestick viewport scales must be non-zero.');
        }

        // Three contiguous blocks per frame: wicks, then optional border frames,
        // then body fills. Each block starts at a fixed offset so the three can
        // never overlap, whatever the flags say. The baseline rule, when drawn,
        // adds two vertices to the tail of the wick block.
        const wickVerticesPerCandle: number = wickVisible ? 4 : 0;
        // A border is a frame of four quads, so 16 vertices and 24 indices.
        const borderVerticesPerCandle: number = borderVisible ? 16 : 0;
        const baselineVertices: number =
            spec.style === 'baseline' && spec.baselinePrice !== null ? 2 : 0;
        const bodyVertexStart: number = candleCount * (wickVerticesPerCandle + borderVerticesPerCandle);
        const verticesPerCandle: number = wickVerticesPerCandle + borderVerticesPerCandle + 4;
        const totalVertices: number = candleCount * verticesPerCandle + baselineVertices;
        const vertices: Float32Array = new Float32Array(totalVertices * VERTEX_STRIDE);
        const indicesPerCandle: number = (borderVisible ? 24 : 0) + 6;
        const bodyIndices: Uint32Array = new Uint32Array(candleCount * indicesPerCandle);

        // Two cursors per block, and they count different things: a float offset
        // into the interleaved vertex array, and a vertex id for the index buffer.
        // Conflating them puts every index six times past the end of the buffer.
        let wickFloat: number = 0;
        let borderFloat: number = candleCount * wickVerticesPerCandle * VERTEX_STRIDE;
        let bodyFloat: number = bodyVertexStart * VERTEX_STRIDE;
        let borderVertexId: number = candleCount * wickVerticesPerCandle;
        let bodyVertexId: number = bodyVertexStart;
        let bodyIndexOffset: number = 0;

        for (let candleIndex: number = 0; candleIndex < candleCount; candleIndex++) {
            const inputIndex: number = candleIndex * CANDLE_STRIDE;
            const x: number = candles[inputIndex + CANDLE_X];
            const open: number = candles[inputIndex + CANDLE_OPEN];
            const high: number = candles[inputIndex + CANDLE_HIGH];
            const low: number = candles[inputIndex + CANDLE_LOW];
            const close: number = candles[inputIndex + CANDLE_CLOSE];
            const width: number = candles[inputIndex + CANDLE_WIDTH];

            if (![x, open, high, low, close, width].every(Number.isFinite) || width <= 0) {
                throw new Error('MatrixCharts: Candlestick values must be finite and width must be positive.');
            }

            const bullish: boolean = close >= open;
            // The body fill and the wick are separate colours. A hollow candle has a
            // transparent fill but a fully drawn wick, so making the fill transparent
            // must not make the wick disappear with it.
            const fillColor: Rgba = hollow
                ? TRANSPARENT
                : (bullish ? colors.up : colors.down);
            const wickColor: Rgba = bullish ? colors.up : colors.down;
            const borderColor: Rgba = bullish ? colors.borderUp : colors.borderDown;
            let neighborSpacing: number = Number.POSITIVE_INFINITY;
            if (candleIndex > 0) {
                const previousSpacing: number = Math.abs(x - candles[inputIndex - CANDLE_STRIDE]);
                if (previousSpacing > 0) neighborSpacing = Math.min(neighborSpacing, previousSpacing);
            }
            if (candleIndex + 1 < candleCount) {
                const nextSpacing: number = Math.abs(candles[inputIndex + CANDLE_STRIDE] - x);
                if (nextSpacing > 0) neighborSpacing = Math.min(neighborSpacing, nextSpacing);
            }
            if (!Number.isFinite(neighborSpacing)) neighborSpacing = width;

            const { left: bodyLeft, right: bodyRight } = candlestickBodyEdgesData(
                x,
                neighborSpacing,
                scaleX,
                this.currentOffset[0],
                this.devicePixelRatio,
            );

            let bodyTop: number = Math.max(open, close);
            let bodyBottom: number = Math.min(open, close);
            const bodyHeightPixels: number = (bodyTop - bodyBottom) * scaleY * this.devicePixelRatio;
            if (bodyHeightPixels < 1) {
                const halfPixelHeight: number = 0.5 / (scaleY * this.devicePixelRatio);
                const bodyCenter: number = (bodyTop + bodyBottom) / 2;
                bodyTop = bodyCenter + halfPixelHeight;
                bodyBottom = bodyCenter - halfPixelHeight;
            }

            const physicalTop: number = Math.floor(
                (bodyTop * this.currentScale[1] + this.currentOffset[1]) * this.devicePixelRatio + 0.5,
            );
            const physicalBottom: number = Math.floor(
                (bodyBottom * this.currentScale[1] + this.currentOffset[1]) * this.devicePixelRatio + 0.5,
            );
            const upperPixelCenter: number = physicalTop + 1.5;
            const lowerPixelCenter: number = physicalBottom - 1.5;
            const upperWickBoundary: number = (
                upperPixelCenter / this.devicePixelRatio - this.currentOffset[1]
            ) / this.currentScale[1];
            const lowerWickBoundary: number = (
                lowerPixelCenter / this.devicePixelRatio - this.currentOffset[1]
            ) / this.currentScale[1];
            const upperWickEnd: number = Math.max(bodyBottom, Math.min(high, upperWickBoundary));
            const lowerWickStart: number = Math.min(bodyTop, Math.max(low, lowerWickBoundary));

            // Upper wick ends above the body; lower wick starts below it to avoid overdraw seams.
            if (wickVisible) {
                vertices[wickFloat++] = x; vertices[wickFloat++] = high;
                vertices[wickFloat++] = wickColor[0]; vertices[wickFloat++] = wickColor[1];
                vertices[wickFloat++] = wickColor[2]; vertices[wickFloat++] = wickColor[3];

                vertices[wickFloat++] = x; vertices[wickFloat++] = upperWickEnd;
                vertices[wickFloat++] = wickColor[0]; vertices[wickFloat++] = wickColor[1];
                vertices[wickFloat++] = wickColor[2]; vertices[wickFloat++] = wickColor[3];

                vertices[wickFloat++] = x; vertices[wickFloat++] = lowerWickStart;
                vertices[wickFloat++] = wickColor[0]; vertices[wickFloat++] = wickColor[1];
                vertices[wickFloat++] = wickColor[2]; vertices[wickFloat++] = wickColor[3];

                vertices[wickFloat++] = x; vertices[wickFloat++] = low;
                vertices[wickFloat++] = wickColor[0]; vertices[wickFloat++] = wickColor[1];
                vertices[wickFloat++] = wickColor[2]; vertices[wickFloat++] = wickColor[3];
            }

            // The border is a one-device-pixel frame on the body outline, and the
            // fill is drawn inset to match. The frame is four strips rather than one
            // quad under the fill, because a translucent fill would otherwise
            // composite onto the border colour instead of the background and the
            // whole body would take on the border's hue.
            let fillLeft: number = bodyLeft;
            let fillRight: number = bodyRight;
            let fillTop: number = bodyTop;
            let fillBottom: number = bodyBottom;

            if (borderVisible) {
                // Every body edge is resolved to a whole device pixel and then
                // emitted as the data value whose device position is exactly that
                // pixel. The shader's snap is floor(device + 0.5), which is
                // knife-edge whenever the device position lands near a .5 boundary:
                // a body edge on a whole CSS pixel puts `position * pixelRatio` on
                // a half-integer at every odd-tenth pixel ratio, and two edges that
                // must be one pixel apart then round independently, giving a
                // two-pixel or zero-pixel frame. Targeting the exact pixel keeps
                // each edge half a pixel clear of the boundary, so the snap is
                // stable at any pixel ratio. candlestickBodyEdgesData already
                // resolves the horizontal edges this way; the vertical ones are
                // recovered here.
                //
                // The snap is evaluated in float32 on purpose. The uniforms reach
                // the GPU as float32, so a row computed in double precision can
                // disagree with the row the shader picks whenever the edge is
                // within float32 error of a boundary, and the frame would then hug
                // a row the body was never drawn on. A pixel ratio such as 2.3 is
                // not representable in float32, so this is not hypothetical.
                const ratio: number = Math.fround(this.devicePixelRatio);
                const snapScaleX: number = Math.fround(this.currentScale[0]);
                const snapScaleY: number = Math.fround(this.currentScale[1]);
                const snapOffsetX: number = Math.fround(this.currentOffset[0]);
                const snapOffsetY: number = Math.fround(this.currentOffset[1]);
                /** Device column of a data x, matching the shader's body snap. */
                const columnOf = (dataX: number): number => Math.floor(
                    Math.fround(
                        Math.fround(Math.fround(dataX * snapScaleX) + snapOffsetX) * ratio,
                    ) + 0.5,
                );
                /** Device row of a price, matching the shader's body snap. */
                const rowOf = (price: number): number => Math.floor(
                    Math.fround(
                        Math.fround(Math.fround(price * snapScaleY) + snapOffsetY) * ratio,
                    ) + 0.5,
                );
                /** Data x whose device column is exactly `column`. */
                const dataForColumn = (column: number): number => (
                    (column / ratio - snapOffsetX) / snapScaleX
                );
                /** Price whose device row is exactly `row`. */
                const dataForRow = (row: number): number => (
                    (row / ratio - snapOffsetY) / snapScaleY
                );

                const leftColumn: number = columnOf(bodyLeft);
                const rightColumn: number = columnOf(bodyRight);
                const topRow: number = rowOf(bodyTop);
                const bottomRow: number = rowOf(bodyBottom);

                // A one-pixel frame needs an interior left over, so a body thinner
                // than three device pixels on either axis carries no frame at all.
                const hasRoom: boolean = rightColumn - leftColumn > 3 && bottomRow - topRow > 3;

                fillTop = dataForRow(topRow);
                fillBottom = dataForRow(bottomRow);

                if (hasRoom) {
                    const innerLeftColumn: number = leftColumn + 1;
                    const innerRightColumn: number = rightColumn - 1;
                    const innerTopRow: number = topRow + 1;
                    const innerBottomRow: number = bottomRow - 1;
                    const innerLeft: number = dataForColumn(innerLeftColumn);
                    const innerRight: number = dataForColumn(innerRightColumn);
                    const innerTop: number = dataForRow(innerTopRow);
                    const innerBottom: number = dataForRow(innerBottomRow);
                    const frameLeft: number = dataForColumn(leftColumn);
                    const frameRight: number = dataForColumn(rightColumn);

                    /** One axis-aligned quad: 4 vertices and 6 indices. */
                    const writeStrip = (
                        left: number, right: number, bottom: number, top: number,
                    ): void => {
                        vertices[borderFloat++] = left; vertices[borderFloat++] = bottom;
                        vertices[borderFloat++] = borderColor[0]; vertices[borderFloat++] = borderColor[1];
                        vertices[borderFloat++] = borderColor[2]; vertices[borderFloat++] = borderColor[3];

                        vertices[borderFloat++] = right; vertices[borderFloat++] = bottom;
                        vertices[borderFloat++] = borderColor[0]; vertices[borderFloat++] = borderColor[1];
                        vertices[borderFloat++] = borderColor[2]; vertices[borderFloat++] = borderColor[3];

                        vertices[borderFloat++] = left; vertices[borderFloat++] = top;
                        vertices[borderFloat++] = borderColor[0]; vertices[borderFloat++] = borderColor[1];
                        vertices[borderFloat++] = borderColor[2]; vertices[borderFloat++] = borderColor[3];

                        vertices[borderFloat++] = right; vertices[borderFloat++] = top;
                        vertices[borderFloat++] = borderColor[0]; vertices[borderFloat++] = borderColor[1];
                        vertices[borderFloat++] = borderColor[2]; vertices[borderFloat++] = borderColor[3];

                        bodyIndices[bodyIndexOffset++] = borderVertexId;
                        bodyIndices[bodyIndexOffset++] = borderVertexId + 1;
                        bodyIndices[bodyIndexOffset++] = borderVertexId + 2;
                        bodyIndices[bodyIndexOffset++] = borderVertexId + 2;
                        bodyIndices[bodyIndexOffset++] = borderVertexId + 1;
                        bodyIndices[bodyIndexOffset++] = borderVertexId + 3;
                        borderVertexId += 4;
                    };

                    // Top and bottom run the full width; the sides fill the gap
                    // between them, so no pixel is ever covered twice.
                    writeStrip(frameLeft, frameRight, innerTop, dataForRow(topRow));
                    writeStrip(frameLeft, frameRight, dataForRow(bottomRow), innerBottom);
                    writeStrip(frameLeft, innerLeft, innerBottom, innerTop);
                    writeStrip(innerRight, frameRight, innerBottom, innerTop);

                    fillLeft = innerLeft;
                    fillRight = innerRight;
                    fillTop = innerTop;
                    fillBottom = innerBottom;
                }
            }

            vertices[bodyFloat++] = fillLeft; vertices[bodyFloat++] = fillBottom;
            vertices[bodyFloat++] = fillColor[0]; vertices[bodyFloat++] = fillColor[1];
            vertices[bodyFloat++] = fillColor[2]; vertices[bodyFloat++] = fillColor[3];

            vertices[bodyFloat++] = fillRight; vertices[bodyFloat++] = fillBottom;
            vertices[bodyFloat++] = fillColor[0]; vertices[bodyFloat++] = fillColor[1];
            vertices[bodyFloat++] = fillColor[2]; vertices[bodyFloat++] = fillColor[3];

            vertices[bodyFloat++] = fillLeft; vertices[bodyFloat++] = fillTop;
            vertices[bodyFloat++] = fillColor[0]; vertices[bodyFloat++] = fillColor[1];
            vertices[bodyFloat++] = fillColor[2]; vertices[bodyFloat++] = fillColor[3];

            vertices[bodyFloat++] = fillRight; vertices[bodyFloat++] = fillTop;
            vertices[bodyFloat++] = fillColor[0]; vertices[bodyFloat++] = fillColor[1];
            vertices[bodyFloat++] = fillColor[2]; vertices[bodyFloat++] = fillColor[3];

            bodyIndices[bodyIndexOffset++] = bodyVertexId;
            bodyIndices[bodyIndexOffset++] = bodyVertexId + 1;
            bodyIndices[bodyIndexOffset++] = bodyVertexId + 2;
            bodyIndices[bodyIndexOffset++] = bodyVertexId + 2;
            bodyIndices[bodyIndexOffset++] = bodyVertexId + 1;
            bodyIndices[bodyIndexOffset++] = bodyVertexId + 3;
            bodyVertexId += 4;
        }

        // The baseline style adds one horizontal rule spanning the visible
        // candles: two vertices appended to the wick block, drawn as their own
        // strip so they need not interleave with the per-candle segments.
        const baselinePrice: number | null = spec.style === 'baseline' ? spec.baselinePrice : null;
        const hasBaseline: boolean = baselinePrice !== null && candleCount >= 2;
        if (hasBaseline) {
            const firstX: number = candles[CANDLE_X];
            const lastX: number = candles[(candleCount - 1) * CANDLE_STRIDE + CANDLE_X];
            let cursor: number = candleCount * wickVerticesPerCandle * VERTEX_STRIDE;
            for (const x of [firstX, lastX]) {
                vertices[cursor++] = x;
                vertices[cursor++] = baselinePrice as number;
                vertices[cursor++] = colors.up[0];
                vertices[cursor++] = colors.up[1];
                vertices[cursor++] = colors.up[2];
                vertices[cursor++] = colors.up[3];
            }
        }

        series.upload(vertices, bodyIndices);

        // Wicks are lines drawn non-indexed from the head of the vertex buffer;
        // borders and fills are one indexed triangle pass, with the border quads
        // already ahead of the fills in the index buffer.
        const passes: SeriesPass[] = [];
        if (wickVisible && wickVerticesPerCandle > 0) {
            passes.push({
                primitive: gl.LINES,
                count: candleCount * wickVerticesPerCandle,
                first: 0,
                indexed: false,
                snapOffset: 0.5,
            });
        }
        if (hasBaseline) {
            passes.push({
                primitive: gl.LINE_STRIP,
                count: 2,
                first: candleCount * wickVerticesPerCandle,
                indexed: false,
                snapOffset: 0.5,
            });
        }
        if (bodyIndexOffset > 0) {
            passes.push({
                primitive: gl.TRIANGLES,
                count: bodyIndexOffset,
                first: 0,
                indexed: true,
                snapOffset: 0.0,
            });
        }
        series.setPasses(passes);
    }

    public render(): void {
        const gl: WebGL2RenderingContext = this.requireContext();
        if (!this.canvas || !this.program) return;
        if (this.series.every((entry: WebGLSeries): boolean => entry.isEmpty)) return;

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);

        // Confine data to the plot rect. Without this a bar scrolled part-way past
        // an edge keeps painting over the axis gutter it is supposed to be clipped
        // by. GL's origin is bottom-left, so the box is mirrored in y, and the
        // extents are rounded so a fractional ratio cannot leave a seam.
        const plot: PlotRect = this.currentPlot;
        const clipWidth: number = Math.round(plot.width * this.devicePixelRatio);
        const clipHeight: number = Math.round(plot.height * this.devicePixelRatio);
        if (clipWidth <= 0 || clipHeight <= 0) {
            // A collapsed plot has no area to confine to; draw nothing rather than
            // letting data cover the whole canvas.
            gl.disable(gl.SCISSOR_TEST);
            return;
        }
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(
            Math.round(plot.x * this.devicePixelRatio),
            Math.round(this.canvas.height - (plot.y + plot.height) * this.devicePixelRatio),
            clipWidth,
            clipHeight,
        );

        const uniforms: SeriesUniforms = {
            // Device pixels throughout: the shader multiplies by the pixel ratio,
            // so the resolution it divides by has to be the backing store's.
            resolutionX: this.canvas.width,
            resolutionY: this.canvas.height,
            offsetX: this.currentOffset[0],
            offsetY: this.currentOffset[1],
            scaleX: this.currentScale[0],
            scaleY: this.currentScale[1],
            pixelRatio: this.devicePixelRatio,
        };
        for (const entry of this.series) {
            entry.draw(
                uniforms,
                this.resolutionLocation!,
                this.offsetLocation!,
                this.scaleLocation!,
                this.pixelRatioLocation!,
                this.snapOffsetLocation!,
            );
        }

        gl.bindVertexArray(null);
        // Clipping is a per-draw decision, not a mode the renderer leaves on, so
        // the next clear starts from an unconfined buffer.
        gl.disable(gl.SCISSOR_TEST);
    }

    public destroy(): void {
        if (this.emitter) {
            this.emitter.off('viewport', this.handleViewportEvent);
        }
        for (const entry of this.overlaySeries.values()) entry.destroy();
        this.overlaySeries.clear();
        for (const entry of this.series) entry.destroy();
        this.series = [];
        this.candleSeries = null;
        this.lineSeries = null;
        this.volumeSeries = null;
        this.areaSeries = null;
        if (this.gl) {
            if (this.vertexShader) this.gl.deleteShader(this.vertexShader);
            if (this.fragmentShader) this.gl.deleteShader(this.fragmentShader);
            if (this.program) this.gl.deleteProgram(this.program);
        }
        this.vertexShader = null;
        this.fragmentShader = null;
        this.program = null;
        this.positionLocation = -1;
        this.colorLocation = -1;
        this.resolutionLocation = null;
        this.offsetLocation = null;
        this.scaleLocation = null;
        this.pixelRatioLocation = null;
        this.snapOffsetLocation = null;
        this.gl = null;
        this.canvas = null;
    }

    private requireContext(): WebGL2RenderingContext {
        if (!this.gl) throw new Error('MatrixCharts: WebGL2 is required.');
        return this.gl;
    }

    private compileShader(type: number, source: string): WebGLShader {
        const gl: WebGL2RenderingContext = this.requireContext();
        const shader: WebGLShader | null = gl.createShader(type);
        if (!shader) throw new Error('MatrixCharts: Failed to create a WebGL shader.');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log: string = gl.getShaderInfoLog(shader) ?? 'unknown error';
            gl.deleteShader(shader);
            throw new Error(`MatrixCharts: WebGL shader compilation failed: ${log}`);
        }
        return shader;
    }

    private linkProgram(vertex: WebGLShader, fragment: WebGLShader): WebGLProgram {
        const gl: WebGL2RenderingContext = this.requireContext();
        const program: WebGLProgram | null = gl.createProgram();
        if (!program) throw new Error('MatrixCharts: Failed to create a WebGL program.');
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const log: string = gl.getProgramInfoLog(program) ?? 'unknown error';
            gl.deleteProgram(program);
            throw new Error(`MatrixCharts: WebGL program linking failed: ${log}`);
        }
        return program;
    }
}
