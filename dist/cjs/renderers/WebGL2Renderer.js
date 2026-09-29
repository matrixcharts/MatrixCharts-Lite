"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebGL2Renderer = void 0;
const candlestickBodyWidth_js_1 = require("../math/candlestickBodyWidth.js");
const WebGLSeries_js_1 = require("./WebGLSeries.js");
const candleLayout_js_1 = require("../math/candleLayout.js");
/** A fully transparent body, used by the hollow style. */
const TRANSPARENT = [0, 0, 0, 0];
class WebGL2Renderer {
    constructor() {
        this.gl = null;
        this.canvas = null;
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
        this.program = null;
        this.vertexShader = null;
        this.fragmentShader = null;
        this.positionLocation = -1;
        this.colorLocation = -1;
        this.resolutionLocation = null;
        this.offsetLocation = null;
        this.scaleLocation = null;
        this.pixelRatioLocation = null;
        this.snapOffsetLocation = null;
        /**
         * Series in draw order, back to front. Each owns its buffers, so uploading one
         * cannot disturb another.
         */
        this.series = [];
        this.candleSeries = null;
        this.lineSeries = null;
        this.volumeSeries = null;
        this.areaSeries = null;
        /** One batch per named overlay, created on first draw and kept until removed. */
        this.overlaySeries = new Map();
        this.currentOffset = [0, 0];
        this.currentScale = [1, 1];
        /**
         * Region data is confined to, in CSS pixels. Starts degenerate so a draw
         * before the first viewport event covers nothing rather than everything.
         */
        this.currentPlot = { x: 0, y: 0, width: 0, height: 0 };
        /** Pane rects in CSS pixels, index-aligned with the series' pane indices. */
        this.currentPanes = [];
        this.devicePixelRatio = 1;
        this.handleViewportEvent = (payload) => {
            this.currentOffset = [payload.offsetX, payload.offsetY];
            this.currentScale = [payload.scaleX, payload.scaleY];
            this.currentPlot = payload.plot;
            // An absent table means no panes, and every series then clips to the plot.
            this.currentPanes = payload.panes?.rects ?? [];
        };
    }
    init(canvas, emitter) {
        this.destroy();
        this.emitter = emitter;
        this.emitter.on('viewport', this.handleViewportEvent);
        const gl = canvas.getContext('webgl2');
        if (!gl) {
            // Stable, documented, and safe to string-match. v1 has no Canvas2D
            // fallback, so there is nothing to degrade to.
            throw new Error('MatrixCharts: WebGL2 is required.');
        }
        // u_offset is referenced even though the transform is affine, so the
        // compiler cannot optimise the uniform out and leave the location null.
        const vertexShaderSource = `#version 300 es
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
        const fragmentShaderSource = `#version 300 es
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
            if (this.positionLocation < 0 ||
                this.colorLocation < 0 ||
                !this.resolutionLocation ||
                !this.offsetLocation ||
                !this.scaleLocation ||
                !this.pixelRatioLocation ||
                !this.snapOffsetLocation) {
                throw new Error('MatrixCharts: Required WebGL shader inputs were not found.');
            }
            this.candleSeries = new WebGLSeries_js_1.WebGLSeries(gl, program, this.positionLocation, this.colorLocation, 'candlestick');
            this.lineSeries = new WebGLSeries_js_1.WebGLSeries(gl, program, this.positionLocation, this.colorLocation, 'line');
            this.volumeSeries = new WebGLSeries_js_1.WebGLSeries(gl, program, this.positionLocation, this.colorLocation, 'volume');
            this.areaSeries = new WebGLSeries_js_1.WebGLSeries(gl, program, this.positionLocation, this.colorLocation, 'area');
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
        }
        catch (error) {
            this.destroy();
            throw error;
        }
    }
    clear() {
        const gl = this.requireContext();
        // The scissor box is confined to the plot for drawing only. Clearing
        // under it would leave the gutters holding whatever was last drawn there,
        // so the whole backing store is cleared with clipping off.
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }
    resize(width, height, dpr) {
        if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(dpr))
            return;
        if (width < 0 || height < 0 || dpr <= 0)
            return;
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
    /**
     * Uploads a polyline as a line series. `points` is interleaved `[x, y]` in
     * data coordinates; the vertex format carries colour per vertex, so the
     * colour is expanded to match. Positions go through the same device-pixel
     * transform as every other series, which is what makes a line land where the
     * candles are at any pixel ratio.
     */
    drawLine(points, color) {
        const series = this.lineSeries;
        if (!series)
            return;
        if (points.length % 2 !== 0) {
            throw new Error('MatrixCharts: Line points must contain interleaved x/y pairs.');
        }
        const pointCount = points.length / 2;
        if (pointCount < 2) {
            series.setPasses([]);
            return;
        }
        const vertices = new Float32Array(pointCount * WebGLSeries_js_1.VERTEX_STRIDE);
        for (let index = 0; index < pointCount; index++) {
            const source = index * 2;
            const target = index * WebGLSeries_js_1.VERTEX_STRIDE;
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
    drawOverlay(id, points, stride, color, vertical, pane = 0, type = 'line', baseline = 0, points2 = null, fillColor = null) {
        const gl = this.requireContext();
        let series = this.overlaySeries.get(id);
        if (!series) {
            if (!this.program)
                return;
            series = new WebGLSeries_js_1.WebGLSeries(gl, this.program, this.positionLocation, this.colorLocation, `overlay:${id}`);
            this.overlaySeries.set(id, series);
            // Appended so overlays draw over the candles but under nothing else.
            this.series.splice(this.series.length - 1, 0, series);
        }
        series.setVerticalTransform(vertical);
        // Recorded rather than passed per draw: clipping is a property of where
        // the series lives, and a series that drew outside its own pane would paint
        // over the pane above it.
        series.pane = pane;
        const pointCount = Math.floor(points.length / stride);
        if (pointCount < 1) {
            series.setPasses([]);
            return;
        }
        if (type === 'histogram') {
            const barCount = pointCount;
            const vertices = new Float32Array(barCount * 6 * WebGLSeries_js_1.VERTEX_STRIDE);
            const halfWidth = 0.35;
            let target = 0;
            for (let i = 0; i < barCount; i++) {
                const src = i * stride;
                const x = points[src];
                const y = points[src + 1];
                const hasOwn = stride === 6;
                const r = hasOwn ? points[src + 2] : color[0];
                const g = hasOwn ? points[src + 3] : color[1];
                const b = hasOwn ? points[src + 4] : color[2];
                const a = hasOwn ? points[src + 5] : color[3];
                const x0 = x - halfWidth;
                const x1 = x + halfWidth;
                const y0 = baseline;
                const y1 = y;
                // Triangle 1: (x0, y0), (x1, y0), (x0, y1)
                vertices[target++] = x0;
                vertices[target++] = y0;
                vertices[target++] = r;
                vertices[target++] = g;
                vertices[target++] = b;
                vertices[target++] = a;
                vertices[target++] = x1;
                vertices[target++] = y0;
                vertices[target++] = r;
                vertices[target++] = g;
                vertices[target++] = b;
                vertices[target++] = a;
                vertices[target++] = x0;
                vertices[target++] = y1;
                vertices[target++] = r;
                vertices[target++] = g;
                vertices[target++] = b;
                vertices[target++] = a;
                // Triangle 2: (x0, y1), (x1, y0), (x1, y1)
                vertices[target++] = x0;
                vertices[target++] = y1;
                vertices[target++] = r;
                vertices[target++] = g;
                vertices[target++] = b;
                vertices[target++] = a;
                vertices[target++] = x1;
                vertices[target++] = y0;
                vertices[target++] = r;
                vertices[target++] = g;
                vertices[target++] = b;
                vertices[target++] = a;
                vertices[target++] = x1;
                vertices[target++] = y1;
                vertices[target++] = r;
                vertices[target++] = g;
                vertices[target++] = b;
                vertices[target++] = a;
            }
            series.upload(vertices, null);
            series.setPasses([{
                    primitive: gl.TRIANGLES, count: barCount * 6, first: 0, indexed: false, snapOffset: 0,
                }]);
            return;
        }
        if (type === 'area' && pointCount >= 2) {
            const segCount = pointCount - 1;
            const vertices = new Float32Array(segCount * 6 * WebGLSeries_js_1.VERTEX_STRIDE);
            const fill = fillColor ?? [color[0], color[1], color[2], color[3] * 0.3];
            let target = 0;
            for (let i = 0; i < segCount; i++) {
                const s0 = i * stride;
                const s1 = (i + 1) * stride;
                const x0 = points[s0];
                const y0 = points[s0 + 1];
                const x1 = points[s1];
                const y1 = points[s1 + 1];
                // Triangle 1: (x0, baseline), (x1, baseline), (x0, y0)
                vertices[target++] = x0;
                vertices[target++] = baseline;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
                vertices[target++] = x1;
                vertices[target++] = baseline;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
                vertices[target++] = x0;
                vertices[target++] = y0;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
                // Triangle 2: (x0, y0), (x1, baseline), (x1, y1)
                vertices[target++] = x0;
                vertices[target++] = y0;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
                vertices[target++] = x1;
                vertices[target++] = baseline;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
                vertices[target++] = x1;
                vertices[target++] = y1;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
            }
            series.upload(vertices, null);
            series.setPasses([{
                    primitive: gl.TRIANGLES, count: segCount * 6, first: 0, indexed: false, snapOffset: 0,
                }]);
            return;
        }
        if (type === 'band' && points2 && points2.length >= 2 && pointCount >= 2) {
            const p2Stride = points2.length % 6 === 0 && stride === 6 ? 6 : 2;
            const p2Count = Math.floor(points2.length / p2Stride);
            const count = Math.min(pointCount, p2Count);
            const segCount = count - 1;
            const vertices = new Float32Array(segCount * 6 * WebGLSeries_js_1.VERTEX_STRIDE);
            const fill = fillColor ?? [color[0], color[1], color[2], color[3] * 0.25];
            let target = 0;
            for (let i = 0; i < segCount; i++) {
                const s0 = i * stride;
                const s1 = (i + 1) * stride;
                const p2s0 = i * p2Stride;
                const p2s1 = (i + 1) * p2Stride;
                const x0 = points[s0];
                const y0_top = points[s0 + 1];
                const x1 = points[s1];
                const y1_top = points[s1 + 1];
                const y0_bot = points2[p2s0 + 1];
                const y1_bot = points2[p2s1 + 1];
                // Triangle 1: (x0, y0_bot), (x1, y1_bot), (x0, y0_top)
                vertices[target++] = x0;
                vertices[target++] = y0_bot;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
                vertices[target++] = x1;
                vertices[target++] = y1_bot;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
                vertices[target++] = x0;
                vertices[target++] = y0_top;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
                // Triangle 2: (x0, y0_top), (x1, y1_bot), (x1, y1_top)
                vertices[target++] = x0;
                vertices[target++] = y0_top;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
                vertices[target++] = x1;
                vertices[target++] = y1_bot;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
                vertices[target++] = x1;
                vertices[target++] = y1_top;
                vertices[target++] = fill[0];
                vertices[target++] = fill[1];
                vertices[target++] = fill[2];
                vertices[target++] = fill[3];
            }
            series.upload(vertices, null);
            series.setPasses([{
                    primitive: gl.TRIANGLES, count: segCount * 6, first: 0, indexed: false, snapOffset: 0,
                }]);
            return;
        }
        if (pointCount < 2) {
            series.setPasses([]);
            return;
        }
        const vertices = new Float32Array(pointCount * WebGLSeries_js_1.VERTEX_STRIDE);
        for (let index = 0; index < pointCount; index++) {
            const source = index * stride;
            const target = index * WebGLSeries_js_1.VERTEX_STRIDE;
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
    retainOverlays(activeIds) {
        for (const [id, series] of Array.from(this.overlaySeries.entries())) {
            if (activeIds.has(id))
                continue;
            const index = this.series.indexOf(series);
            if (index >= 0)
                this.series.splice(index, 1);
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
    drawArea(points, fill, basePrice) {
        const gl = this.requireContext();
        const series = this.areaSeries;
        if (!series)
            return;
        if (points.length % 2 !== 0) {
            throw new Error('MatrixCharts: Area points must contain interleaved x/y pairs.');
        }
        const pointCount = points.length / 2;
        if (pointCount < 2) {
            series.setPasses([]);
            return;
        }
        // Two vertices per point: the point itself and its twin on the baseline.
        const vertices = new Float32Array(pointCount * 2 * WebGLSeries_js_1.VERTEX_STRIDE);
        for (let index = 0; index < pointCount; index++) {
            const source = index * 2;
            const top = index * 2 * WebGLSeries_js_1.VERTEX_STRIDE;
            const bottom = top + WebGLSeries_js_1.VERTEX_STRIDE;
            vertices[top] = points[source];
            vertices[top + 1] = points[source + 1];
            vertices[top + 2] = fill[0];
            vertices[top + 3] = fill[1];
            vertices[top + 4] = fill[2];
            vertices[top + 5] = fill[3];
            vertices[bottom] = points[source];
            vertices[bottom + 1] = basePrice;
            vertices[bottom + 2] = fill[0];
            vertices[bottom + 3] = fill[1];
            vertices[bottom + 4] = fill[2];
            vertices[bottom + 5] = fill[3];
        }
        // One quad per segment between the points, as two triangles.
        const indices = new Uint32Array((pointCount - 1) * 6);
        let cursor = 0;
        for (let index = 0; index < pointCount - 1; index++) {
            const topLeft = index * 2;
            const bottomLeft = topLeft + 1;
            const topRight = topLeft + 2;
            const bottomRight = topLeft + 3;
            indices[cursor++] = topLeft;
            indices[cursor++] = bottomLeft;
            indices[cursor++] = topRight;
            indices[cursor++] = topRight;
            indices[cursor++] = bottomLeft;
            indices[cursor++] = bottomRight;
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
    clearArea() {
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
    drawOhlcBars(candles, colors) {
        const gl = this.requireContext();
        const series = this.candleSeries;
        if (!series)
            return;
        const candleCount = candles.length / candleLayout_js_1.CANDLE_STRIDE;
        if (candleCount === 0) {
            series.setPasses([]);
            return;
        }
        const scaleX = Math.abs(this.currentScale[0]);
        if (scaleX === 0) {
            throw new Error('MatrixCharts: OHLC bar viewport scale must be non-zero.');
        }
        const vertices = new Float32Array(candleCount * 6 * WebGLSeries_js_1.VERTEX_STRIDE);
        let cursor = 0;
        for (let candleIndex = 0; candleIndex < candleCount; candleIndex++) {
            const inputIndex = candleIndex * candleLayout_js_1.CANDLE_STRIDE;
            const x = candles[inputIndex + candleLayout_js_1.CANDLE_X];
            const open = candles[inputIndex + candleLayout_js_1.CANDLE_OPEN];
            const high = candles[inputIndex + candleLayout_js_1.CANDLE_HIGH];
            const low = candles[inputIndex + candleLayout_js_1.CANDLE_LOW];
            const close = candles[inputIndex + candleLayout_js_1.CANDLE_CLOSE];
            const width = candles[inputIndex + candleLayout_js_1.CANDLE_WIDTH];
            if (![x, open, high, low, close, width].every(Number.isFinite) || width <= 0) {
                throw new Error('MatrixCharts: OHLC bar values must be finite and width must be positive.');
            }
            let neighborSpacing = Number.POSITIVE_INFINITY;
            if (candleIndex > 0) {
                const previous = Math.abs(x - candles[inputIndex - candleLayout_js_1.CANDLE_STRIDE]);
                if (previous > 0)
                    neighborSpacing = Math.min(neighborSpacing, previous);
            }
            if (candleIndex + 1 < candleCount) {
                const next = Math.abs(candles[inputIndex + candleLayout_js_1.CANDLE_STRIDE] - x);
                if (next > 0)
                    neighborSpacing = Math.min(neighborSpacing, next);
            }
            if (!Number.isFinite(neighborSpacing))
                neighborSpacing = width;
            // Half the gap, in data x, so the two ticks of neighbouring bars meet
            // at the midpoint rather than overlapping.
            const tick = Math.min(neighborSpacing, width) / 2;
            const color = close >= open ? colors.up : colors.down;
            const segments = [
                [x, low, x, high],
                [x, open, x - tick, open],
                [x, close, x + tick, close],
            ];
            for (const [x0, y0, x1, y1] of segments) {
                vertices[cursor++] = x0;
                vertices[cursor++] = y0;
                vertices[cursor++] = color[0];
                vertices[cursor++] = color[1];
                vertices[cursor++] = color[2];
                vertices[cursor++] = color[3];
                vertices[cursor++] = x1;
                vertices[cursor++] = y1;
                vertices[cursor++] = color[0];
                vertices[cursor++] = color[1];
                vertices[cursor++] = color[2];
                vertices[cursor++] = color[3];
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
    drawHistogram(levels, colors, scaleY, offsetY, pane = 0) {
        const gl = this.requireContext();
        const series = this.volumeSeries;
        if (!series)
            return;
        series.pane = pane;
        if (levels.length % candleLayout_js_1.CANDLE_STRIDE !== 0) {
            throw new Error('MatrixCharts: Histogram input must contain candle records.');
        }
        const count = levels.length / candleLayout_js_1.CANDLE_STRIDE;
        if (count === 0) {
            series.setPasses([]);
            return;
        }
        const barScaleX = Math.abs(this.currentScale[0]);
        if (barScaleX === 0 || scaleY === 0) {
            throw new Error('MatrixCharts: Histogram viewport scales must be non-zero.');
        }
        // Four vertices and six indices per bar, one triangle-pair. Bars are drawn
        // back to front in index order, which is also the time order.
        const vertices = new Float32Array(count * 4 * WebGLSeries_js_1.VERTEX_STRIDE);
        const indices = new Uint32Array(count * 6);
        let vertexFloat = 0;
        let indexOffset = 0;
        for (let barIndex = 0; barIndex < count; barIndex++) {
            const inputIndex = barIndex * candleLayout_js_1.CANDLE_STRIDE;
            const x = levels[inputIndex + candleLayout_js_1.CANDLE_X];
            const open = levels[inputIndex + candleLayout_js_1.CANDLE_OPEN];
            const close = levels[inputIndex + candleLayout_js_1.CANDLE_CLOSE];
            const volume = levels[inputIndex + candleLayout_js_1.CANDLE_VOLUME];
            const weight = levels[inputIndex + candleLayout_js_1.CANDLE_WIDTH];
            if (![x, open, close, volume, weight].every(Number.isFinite) || weight <= 0) {
                throw new Error('MatrixCharts: Histogram values must be finite and width must be positive.');
            }
            let neighborSpacing = Number.POSITIVE_INFINITY;
            if (barIndex > 0) {
                const previous = Math.abs(x - levels[inputIndex - candleLayout_js_1.CANDLE_STRIDE]);
                if (previous > 0)
                    neighborSpacing = Math.min(neighborSpacing, previous);
            }
            if (barIndex + 1 < count) {
                const next = Math.abs(levels[inputIndex + candleLayout_js_1.CANDLE_STRIDE] - x);
                if (next > 0)
                    neighborSpacing = Math.min(neighborSpacing, next);
            }
            if (!Number.isFinite(neighborSpacing))
                neighborSpacing = weight;
            // The same bar-edge helper the candlesticks use, so a volume bar lines
            // up with the candle above it on the same pixel columns.
            const { left, right } = (0, candlestickBodyWidth_js_1.candlestickBodyEdgesData)(x, neighborSpacing, barScaleX, this.currentOffset[0], this.devicePixelRatio);
            // Bars grow from the baseline up, so a zero volume is a zero-height
            // bar rather than a bar hanging from the top.
            const baseline = 0;
            const top = volume > 0 ? volume : baseline;
            const color = close >= open ? colors.up : colors.down;
            const base = barIndex * 4;
            // Bottom-left, bottom-right, top-left, top-right.
            const corners = [
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
    clearCandlesticks() {
        this.candleSeries?.setPasses([]);
    }
    /** Clears the line polyline. */
    clearLine() {
        this.lineSeries?.setPasses([]);
    }
    /**
     * Clears the histogram so a frame where volume is switched off or the data
     * carries none does not keep drawing the previous frame's bars.
     */
    clearHistogram() {
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
    drawCandlesticks(candles, spec) {
        const gl = this.requireContext();
        const series = this.candleSeries;
        if (!series)
            return;
        if (spec.style === 'ohlc') {
            this.drawOhlcBars(candles, spec.colors);
            return;
        }
        // A hollow candle is outlined in its own body colour and left unfilled, so
        // the frame is the entire visual and is drawn whether or not borders were
        // asked for. The fill becomes transparent and the frame takes over the
        // border colours, which is the whole difference between the two styles.
        const hollow = spec.style === 'hollow';
        const colors = hollow
            ? { ...spec.colors, borderUp: spec.colors.up, borderDown: spec.colors.down }
            : spec.colors;
        const wickVisible = spec.wickVisible;
        const borderVisible = hollow ? true : spec.borderVisible;
        if (candles.length % candleLayout_js_1.CANDLE_STRIDE !== 0) {
            throw new Error('MatrixCharts: Candles must contain x/open/high/low/close/width values.');
        }
        const candleCount = candles.length / candleLayout_js_1.CANDLE_STRIDE;
        if (candleCount === 0) {
            // Nothing to draw. Skipping the upload avoids handing WebGL zero-length
            // buffers on the empty first frame, which buys nothing.
            series.setPasses([]);
            return;
        }
        const scaleX = Math.abs(this.currentScale[0]);
        const scaleY = Math.abs(this.currentScale[1]);
        if (scaleX === 0 || scaleY === 0) {
            throw new Error('MatrixCharts: Candlestick viewport scales must be non-zero.');
        }
        // Three contiguous blocks per frame: wicks, then optional border frames,
        // then body fills. Each block starts at a fixed offset so the three can
        // never overlap, whatever the flags say. The baseline rule, when drawn,
        // adds two vertices to the tail of the wick block.
        const wickVerticesPerCandle = wickVisible ? 4 : 0;
        // A border is a frame of four quads, so 16 vertices and 24 indices.
        const borderVerticesPerCandle = borderVisible ? 16 : 0;
        const baselineVertices = spec.style === 'baseline' && spec.baselinePrice !== null ? 2 : 0;
        const bodyVertexStart = candleCount * (wickVerticesPerCandle + borderVerticesPerCandle);
        const verticesPerCandle = wickVerticesPerCandle + borderVerticesPerCandle + 4;
        const totalVertices = candleCount * verticesPerCandle + baselineVertices;
        const vertices = new Float32Array(totalVertices * WebGLSeries_js_1.VERTEX_STRIDE);
        const indicesPerCandle = (borderVisible ? 24 : 0) + 6;
        const bodyIndices = new Uint32Array(candleCount * indicesPerCandle);
        // Two cursors per block, and they count different things: a float offset
        // into the interleaved vertex array, and a vertex id for the index buffer.
        // Conflating them puts every index six times past the end of the buffer.
        let wickFloat = 0;
        let borderFloat = candleCount * wickVerticesPerCandle * WebGLSeries_js_1.VERTEX_STRIDE;
        let bodyFloat = bodyVertexStart * WebGLSeries_js_1.VERTEX_STRIDE;
        let borderVertexId = candleCount * wickVerticesPerCandle;
        let bodyVertexId = bodyVertexStart;
        let bodyIndexOffset = 0;
        for (let candleIndex = 0; candleIndex < candleCount; candleIndex++) {
            const inputIndex = candleIndex * candleLayout_js_1.CANDLE_STRIDE;
            const x = candles[inputIndex + candleLayout_js_1.CANDLE_X];
            const open = candles[inputIndex + candleLayout_js_1.CANDLE_OPEN];
            const high = candles[inputIndex + candleLayout_js_1.CANDLE_HIGH];
            const low = candles[inputIndex + candleLayout_js_1.CANDLE_LOW];
            const close = candles[inputIndex + candleLayout_js_1.CANDLE_CLOSE];
            const width = candles[inputIndex + candleLayout_js_1.CANDLE_WIDTH];
            if (![x, open, high, low, close, width].every(Number.isFinite) || width <= 0) {
                throw new Error('MatrixCharts: Candlestick values must be finite and width must be positive.');
            }
            const bullish = close >= open;
            // The body fill and the wick are separate colours. A hollow candle has a
            // transparent fill but a fully drawn wick, so making the fill transparent
            // must not make the wick disappear with it.
            const fillColor = hollow
                ? TRANSPARENT
                : (bullish ? colors.up : colors.down);
            const wickColor = bullish ? colors.up : colors.down;
            const borderColor = bullish ? colors.borderUp : colors.borderDown;
            let neighborSpacing = Number.POSITIVE_INFINITY;
            if (candleIndex > 0) {
                const previousSpacing = Math.abs(x - candles[inputIndex - candleLayout_js_1.CANDLE_STRIDE]);
                if (previousSpacing > 0)
                    neighborSpacing = Math.min(neighborSpacing, previousSpacing);
            }
            if (candleIndex + 1 < candleCount) {
                const nextSpacing = Math.abs(candles[inputIndex + candleLayout_js_1.CANDLE_STRIDE] - x);
                if (nextSpacing > 0)
                    neighborSpacing = Math.min(neighborSpacing, nextSpacing);
            }
            if (!Number.isFinite(neighborSpacing))
                neighborSpacing = width;
            const { left: bodyLeft, right: bodyRight } = (0, candlestickBodyWidth_js_1.candlestickBodyEdgesData)(x, neighborSpacing, scaleX, this.currentOffset[0], this.devicePixelRatio);
            let bodyTop = Math.max(open, close);
            let bodyBottom = Math.min(open, close);
            const bodyHeightPixels = (bodyTop - bodyBottom) * scaleY * this.devicePixelRatio;
            if (bodyHeightPixels < 1) {
                const halfPixelHeight = 0.5 / (scaleY * this.devicePixelRatio);
                const bodyCenter = (bodyTop + bodyBottom) / 2;
                bodyTop = bodyCenter + halfPixelHeight;
                bodyBottom = bodyCenter - halfPixelHeight;
            }
            const physicalTop = Math.floor((bodyTop * this.currentScale[1] + this.currentOffset[1]) * this.devicePixelRatio + 0.5);
            const physicalBottom = Math.floor((bodyBottom * this.currentScale[1] + this.currentOffset[1]) * this.devicePixelRatio + 0.5);
            // The wick ends 1.5px *inside* the body, so it cannot leave a seam where
            // it meets the body edge. "Inside" is toward the body's centre, which is
            // down the screen on an ordinary axis and **up** the screen on an
            // inverted one — so the inset follows the sign of the scale rather than
            // assuming higher values sit higher. Assuming it is what puts an inverted
            // chart's wick clamp on the wrong edge and draws it across the body.
            const inward = this.currentScale[1] < 0 ? 1.5 : -1.5;
            const upperPixelCenter = physicalTop + inward;
            const lowerPixelCenter = physicalBottom - inward;
            const upperWickBoundary = (upperPixelCenter / this.devicePixelRatio - this.currentOffset[1]) / this.currentScale[1];
            const lowerWickBoundary = (lowerPixelCenter / this.devicePixelRatio - this.currentOffset[1]) / this.currentScale[1];
            const upperWickEnd = Math.max(bodyBottom, Math.min(high, upperWickBoundary));
            const lowerWickStart = Math.min(bodyTop, Math.max(low, lowerWickBoundary));
            // Upper wick ends above the body; lower wick starts below it to avoid overdraw seams.
            if (wickVisible) {
                vertices[wickFloat++] = x;
                vertices[wickFloat++] = high;
                vertices[wickFloat++] = wickColor[0];
                vertices[wickFloat++] = wickColor[1];
                vertices[wickFloat++] = wickColor[2];
                vertices[wickFloat++] = wickColor[3];
                vertices[wickFloat++] = x;
                vertices[wickFloat++] = upperWickEnd;
                vertices[wickFloat++] = wickColor[0];
                vertices[wickFloat++] = wickColor[1];
                vertices[wickFloat++] = wickColor[2];
                vertices[wickFloat++] = wickColor[3];
                vertices[wickFloat++] = x;
                vertices[wickFloat++] = lowerWickStart;
                vertices[wickFloat++] = wickColor[0];
                vertices[wickFloat++] = wickColor[1];
                vertices[wickFloat++] = wickColor[2];
                vertices[wickFloat++] = wickColor[3];
                vertices[wickFloat++] = x;
                vertices[wickFloat++] = low;
                vertices[wickFloat++] = wickColor[0];
                vertices[wickFloat++] = wickColor[1];
                vertices[wickFloat++] = wickColor[2];
                vertices[wickFloat++] = wickColor[3];
            }
            // The border is a one-device-pixel frame on the body outline, and the
            // fill is drawn inset to match. The frame is four strips rather than one
            // quad under the fill, because a translucent fill would otherwise
            // composite onto the border colour instead of the background and the
            // whole body would take on the border's hue.
            let fillLeft = bodyLeft;
            let fillRight = bodyRight;
            let fillTop = bodyTop;
            let fillBottom = bodyBottom;
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
                const ratio = Math.fround(this.devicePixelRatio);
                const snapScaleX = Math.fround(this.currentScale[0]);
                const snapScaleY = Math.fround(this.currentScale[1]);
                const snapOffsetX = Math.fround(this.currentOffset[0]);
                const snapOffsetY = Math.fround(this.currentOffset[1]);
                /** Device column of a data x, matching the shader's body snap. */
                const columnOf = (dataX) => Math.floor(Math.fround(Math.fround(Math.fround(dataX * snapScaleX) + snapOffsetX) * ratio) + 0.5);
                /** Device row of a price, matching the shader's body snap. */
                const rowOf = (price) => Math.floor(Math.fround(Math.fround(Math.fround(price * snapScaleY) + snapOffsetY) * ratio) + 0.5);
                /** Data x whose device column is exactly `column`. */
                const dataForColumn = (column) => ((column / ratio - snapOffsetX) / snapScaleX);
                /** Price whose device row is exactly `row`. */
                const dataForRow = (row) => ((row / ratio - snapOffsetY) / snapScaleY);
                const leftColumn = columnOf(bodyLeft);
                const rightColumn = columnOf(bodyRight);
                const topRow = rowOf(bodyTop);
                const bottomRow = rowOf(bodyBottom);
                // A one-pixel frame needs an interior left over, so a body thinner
                // than three device pixels on either axis carries no frame at all.
                const hasRoom = rightColumn - leftColumn > 3 && bottomRow - topRow > 3;
                fillTop = dataForRow(topRow);
                fillBottom = dataForRow(bottomRow);
                if (hasRoom) {
                    const innerLeftColumn = leftColumn + 1;
                    const innerRightColumn = rightColumn - 1;
                    const innerTopRow = topRow + 1;
                    const innerBottomRow = bottomRow - 1;
                    const innerLeft = dataForColumn(innerLeftColumn);
                    const innerRight = dataForColumn(innerRightColumn);
                    const innerTop = dataForRow(innerTopRow);
                    const innerBottom = dataForRow(innerBottomRow);
                    const frameLeft = dataForColumn(leftColumn);
                    const frameRight = dataForColumn(rightColumn);
                    /** One axis-aligned quad: 4 vertices and 6 indices. */
                    const writeStrip = (left, right, bottom, top) => {
                        vertices[borderFloat++] = left;
                        vertices[borderFloat++] = bottom;
                        vertices[borderFloat++] = borderColor[0];
                        vertices[borderFloat++] = borderColor[1];
                        vertices[borderFloat++] = borderColor[2];
                        vertices[borderFloat++] = borderColor[3];
                        vertices[borderFloat++] = right;
                        vertices[borderFloat++] = bottom;
                        vertices[borderFloat++] = borderColor[0];
                        vertices[borderFloat++] = borderColor[1];
                        vertices[borderFloat++] = borderColor[2];
                        vertices[borderFloat++] = borderColor[3];
                        vertices[borderFloat++] = left;
                        vertices[borderFloat++] = top;
                        vertices[borderFloat++] = borderColor[0];
                        vertices[borderFloat++] = borderColor[1];
                        vertices[borderFloat++] = borderColor[2];
                        vertices[borderFloat++] = borderColor[3];
                        vertices[borderFloat++] = right;
                        vertices[borderFloat++] = top;
                        vertices[borderFloat++] = borderColor[0];
                        vertices[borderFloat++] = borderColor[1];
                        vertices[borderFloat++] = borderColor[2];
                        vertices[borderFloat++] = borderColor[3];
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
            vertices[bodyFloat++] = fillLeft;
            vertices[bodyFloat++] = fillBottom;
            vertices[bodyFloat++] = fillColor[0];
            vertices[bodyFloat++] = fillColor[1];
            vertices[bodyFloat++] = fillColor[2];
            vertices[bodyFloat++] = fillColor[3];
            vertices[bodyFloat++] = fillRight;
            vertices[bodyFloat++] = fillBottom;
            vertices[bodyFloat++] = fillColor[0];
            vertices[bodyFloat++] = fillColor[1];
            vertices[bodyFloat++] = fillColor[2];
            vertices[bodyFloat++] = fillColor[3];
            vertices[bodyFloat++] = fillLeft;
            vertices[bodyFloat++] = fillTop;
            vertices[bodyFloat++] = fillColor[0];
            vertices[bodyFloat++] = fillColor[1];
            vertices[bodyFloat++] = fillColor[2];
            vertices[bodyFloat++] = fillColor[3];
            vertices[bodyFloat++] = fillRight;
            vertices[bodyFloat++] = fillTop;
            vertices[bodyFloat++] = fillColor[0];
            vertices[bodyFloat++] = fillColor[1];
            vertices[bodyFloat++] = fillColor[2];
            vertices[bodyFloat++] = fillColor[3];
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
        const baselinePrice = spec.style === 'baseline' ? spec.baselinePrice : null;
        const hasBaseline = baselinePrice !== null && candleCount >= 2;
        if (hasBaseline) {
            const firstX = candles[candleLayout_js_1.CANDLE_X];
            const lastX = candles[(candleCount - 1) * candleLayout_js_1.CANDLE_STRIDE + candleLayout_js_1.CANDLE_X];
            let cursor = candleCount * wickVerticesPerCandle * WebGLSeries_js_1.VERTEX_STRIDE;
            for (const x of [firstX, lastX]) {
                vertices[cursor++] = x;
                vertices[cursor++] = baselinePrice;
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
        const passes = [];
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
    render() {
        const gl = this.requireContext();
        if (!this.canvas || !this.program)
            return;
        if (this.series.every((entry) => entry.isEmpty))
            return;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        const uniforms = {
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
        // Confine data to the plot rect. Without this a bar scrolled part-way past
        // an edge keeps painting over the axis gutter it is supposed to be clipped
        // by. GL's origin is bottom-left, so the box is mirrored in y, and the
        // extents are rounded so a fractional ratio cannot leave a seam.
        const plot = this.currentPlot;
        const clipWidth = Math.round(plot.width * this.devicePixelRatio);
        const clipHeight = Math.round(plot.height * this.devicePixelRatio);
        if (clipWidth <= 0 || clipHeight <= 0) {
            // A collapsed plot has no area to confine to; draw nothing rather than
            // letting data cover the whole canvas.
            gl.disable(gl.SCISSOR_TEST);
            return;
        }
        gl.enable(gl.SCISSOR_TEST);
        const applyScissor = (rect) => {
            gl.scissor(Math.round(rect.x * this.devicePixelRatio), Math.round(this.canvas.height - (rect.y + rect.height) * this.devicePixelRatio), Math.round(rect.width * this.devicePixelRatio), Math.round(rect.height * this.devicePixelRatio));
        };
        applyScissor(plot);
        for (const entry of this.series) {
            // A series in a pane is clipped to that pane rather than to the whole
            // plot. The price pane uses the plot rect, which is the same box in the
            // single-pane case, so this only changes anything once panes exist.
            const paneRect = this.currentPanes[entry.pane];
            const targetPaneRect = (this.currentPanes.length > 0 && paneRect !== undefined) ? paneRect : plot;
            applyScissor(targetPaneRect);
            entry.draw(uniforms, this.resolutionLocation, this.offsetLocation, this.scaleLocation, this.pixelRatioLocation, this.snapOffsetLocation);
        }
        gl.bindVertexArray(null);
        // Clipping is a per-draw decision, not a mode the renderer leaves on, so
        // the next clear starts from an unconfined buffer.
        gl.disable(gl.SCISSOR_TEST);
    }
    destroy() {
        if (this.emitter) {
            this.emitter.off('viewport', this.handleViewportEvent);
        }
        for (const entry of this.overlaySeries.values())
            entry.destroy();
        this.overlaySeries.clear();
        for (const entry of this.series)
            entry.destroy();
        this.series = [];
        this.candleSeries = null;
        this.lineSeries = null;
        this.volumeSeries = null;
        this.areaSeries = null;
        if (this.gl) {
            if (this.vertexShader)
                this.gl.deleteShader(this.vertexShader);
            if (this.fragmentShader)
                this.gl.deleteShader(this.fragmentShader);
            if (this.program)
                this.gl.deleteProgram(this.program);
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
    requireContext() {
        if (!this.gl)
            throw new Error('MatrixCharts: WebGL2 is required.');
        return this.gl;
    }
    compileShader(type, source) {
        const gl = this.requireContext();
        const shader = gl.createShader(type);
        if (!shader)
            throw new Error('MatrixCharts: Failed to create a WebGL shader.');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader) ?? 'unknown error';
            gl.deleteShader(shader);
            throw new Error(`MatrixCharts: WebGL shader compilation failed: ${log}`);
        }
        return shader;
    }
    linkProgram(vertex, fragment) {
        const gl = this.requireContext();
        const program = gl.createProgram();
        if (!program)
            throw new Error('MatrixCharts: Failed to create a WebGL program.');
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(program) ?? 'unknown error';
            gl.deleteProgram(program);
            throw new Error(`MatrixCharts: WebGL program linking failed: ${log}`);
        }
        return program;
    }
}
exports.WebGL2Renderer = WebGL2Renderer;
