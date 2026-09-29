// src/core/IDataRenderer.ts
//
// The contract Chart holds with the layer that draws the series.
//
// `IRenderer` covers all three layers and is only lifecycle: init, resize, clear,
// render, destroy. That is the whole of what the grid and UI layers are asked for, so
// `IRenderer` is a complete description of them. The data layer is not: Chart hands it
// ten GPU draw calls of its own, and typing the field as `IRenderer` would mean either
// casting at every call site or losing the types altogether.
//
// This is that missing contract, so the seam is strictly typed at both ends. The payoff
// is that a headless test can substitute a recorder — a fake, not a loose mock — and
// then *assert on the calls*, including the vertical transform the data layer was given.
// That last one is the reason this interface is worth having rather than a `destroy()`
// no-op: a chart whose model says one range and whose data layer was handed another is
// precisely the failure this codebase shipped twice, and it is invisible to any test
// that only reads the public getters.
//
// Internal by construction. Nothing here is exported from the barrel, so no integrator
// can name this type; it exists so `WebGL2Renderer` and a test double are held to the
// same shape.
import type { ResolvedVolumeColors } from './options.js';
import type { OverlayType } from './overlays.js';
import type { IRenderer } from './IRenderer.js';
import type { VerticalTransform } from '../renderers/WebGLSeries.js';
import type { CandleRenderSpec, Rgba } from '../renderers/WebGL2Renderer.js';

export interface IDataRenderer extends IRenderer {
    drawCandlesticks(candles: Float32Array, spec: CandleRenderSpec): void;
    clearCandlesticks(): void;

    retainOverlays(activeIds: ReadonlySet<string>): void;
    drawOverlay(
        id: string,
        points: Float32Array,
        stride: 2 | 6,
        color: Rgba,
        vertical: VerticalTransform | null,
        pane?: number,
        type?: OverlayType,
        baseline?: number,
        points2?: Float32Array | null,
        fillColor?: Rgba | null,
    ): void;

    drawLine(points: Float32Array, color: Rgba): void;
    clearLine(): void;

    drawArea(points: Float32Array, fill: Rgba, basePrice: number): void;
    clearArea(): void;

    drawHistogram(
        levels: Float32Array,
        colors: ResolvedVolumeColors,
        scaleY: number,
        offsetY: number,
        pane?: number,
    ): void;
    clearHistogram(): void;
}
