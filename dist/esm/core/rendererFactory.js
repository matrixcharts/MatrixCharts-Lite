import { WebGL2Renderer } from '../renderers/WebGL2Renderer.js';
import { Canvas2DRenderer } from '../renderers/Canvas2DRenderer.js';
const defaultFactory = {
    data: () => new WebGL2Renderer(),
    // The grid renderer is the one that paints the background and the axes, so it is the
    // `true` of Canvas2DRenderer's flag; the UI overlay is the `false`.
    grid: () => new Canvas2DRenderer(true),
    ui: () => new Canvas2DRenderer(false),
};
let override = null;
/**
 * Installs a replacement factory, or restores the real one with `null`.
 *
 * Returns a disposer so a caller cannot leak an override by forgetting a `finally`.
 */
export function setRendererFactory(factory) {
    const previous = override;
    override = factory;
    return () => {
        override = previous;
    };
}
export function createRenderer(role) {
    return (override ?? defaultFactory)[role]();
}
