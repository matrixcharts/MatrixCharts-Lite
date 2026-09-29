import type { ResolvedVolumeColors } from './options.js';
import type { IRenderer } from './IRenderer.js';
import type { VerticalTransform } from '../renderers/WebGLSeries.js';
import type { CandleRenderSpec, Rgba } from '../renderers/WebGL2Renderer.js';
export interface IDataRenderer extends IRenderer {
    drawCandlesticks(candles: Float32Array, spec: CandleRenderSpec): void;
    clearCandlesticks(): void;
    retainOverlays(activeIds: ReadonlySet<string>): void;
    drawOverlay(id: string, points: Float32Array, stride: 2 | 6, color: Rgba, vertical: VerticalTransform | null, pane?: number): void;
    drawLine(points: Float32Array, color: Rgba): void;
    clearLine(): void;
    drawArea(points: Float32Array, fill: Rgba, basePrice: number): void;
    clearArea(): void;
    drawHistogram(levels: Float32Array, colors: ResolvedVolumeColors, scaleY: number, offsetY: number, pane?: number): void;
    clearHistogram(): void;
}
//# sourceMappingURL=IDataRenderer.d.ts.map