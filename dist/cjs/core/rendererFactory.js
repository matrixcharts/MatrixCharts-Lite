"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setRendererFactory = setRendererFactory;
exports.createRenderer = createRenderer;
const WebGL2Renderer_js_1 = require("../renderers/WebGL2Renderer.js");
const Canvas2DRenderer_js_1 = require("../renderers/Canvas2DRenderer.js");
const defaultFactory = {
    data: () => new WebGL2Renderer_js_1.WebGL2Renderer(),
    // The grid renderer is the one that paints the background and the axes, so it is the
    // `true` of Canvas2DRenderer's flag; the UI overlay is the `false`.
    grid: () => new Canvas2DRenderer_js_1.Canvas2DRenderer(true),
    ui: () => new Canvas2DRenderer_js_1.Canvas2DRenderer(false),
};
let override = null;
/**
 * Installs a replacement factory, or restores the real one with `null`.
 *
 * Returns a disposer so a caller cannot leak an override by forgetting a `finally`.
 */
function setRendererFactory(factory) {
    const previous = override;
    override = factory;
    return () => {
        override = previous;
    };
}
function createRenderer(role) {
    return (override ?? defaultFactory)[role]();
}
