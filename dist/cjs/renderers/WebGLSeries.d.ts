/**
 * Interleaved `[x, y, r, g, b, a]` — the one vertex layout every series uses, in
 * data coordinates with per-vertex colour.
 *
 * Two floats of position, four of colour. The same six floats also describe an
 * OHLC source record, and the two are unrelated: this one is what reaches the
 * GPU, that one is what the pyramid stores. Conflating them is how a read ends
 * up six times past the end of a buffer.
 */
export declare const VERTEX_STRIDE = 6;
/** Bytes per vertex, for `vertexAttribPointer`. */
export declare const VERTEX_STRIDE_BYTES: number;
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
export declare class WebGLSeries {
    private gl;
    private program;
    private label;
    private vertexArray;
    private vertexBuffer;
    private indexBuffer;
    private passes;
    private vertical;
    private currentPane;
    /**
     * Which pane this series is drawn in, and therefore which rect clips it.
     *
     * A series in a pane below the price one has to be confined to that pane: its
     * values run on a different vertical scale, so unclipped geometry would
     * overshoot the pane and paint over the one above it.
     */
    get pane(): number;
    set pane(index: number);
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
    constructor(gl: WebGL2RenderingContext, program: WebGLProgram, positionLocation: number, colorLocation: number, label: string);
    /**
     * Makes this series' vertex array current. Everything else it needs — the
     * attribute pointers and the element buffer binding — lives in the vertex
     * array's own state, so another series binding its array does not disturb
     * this one and nothing has to be re-stated per frame.
     */
    bind(): void;
    /** Replaces this series' geometry. `indices` may be null for a non-indexed series. */
    upload(vertices: Float32Array, indices: Uint32Array | null): void;
    setPasses(passes: SeriesPass[]): void;
    /**
     * Replaces the shared vertical transform for this series only. Pass `null` to
     * go back to sharing the viewport's price scale.
     */
    setVerticalTransform(transform: VerticalTransform | null): void;
    get isEmpty(): boolean;
    /** Issues every pass, skipping the ones with nothing to draw. */
    draw(uniforms: SeriesUniforms, resolutionLocation: WebGLUniformLocation, offsetLocation: WebGLUniformLocation, scaleLocation: WebGLUniformLocation, pixelRatioLocation: WebGLUniformLocation, snapOffsetLocation: WebGLUniformLocation): void;
    destroy(): void;
    get name(): string;
}
