// src/renderers/WebGLSeries.ts
//
// One drawable batch on the WebGL data layer: its own vertex array, vertex
// buffer, and index buffer, plus the draw passes that consume them.
//
// Every series on a layer owns its own buffers. They did not used to: the
// renderer held one vertex buffer, so two series could never both be resident
// and whichever uploaded last won.
//
// The symptom is narrower than "the first series disappears". The candle series
// is re-uploaded on every viewport update, so a shared buffer is re-filled with
// candle geometry before the next draw, and the visible corruption lands on
// whichever series did not upload last: it draws the other series' vertices
// under its own primitive. That is why the regression test looks for the line
// drawing its own colour rather than for the candles going missing.

/**
 * Interleaved `[x, y, r, g, b, a]` — the one vertex layout every series uses, in
 * data coordinates with per-vertex colour.
 *
 * Two floats of position, four of colour. The same six floats also describe an
 * OHLC source record, and the two are unrelated: this one is what reaches the
 * GPU, that one is what the pyramid stores. Conflating them is how a read ends
 * up six times past the end of a buffer.
 */
export const VERTEX_STRIDE = 6;

/** Bytes per vertex, for `vertexAttribPointer`. */
export const VERTEX_STRIDE_BYTES = VERTEX_STRIDE * 4;

/** One draw call within a series. */
export interface SeriesPass {
    /** A `gl` primitive enum: `gl.LINES`, `gl.TRIANGLES`, or `gl.LINE_STRIP`. */
    primitive: number;
    /**
     * Vertices to draw for a non-indexed pass, or indices for an indexed one.
     * Named for what it counts rather than what it is, because conflating the
     * two puts a draw six times past the end of its buffer.
     */
    count: number;
    /**
     * First vertex or index to draw from, so one buffer can back several passes
     * that draw disjoint ranges of it. Zero for the common single-pass series.
     */
    first: number;
    /** Whether `count` indexes the element buffer rather than the vertex buffer. */
    indexed: boolean;
    /**
     * Pixel snapping. `0` puts edges on pixel boundaries, which is what a filled
     * shape needs so its border lands on exactly one pixel. `0.5` snaps to pixel
     * centres, which is what a one-pixel line needs so it does not straddle two.
     */
    snapOffset: number;
}

/** The uniforms every series shares, all in device pixels. */
export interface SeriesUniforms {
    resolutionX: number;
    resolutionY: number;
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
    pixelRatio: number;
}

/**
 * A per-series replacement for the vertical transform.
 *
 * A series that measures something other than price — a volume histogram, and
 * later any indicator with its own scale — cannot use the price scale, or it
 * would have to be scaled to fit the price range. The horizontal transform is
 * always shared, because every series is indexed on the same time axis.
 */
export interface VerticalTransform {
    scaleY: number;
    offsetY: number;
}

export class WebGLSeries {
    private gl: WebGL2RenderingContext;
    private program: WebGLProgram;
    private label: string;
    private vertexArray: WebGLVertexArrayObject;
    private vertexBuffer: WebGLBuffer;
    private indexBuffer: WebGLBuffer;
    private passes: SeriesPass[] = [];
    private vertical: VerticalTransform | null = null;

