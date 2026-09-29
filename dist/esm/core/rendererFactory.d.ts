import type { IRenderer, IOverlayHost } from './IRenderer.js';
import type { IDataRenderer } from './IDataRenderer.js';
export interface RendererFactory {
    data(): IDataRenderer;
    grid(): IRenderer;
    ui(): IRenderer;
}
/**
 * Installs a replacement factory, or restores the real one with `null`.
 *
 * Returns a disposer so a caller cannot leak an override by forgetting a `finally`.
 */
export declare function setRendererFactory(factory: RendererFactory | null): () => void;
/**
 * Constructs one layer's renderer, uninitialised, through whichever factory is installed.
 *
 * Overloaded on the role because the data layer's type is genuinely narrower: asking for
 * `'data'` yields an `IDataRenderer` and asking for `'grid'` yields an `IRenderer`, with
 * the check made by the compiler on both sides. A single callback returning `IRenderer`
 * would force a cast at the one call site that needs the wider type, and a cast there is
 * a hole exactly the size of the bug this seam exists to catch.
 */
export declare function createRenderer(role: 'data'): IDataRenderer;
export declare function createRenderer(role: 'ui'): IRenderer & IOverlayHost;
export declare function createRenderer(role: 'grid'): IRenderer;
//# sourceMappingURL=rendererFactory.d.ts.map