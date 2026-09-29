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
export class WebGLSeries {
    /**
     * Which pane this series is drawn in, and therefore which rect clips it.
     *
     * A series in a pane below the price one has to be confined to that pane: its
     * values run on a different vertical scale, so unclipped geometry would
     * overshoot the pane and paint over the one above it.
     */
    get pane() {
        return this.currentPane;
    }
    set pane(index) {
        this.currentPane = index;
    }
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
    constructor(gl, program, positionLocation, colorLocation, label) {
        this.passes = [];
        this.vertical = null;
        this.currentPane = 0;
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
    bind() {
        this.gl.bindVertexArray(this.vertexArray);
    }
    /** Replaces this series' geometry. `indices` may be null for a non-indexed series. */
    upload(vertices, indices) {
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
    setPasses(passes) {
        this.passes = passes;
    }
    /**
     * Replaces the shared vertical transform for this series only. Pass `null` to
     * go back to sharing the viewport's price scale.
     */
    setVerticalTransform(transform) {
        this.vertical = transform;
    }
    get isEmpty() {
        return this.passes.every((pass) => pass.count <= 0);
    }
    /** Issues every pass, skipping the ones with nothing to draw. */
    draw(uniforms, resolutionLocation, offsetLocation, scaleLocation, pixelRatioLocation, snapOffsetLocation) {
        if (this.isEmpty)
            return;
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.uniform2f(resolutionLocation, uniforms.resolutionX, uniforms.resolutionY);
        gl.uniform2f(offsetLocation, uniforms.offsetX, this.vertical === null ? uniforms.offsetY : this.vertical.offsetY);
        gl.uniform2f(scaleLocation, uniforms.scaleX, this.vertical === null ? uniforms.scaleY : this.vertical.scaleY);
        gl.uniform1f(pixelRatioLocation, uniforms.pixelRatio);
        this.bind();
        for (const pass of this.passes) {
            if (pass.count <= 0)
                continue;
            gl.uniform1f(snapOffsetLocation, pass.snapOffset);
            if (pass.indexed) {
                gl.drawElements(pass.primitive, pass.count, gl.UNSIGNED_INT, pass.first * 4);
            }
            else {
                gl.drawArrays(pass.primitive, pass.first, pass.count);
            }
        }
        gl.bindVertexArray(null);
    }
    destroy() {
        const gl = this.gl;
        gl.deleteBuffer(this.vertexBuffer);
        gl.deleteBuffer(this.indexBuffer);
        gl.deleteVertexArray(this.vertexArray);
        this.passes = [];
    }
    get name() {
        return this.label;
    }
}