    /**
     * `program` is shared by every series: they differ in how their vertices are
     * generated and which primitive they draw, not in how a vertex is
     * transformed. One program means one uniform set and one vertex format, so a
     * new series type cannot drift the transform out of step with the others.
     *
     * The attribute pointers are configured here rather than on every bind. They
     * describe a layout that never changes, and the element buffer binding is
     * part of the vertex array's own state, so neither needs re-stating per frame.
     */
    constructor(
        gl: WebGL2RenderingContext,
        program: WebGLProgram,
        positionLocation: number,
        colorLocation: number,
        label: string,
    ) {
        this.gl = gl;
        this.program = program;
        this.label = label;

        const vertexArray = gl.createVertexArray();
        const vertexBuffer = gl.createBuffer();
        const indexBuffer = gl.createBuffer();
        if (!vertexArray || !vertexBuffer || !indexBuffer) {
            throw new Error(`MatrixCharts: Failed to create ${label} GPU buffers.`);
        }
        this.vertexArray = vertexArray;
        this.vertexBuffer = vertexBuffer;
        this.indexBuffer = indexBuffer;

        // The element buffer binding is part of the vertex array state, so it has
        // to be bound while the array object is bound, once, here. Attribute
        // pointers are not set yet: they name locations owned by the program, so
        // they are configured in bind() where the program is known.
        gl.bindVertexArray(this.vertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 0);
        gl.enableVertexAttribArray(colorLocation);
        gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, VERTEX_STRIDE_BYTES, 8);
        gl.bindVertexArray(null);
    }

    /**
     * Makes this series' vertex array current. Everything else it needs — the
     * attribute pointers and the element buffer binding — lives in the vertex
     * array's own state, so another series binding its array does not disturb
     * this one and nothing has to be re-stated per frame.
     */
    public bind(): void {
        this.gl.bindVertexArray(this.vertexArray);
    }

    /** Replaces this series' geometry. `indices` may be null for a non-indexed series. */
    public upload(vertices: Float32Array, indices: Uint32Array | null): void {
        const gl = this.gl;
        gl.bindVertexArray(this.vertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        // Re-allocating rather than sub-uploading orphans the old store, so the
        // driver does not have to stall waiting for it to be consumed.
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
        if (indices !== null) {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
        }
        gl.bindVertexArray(null);
    }

    public setPasses(passes: SeriesPass[]): void {
        this.passes = passes;
    }

    /**
     * Replaces the shared vertical transform for this series only. Pass `null` to
     * go back to sharing the viewport's price scale.
     */
    public setVerticalTransform(transform: VerticalTransform | null): void {
        this.vertical = transform;
    }

    public get isEmpty(): boolean {
        return this.passes.every((pass: SeriesPass): boolean => pass.count <= 0);
    }

    /** Issues every pass, skipping the ones with nothing to draw. */
    public draw(
        uniforms: SeriesUniforms,
        resolutionLocation: WebGLUniformLocation,
        offsetLocation: WebGLUniformLocation,
        scaleLocation: WebGLUniformLocation,
        pixelRatioLocation: WebGLUniformLocation,
        snapOffsetLocation: WebGLUniformLocation,
    ): void {
        if (this.isEmpty) return;
        const gl = this.gl;

        gl.useProgram(this.program);
        gl.uniform2f(resolutionLocation, uniforms.resolutionX, uniforms.resolutionY);
        gl.uniform2f(
            offsetLocation,
            uniforms.offsetX,
            this.vertical === null ? uniforms.offsetY : this.vertical.offsetY,
        );
        gl.uniform2f(
            scaleLocation,
            uniforms.scaleX,
            this.vertical === null ? uniforms.scaleY : this.vertical.scaleY,
        );
        gl.uniform1f(pixelRatioLocation, uniforms.pixelRatio);
        this.bind();

        for (const pass of this.passes) {
            if (pass.count <= 0) continue;
            gl.uniform1f(snapOffsetLocation, pass.snapOffset);
            if (pass.indexed) {
                gl.drawElements(pass.primitive, pass.count, gl.UNSIGNED_INT, pass.first * 4);
            } else {
                gl.drawArrays(pass.primitive, pass.first, pass.count);
            }
        }
        gl.bindVertexArray(null);
    }

    public destroy(): void {
        const gl = this.gl;
        gl.deleteBuffer(this.vertexBuffer);
        gl.deleteBuffer(this.indexBuffer);
        gl.deleteVertexArray(this.vertexArray);
        this.passes = [];
    }

    public get name(): string {
        return this.label;
    }
}
