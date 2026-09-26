// src/renderers/WebGL2Renderer.ts
import type { ResolvedCandleColors } from '../core/options.js';
import type { IRenderer } from '../core/IRenderer.js';
import type { EventEmitter, ChartEvents } from '../core/EventEmitter.js';
import { candlestickBodyEdgesData } from '../math/candlestickBodyWidth.js';

export class WebGL2Renderer implements IRenderer {
    private gl: WebGL2RenderingContext | null = null;
    private emitter!: EventEmitter<ChartEvents>;
    private canvas: HTMLCanvasElement | null = null;
    private program: WebGLProgram | null = null;
    private vertexShader: WebGLShader | null = null;
    private fragmentShader: WebGLShader | null = null;
    private candleProgram: WebGLProgram | null = null;
    private candleVertexShader: WebGLShader | null = null;
    private candleFragmentShader: WebGLShader | null = null;
    
    // FIX: Add Vertex Array Object (VAO) to satisfy strict Core Profiles
    private vao: WebGLVertexArrayObject | null = null;
    private lineBuffer: WebGLBuffer | null = null;
    private candleVao: WebGLVertexArrayObject | null = null;
    private candleBuffer: WebGLBuffer | null = null;
    private candleIndexBuffer: WebGLBuffer | null = null;
    
    private positionLocation: number = -1;
    private resolutionLocation: WebGLUniformLocation | null = null;
    private offsetLocation: WebGLUniformLocation | null = null;
    private scaleLocation: WebGLUniformLocation | null = null;
    private colorLocation: WebGLUniformLocation | null = null;
    private candlePositionLocation: number = -1;
    private candleColorLocation: number = -1;
    private candleResolutionLocation: WebGLUniformLocation | null = null;
    private candleOffsetLocation: WebGLUniformLocation | null = null;
    private candleScaleLocation: WebGLUniformLocation | null = null;
    private candlePixelRatioLocation: WebGLUniformLocation | null = null;
    private candleSnapOffsetLocation: WebGLUniformLocation | null = null;

    private currentOffset: [number, number] = [0, 0];
    private currentScale: [number, number] = [1, 1];
    private devicePixelRatio: number = 1;
    private lineVertexCount: number = 0;
    private candleWickVertexCount: number = 0;
    private candleBodyVertexCount: number = 0;

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

        // FIX: Add u_offset entirely to prevent the GLSL compiler from optimizing it out
        const vertexShaderSource: string = `#version 300 es
            in vec2 a_position;
            uniform vec2 u_resolution;
            uniform vec2 u_offset;
            uniform vec2 u_scale;
            void main() {
                vec2 scaledPosition = (a_position * u_scale) + u_offset;
                vec2 zeroToOne = scaledPosition / u_resolution;
                vec2 clipSpace = (zeroToOne * 2.0) - 1.0;
                gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);
            }
        `;

