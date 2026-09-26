// src/renderers/WebGL2Renderer.ts
import type { IRenderer } from '../core/IRenderer';
import type { EventEmitter, ChartEvents } from '../core/EventEmitter';

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
            throw new Error('MatrixCharts: WebGL2 is not supported by this browser.');
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
            out vec4 v_color;
            void main() {
                vec2 transformedPosition = ((a_position * u_scale) + u_offset) * u_pixelRatio;
                transformedPosition = floor(transformedPosition) + vec2(0.5);
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
            if (!this.candleVao || !this.candleBuffer) {
                throw new Error('MatrixCharts: Failed to create candlestick GPU resources.');
            }
            gl.bindVertexArray(this.candleVao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.candleBuffer);
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
            if (
                this.candlePositionLocation < 0 ||
                this.candleColorLocation < 0 ||
                !this.candleResolutionLocation ||
                !this.candleOffsetLocation ||
                !this.candleScaleLocation ||
                !this.candlePixelRatioLocation
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


      /** Uploads [x, open, high, low, close, width] candles to the GPU. */
    public drawCandlesticks(
        candles: Float32Array,
        bullishColor: [number, number, number, number],
        bearishColor: [number, number, number, number],
    ): void {
        const gl: WebGL2RenderingContext = this.requireContext();
        if (candles.length % 6 !== 0) {
            throw new Error('MatrixCharts: Candles must contain x/open/high/low/close/width values.');
        }

        const candleCount: number = candles.length / 6;
        const vertexStride: number = 6; // x, y, r, g, b, a
        const scaleX: number = Math.abs(this.currentScale[0]);
        const scaleY: number = Math.abs(this.currentScale[1]);
        if (scaleX === 0 || scaleY === 0) {
            throw new Error('MatrixCharts: Candlestick viewport scales must be non-zero.');
        }
        
        // Wicks = 2 vertices per candle. Bodies = 6 vertices per candle (2 triangles).
        const totalVertices: number = candleCount * 8;
        const vertices: Float32Array = new Float32Array(totalVertices * vertexStride);

        // Partition the array: wicks go at the start, bodies go immediately after all wicks
        let wickIndex: number = 0;
        let bodyIndex: number = candleCount * 2 * vertexStride;

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

            const color: [number, number, number, number] = close >= open ? bullishColor : bearishColor;
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

            const spacingPixels: number = neighborSpacing * scaleX * this.devicePixelRatio;
            const maximumBodyPixels: number = Math.max(1, spacingPixels * 0.78);
            const minimumBodyPixels: number = Math.min(2, maximumBodyPixels);
            const requestedBodyPixels: number = width * scaleX * this.devicePixelRatio;
            const bodyWidthData: number = Math.min(
                maximumBodyPixels,
                Math.max(minimumBodyPixels, requestedBodyPixels),
            ) / (scaleX * this.devicePixelRatio);
            const halfWidth: number = bodyWidthData / 2;

            let bodyTop: number = Math.max(open, close);
            let bodyBottom: number = Math.min(open, close);
            const bodyHeightPixels: number = (bodyTop - bodyBottom) * scaleY * this.devicePixelRatio;
            if (bodyHeightPixels < 1) {
                const halfPixelHeight: number = 0.5 / (scaleY * this.devicePixelRatio);
                const bodyCenter: number = (bodyTop + bodyBottom) / 2;
                bodyTop = bodyCenter + halfPixelHeight;
                bodyBottom = bodyCenter - halfPixelHeight;
            }

            // 1. Write Wick Vertices
            vertices[wickIndex++] = x; vertices[wickIndex++] = low;
            vertices[wickIndex++] = color[0]; vertices[wickIndex++] = color[1]; vertices[wickIndex++] = color[2]; vertices[wickIndex++] = color[3];

            vertices[wickIndex++] = x; vertices[wickIndex++] = high;
            vertices[wickIndex++] = color[0]; vertices[wickIndex++] = color[1]; vertices[wickIndex++] = color[2]; vertices[wickIndex++] = color[3];

            // 2. Write Body Vertices (Triangle 1)
            vertices[bodyIndex++] = x - halfWidth; vertices[bodyIndex++] = bodyBottom;
            vertices[bodyIndex++] = color[0]; vertices[bodyIndex++] = color[1]; vertices[bodyIndex++] = color[2]; vertices[bodyIndex++] = color[3];

            vertices[bodyIndex++] = x + halfWidth; vertices[bodyIndex++] = bodyBottom;
            vertices[bodyIndex++] = color[0]; vertices[bodyIndex++] = color[1]; vertices[bodyIndex++] = color[2]; vertices[bodyIndex++] = color[3];

            vertices[bodyIndex++] = x + halfWidth; vertices[bodyIndex++] = bodyTop;
            vertices[bodyIndex++] = color[0]; vertices[bodyIndex++] = color[1]; vertices[bodyIndex++] = color[2]; vertices[bodyIndex++] = color[3];

            // 3. Write Body Vertices (Triangle 2)
            vertices[bodyIndex++] = x - halfWidth; vertices[bodyIndex++] = bodyBottom;
            vertices[bodyIndex++] = color[0]; vertices[bodyIndex++] = color[1]; vertices[bodyIndex++] = color[2]; vertices[bodyIndex++] = color[3];

            vertices[bodyIndex++] = x + halfWidth; vertices[bodyIndex++] = bodyTop;
            vertices[bodyIndex++] = color[0]; vertices[bodyIndex++] = color[1]; vertices[bodyIndex++] = color[2]; vertices[bodyIndex++] = color[3];

            vertices[bodyIndex++] = x - halfWidth; vertices[bodyIndex++] = bodyTop;
            vertices[bodyIndex++] = color[0]; vertices[bodyIndex++] = color[1]; vertices[bodyIndex++] = color[2]; vertices[bodyIndex++] = color[3];
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.candleBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
        this.candleWickVertexCount = candleCount * 2;
        this.candleBodyVertexCount = candleCount * 6;
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
            gl.drawArrays(gl.LINES, 0, this.candleWickVertexCount);
            gl.drawArrays(gl.TRIANGLES, this.candleWickVertexCount, this.candleBodyVertexCount);
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