        const fragmentShaderSource: string = `#version 300 es
            precision highp float;
            uniform vec4 u_color;
            out vec4 outColor;
            void main() {
                outColor = u_color;
            }
        `;
        const candleVertexShaderSource: string = `#version 300 es
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
        const candleFragmentShaderSource: string = `#version 300 es
            precision highp float;
            in vec4 v_color;
            out vec4 outColor;
            void main() {
                outColor = v_color;
            }
        `;

        this.gl = gl;
        this.canvas = canvas;

        try {
            this.vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexShaderSource);
            this.fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
            this.program = this.linkProgram(this.vertexShader, this.fragmentShader);
            this.candleVertexShader = this.compileShader(gl.VERTEX_SHADER, candleVertexShaderSource);
            this.candleFragmentShader = this.compileShader(gl.FRAGMENT_SHADER, candleFragmentShaderSource);
            this.candleProgram = this.linkProgram(this.candleVertexShader, this.candleFragmentShader);

            // FIX: Create and bind the VAO before setting up the buffers
            this.vao = gl.createVertexArray();
            if (!this.vao) throw new Error('MatrixCharts: Failed to create VAO.');
            gl.bindVertexArray(this.vao);

            this.lineBuffer = gl.createBuffer();
            if (!this.lineBuffer) throw new Error('MatrixCharts: Failed to create the WebGL line buffer.');
            
            // Bind the buffer and assign pointers to the VAO permanently
            this.positionLocation = gl.getAttribLocation(this.program, 'a_position');
            gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
            gl.enableVertexAttribArray(this.positionLocation);
            gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);

            this.resolutionLocation = gl.getUniformLocation(this.program, 'u_resolution');
            this.offsetLocation = gl.getUniformLocation(this.program, 'u_offset');
            this.scaleLocation = gl.getUniformLocation(this.program, 'u_scale');
            this.colorLocation = gl.getUniformLocation(this.program, 'u_color');

            if (
                this.positionLocation < 0 ||
                !this.resolutionLocation ||
                !this.offsetLocation ||
                !this.scaleLocation ||
                !this.colorLocation
            ) {
                throw new Error('MatrixCharts: Required WebGL shader inputs were not found.');
            }

            this.candleVao = gl.createVertexArray();
            this.candleBuffer = gl.createBuffer();
            this.candleIndexBuffer = gl.createBuffer();
            if (!this.candleVao || !this.candleBuffer || !this.candleIndexBuffer) {
                throw new Error('MatrixCharts: Failed to create candlestick GPU resources.');
            }
            gl.bindVertexArray(this.candleVao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.candleBuffer);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.candleIndexBuffer);
            this.candlePositionLocation = gl.getAttribLocation(this.candleProgram, 'a_position');
            this.candleColorLocation = gl.getAttribLocation(this.candleProgram, 'a_color');
            gl.enableVertexAttribArray(this.candlePositionLocation);
            gl.vertexAttribPointer(this.candlePositionLocation, 2, gl.FLOAT, false, 24, 0);
            gl.enableVertexAttribArray(this.candleColorLocation);
            gl.vertexAttribPointer(this.candleColorLocation, 4, gl.FLOAT, false, 24, 8);
            this.candleResolutionLocation = gl.getUniformLocation(this.candleProgram, 'u_resolution');
            this.candleOffsetLocation = gl.getUniformLocation(this.candleProgram, 'u_offset');
            this.candleScaleLocation = gl.getUniformLocation(this.candleProgram, 'u_scale');
            this.candlePixelRatioLocation = gl.getUniformLocation(this.candleProgram, 'u_pixelRatio');
            this.candleSnapOffsetLocation = gl.getUniformLocation(this.candleProgram, 'u_snapOffset');
            if (
                this.candlePositionLocation < 0 ||
                this.candleColorLocation < 0 ||
                !this.candleResolutionLocation ||
                !this.candleOffsetLocation ||
                !this.candleScaleLocation ||
                !this.candlePixelRatioLocation ||
                !this.candleSnapOffsetLocation
            ) {
                throw new Error('MatrixCharts: Required candlestick shader inputs were not found.');
            }
            gl.bindVertexArray(null);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        } catch (error: unknown) {
            this.destroy();
            throw error;
        }
    }

    public clear(): void {
        const gl: WebGL2RenderingContext = this.requireContext();
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
    };

    public drawLine(points: Float32Array, color: [number, number, number, number]): void {
        const gl: WebGL2RenderingContext = this.requireContext();
        
        // Upload the new coordinates to the bound buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, points, gl.DYNAMIC_DRAW);
        
        gl.useProgram(this.program);
        gl.uniform4fv(this.colorLocation, color);
        this.lineVertexCount = points.length / 2;
    }


      /**
       * Uploads [x, open, high, low, close, width] candles to the GPU.
       *
       * `colors` arrives already parsed from CSS, so this per-frame path never
       * touches colour strings. `wickVisible` skips generating and drawing the
       * wick segments entirely. `borderVisible` adds a 1 device-pixel frame
       * inside the body outline, drawn ahead of the fill in the same indexed
       * pass, so no extra shader or draw call is needed.
       */
    public drawCandlesticks(
        candles: Float32Array,
        colors: ResolvedCandleColors,
        wickVisible: boolean,
        borderVisible: boolean,
    ): void {
        const gl: WebGL2RenderingContext = this.requireContext();
        if (candles.length % 6 !== 0) {
            throw new Error('MatrixCharts: Candles must contain x/open/high/low/close/width values.');
        }

        const candleCount: number = candles.length / 6;
        const vertexStride: number = 6; // x, y, r, g, b, a
        if (candleCount === 0) {
            // Nothing to draw. Skipping the upload avoids handing WebGL zero-length
            // buffers on the empty first frame, which buys nothing.
            this.candleWickVertexCount = 0;
            this.candleBodyVertexCount = 0;
            return;
        }
        const scaleX: number = Math.abs(this.currentScale[0]);
        const scaleY: number = Math.abs(this.currentScale[1]);
        if (scaleX === 0 || scaleY === 0) {
            throw new Error('MatrixCharts: Candlestick viewport scales must be non-zero.');
        }

        // Three contiguous blocks per frame: wicks, then optional border frames,
        // then body fills. Each block starts at a fixed offset so the three can
        // never overlap, whatever the flags say.
        const wickVerticesPerCandle: number = wickVisible ? 4 : 0;
        // A border is a frame of four quads, so 16 vertices and 24 indices.
        const borderVerticesPerCandle: number = borderVisible ? 16 : 0;
        const bodyVertexStart: number = candleCount * (wickVerticesPerCandle + borderVerticesPerCandle);
        const verticesPerCandle: number = wickVerticesPerCandle + borderVerticesPerCandle + 4;
        const totalVertices: number = candleCount * verticesPerCandle;
        const vertices: Float32Array = new Float32Array(totalVertices * vertexStride);
        const indicesPerCandle: number = (borderVisible ? 24 : 0) + 6;
        const bodyIndices: Uint32Array = new Uint32Array(candleCount * indicesPerCandle);

        // Two cursors per block, and they count different things: a float offset
        // into the interleaved vertex array, and a vertex id for the index buffer.
        // Conflating them puts every index six times past the end of the buffer.
        let wickFloat: number = 0;
        let borderFloat: number = candleCount * wickVerticesPerCandle * vertexStride;
        let bodyFloat: number = bodyVertexStart * vertexStride;
        let borderVertexId: number = candleCount * wickVerticesPerCandle;
        let bodyVertexId: number = bodyVertexStart;
        let bodyIndexOffset: number = 0;

        for (let candleIndex: number = 0; candleIndex < candleCount; candleIndex++) {
            const inputIndex: number = candleIndex * 6;
            const x: number = candles[inputIndex];
            const open: number = candles[inputIndex + 1];
            const high: number = candles[inputIndex + 2];
            const low: number = candles[inputIndex + 3];
            const close: number = candles[inputIndex + 4];
            const width: number = candles[inputIndex + 5];

            if (![x, open, high, low, close, width].every(Number.isFinite) || width <= 0) {
                throw new Error('MatrixCharts: Candlestick values must be finite and width must be positive.');
            }

            const bullish: boolean = close >= open;
            const color: [number, number, number, number] = bullish ? colors.up : colors.down;
            const borderColor: [number, number, number, number] = bullish ? colors.borderUp : colors.borderDown;
            let neighborSpacing: number = Number.POSITIVE_INFINITY;
            if (candleIndex > 0) {
                const previousSpacing: number = Math.abs(x - candles[inputIndex - 6]);
                if (previousSpacing > 0) neighborSpacing = Math.min(neighborSpacing, previousSpacing);
            }
            if (candleIndex + 1 < candleCount) {
                const nextSpacing: number = Math.abs(candles[inputIndex + 6] - x);
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
                vertices[wickFloat++] = color[0]; vertices[wickFloat++] = color[1]; vertices[wickFloat++] = color[2]; vertices[wickFloat++] = color[3];

                vertices[wickFloat++] = x; vertices[wickFloat++] = upperWickEnd;
                vertices[wickFloat++] = color[0]; vertices[wickFloat++] = color[1]; vertices[wickFloat++] = color[2]; vertices[wickFloat++] = color[3];

                vertices[wickFloat++] = x; vertices[wickFloat++] = lowerWickStart;
                vertices[wickFloat++] = color[0]; vertices[wickFloat++] = color[1]; vertices[wickFloat++] = color[2]; vertices[wickFloat++] = color[3];

                vertices[wickFloat++] = x; vertices[wickFloat++] = low;
                vertices[wickFloat++] = color[0]; vertices[wickFloat++] = color[1]; vertices[wickFloat++] = color[2]; vertices[wickFloat++] = color[3];
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
                const horizontalInset: number = 1 / (scaleX * this.devicePixelRatio);
                const verticalInset: number = 1 / Math.abs(scaleY * this.devicePixelRatio);
                const hasRoom: boolean =
                    Math.abs(bodyRight - bodyLeft) > horizontalInset * 3
                    && Math.abs(bodyTop - bodyBottom) > verticalInset * 3;

                if (hasRoom) {
                    const innerLeft: number = bodyLeft + horizontalInset;
                    const innerRight: number = bodyRight - horizontalInset;
                    const innerTop: number = bodyTop - verticalInset;
                    const innerBottom: number = bodyBottom + verticalInset;

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
                    writeStrip(bodyLeft, bodyRight, innerTop, bodyTop);
                    writeStrip(bodyLeft, bodyRight, bodyBottom, innerBottom);
                    writeStrip(bodyLeft, innerLeft, innerBottom, innerTop);
                    writeStrip(innerRight, bodyRight, innerBottom, innerTop);

                    fillLeft = innerLeft;
                    fillRight = innerRight;
                    fillTop = innerTop;
                    fillBottom = innerBottom;
                }
            }

            vertices[bodyFloat++] = fillLeft; vertices[bodyFloat++] = fillBottom;
            vertices[bodyFloat++] = color[0]; vertices[bodyFloat++] = color[1]; vertices[bodyFloat++] = color[2]; vertices[bodyFloat++] = color[3];

            vertices[bodyFloat++] = fillRight; vertices[bodyFloat++] = fillBottom;
            vertices[bodyFloat++] = color[0]; vertices[bodyFloat++] = color[1]; vertices[bodyFloat++] = color[2]; vertices[bodyFloat++] = color[3];

            vertices[bodyFloat++] = fillLeft; vertices[bodyFloat++] = fillTop;
            vertices[bodyFloat++] = color[0]; vertices[bodyFloat++] = color[1]; vertices[bodyFloat++] = color[2]; vertices[bodyFloat++] = color[3];

            vertices[bodyFloat++] = fillRight; vertices[bodyFloat++] = fillTop;
            vertices[bodyFloat++] = color[0]; vertices[bodyFloat++] = color[1]; vertices[bodyFloat++] = color[2]; vertices[bodyFloat++] = color[3];

            bodyIndices[bodyIndexOffset++] = bodyVertexId;
            bodyIndices[bodyIndexOffset++] = bodyVertexId + 1;
            bodyIndices[bodyIndexOffset++] = bodyVertexId + 2;
            bodyIndices[bodyIndexOffset++] = bodyVertexId + 2;
            bodyIndices[bodyIndexOffset++] = bodyVertexId + 1;
            bodyIndices[bodyIndexOffset++] = bodyVertexId + 3;
            bodyVertexId += 4;
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.candleBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.candleIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bodyIndices, gl.DYNAMIC_DRAW);
        this.candleWickVertexCount = candleCount * wickVerticesPerCandle;
        this.candleBodyVertexCount = bodyIndexOffset;
    }

    public render(): void {
        const gl: WebGL2RenderingContext = this.requireContext();
        if ((this.lineVertexCount === 0 && this.candleBodyVertexCount === 0) || !this.canvas) return;

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.program);

        const cssWidth = this.canvas.width / this.devicePixelRatio;
        const cssHeight = this.canvas.height / this.devicePixelRatio;

        gl.uniform2f(this.resolutionLocation, cssWidth, cssHeight);
        gl.uniform2f(this.offsetLocation, this.currentOffset[0], this.currentOffset[1]);
        gl.uniform2f(this.scaleLocation, this.currentScale[0], this.currentScale[1]);

        // FIX: Simply bind the VAO and draw. The attribute pointers are already saved.
        if (this.lineVertexCount > 0) {
            gl.useProgram(this.program);
            gl.uniform2f(this.resolutionLocation, cssWidth, cssHeight);
            gl.uniform2f(this.offsetLocation, this.currentOffset[0], this.currentOffset[1]);
            gl.uniform2f(this.scaleLocation, this.currentScale[0], this.currentScale[1]);
            gl.bindVertexArray(this.vao);
            gl.drawArrays(gl.LINE_STRIP, 0, this.lineVertexCount);
        }
        if (this.candleBodyVertexCount > 0) {
            gl.useProgram(this.candleProgram);
            gl.uniform2f(this.candleResolutionLocation, this.canvas.width, this.canvas.height);
            gl.uniform2f(this.candleOffsetLocation, this.currentOffset[0], this.currentOffset[1]);
            gl.uniform2f(this.candleScaleLocation, this.currentScale[0], this.currentScale[1]);
            gl.uniform1f(this.candlePixelRatioLocation, this.devicePixelRatio);
            gl.bindVertexArray(this.candleVao);
            // Skipped entirely when candlestick.wickVisible is false, and the index
            // buffer already carries any border quads ahead of the fills.
            if (this.candleWickVertexCount > 0) {
                gl.uniform1f(this.candleSnapOffsetLocation, 0.5);
                gl.drawArrays(gl.LINES, 0, this.candleWickVertexCount);
            }
            gl.uniform1f(this.candleSnapOffsetLocation, 0.0);
            gl.drawElements(
                gl.TRIANGLES,
                this.candleBodyVertexCount,
                gl.UNSIGNED_INT,
                0,
            );
        }
        gl.bindVertexArray(null);
    }

    public destroy(): void {
        if (this.emitter) {
            this.emitter.off('viewport', this.handleViewportEvent);
        }
        if (this.gl) {
            if (this.lineBuffer) this.gl.deleteBuffer(this.lineBuffer);
            if (this.vao) this.gl.deleteVertexArray(this.vao);
            if (this.vertexShader) this.gl.deleteShader(this.vertexShader);
            if (this.fragmentShader) this.gl.deleteShader(this.fragmentShader);
            if (this.program) this.gl.deleteProgram(this.program);
            if (this.candleBuffer) this.gl.deleteBuffer(this.candleBuffer);
            if (this.candleIndexBuffer) this.gl.deleteBuffer(this.candleIndexBuffer);
            if (this.candleVao) this.gl.deleteVertexArray(this.candleVao);
            if (this.candleVertexShader) this.gl.deleteShader(this.candleVertexShader);
            if (this.candleFragmentShader) this.gl.deleteShader(this.candleFragmentShader);
            if (this.candleProgram) this.gl.deleteProgram(this.candleProgram);
        }
        this.lineBuffer = null;
        this.vao = null;
        this.vertexShader = null;
        this.fragmentShader = null;
        this.program = null;
        this.candleBuffer = null;
        this.candleIndexBuffer = null;
        this.candleVao = null;
        this.candleVertexShader = null;
        this.candleFragmentShader = null;
        this.candleProgram = null;
        this.gl = null;
        this.canvas = null;
        this.candlePositionLocation = -1;
        this.candleColorLocation = -1;
        this.candleResolutionLocation = null;
        this.candleOffsetLocation = null;
        this.candleScaleLocation = null;
        this.candlePixelRatioLocation = null;
        this.candleSnapOffsetLocation = null;
        this.lineVertexCount = 0;
        this.candleWickVertexCount = 0;
        this.candleBodyVertexCount = 0;
    }

    private compileShader(type: number, source: string): WebGLShader {
        const gl = this.requireContext();
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`MatrixCharts: Shader compilation failed. \n${info}`);
        }
        return shader;
    }

    private linkProgram(vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram {
        const gl = this.requireContext();
        const program = gl.createProgram()!;
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(`MatrixCharts: WebGL program linking failed. \n${info}`);
        }
        return program;
    }

    private requireContext(): WebGL2RenderingContext {
        if (!this.gl) throw new Error('MatrixCharts: WebGL2Renderer must be initialized before use.');
        return this.gl;
    }
}