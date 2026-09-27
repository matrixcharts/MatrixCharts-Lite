// src/core/rendererFactory.ts
//
// The seam that lets a Chart be built and driven with no GPU and no real DOM.
//
// Internal by construction: the barrel is an explicit allow-list, so nothing here is
// reachable by an integrator, and `Chart`'s public constructor signature is untouched.
// A third constructor parameter was the alternative and it is worse twice over. It would
// have to be typed against an unexported interface, putting that interface into the
// shipped `Chart.d.ts` and widening exactly the surface the packaging suite exists to
// guard. And `stripInternal` cannot rescue it: that flag removes whole declarations, so
// annotating one parameter would delete the entire constructor signature from the .d.ts.
//
// The override is module state, which is the cost of keeping it off the public API. It is
// scoped by restoring `null` in a `finally`, and `setRendererFactory` returns a disposer
// so a caller cannot leak one by forgetting. It is deliberately not reentrant — nesting
// two overrides restores the outer one rather than the original — which is why the test
// helpers do not nest.
//
// The factory is an object of three methods rather than one callback tagged with a role
// string, because the data layer's return type is genuinely narrower. `createRenderer`
// is overloaded on the role, so asking for `'data'` yields an `IDataRenderer` and asking
// for `'grid'` yields an `IRenderer`, with the check made by the compiler on both sides.
// A single callback returning `IRenderer` would force a cast at the one call site that
// needs the wider type, and a cast there is a hole exactly the size of the bug this seam
// exists to catch.
// The factory constructs and nothing else. It does not call `init`, because `init` is
// lifecycle and lifecycle belongs to Chart: a factory that initialised as a side effect
// would let a test double that forgets to return an initialised renderer look fine until
// the first draw. Keeping construction and initialisation apart means Chart's own call
// site is the one that hands over the canvas and the emitter, and a double that is never
// initialised is visibly never initialised.
import type { IRenderer } from './IRenderer.js';
import type { IDataRenderer } from './IDataRenderer.js';
import { WebGL2Renderer } from '../renderers/WebGL2Renderer.js';
import { Canvas2DRenderer } from '../renderers/Canvas2DRenderer.js';

export interface RendererFactory {
    data(): IDataRenderer;
    grid(): IRenderer;
    ui(): IRenderer;
}

const defaultFactory: RendererFactory = {
    data: () => new WebGL2Renderer(),
    // The grid renderer is the one that paints the background and the axes, so it is the
    // `true` of Canvas2DRenderer's flag; the UI overlay is the `false`.
    grid: () => new Canvas2DRenderer(true),
    ui: () => new Canvas2DRenderer(false),
};

let override: RendererFactory | null = null;

/**
 * Installs a replacement factory, or restores the real one with `null`.
 *
 * Returns a disposer so a caller cannot leak an override by forgetting a `finally`.
 */
export function setRendererFactory(factory: RendererFactory | null): () => void {
    const previous = override;
    override = factory;
    return () => {
        override = previous;
    };
}

/**
 * Constructs one layer's renderer, uninitialised, through whichever factory is installed.
 *
 * Overloaded on the role because the data layer's type is genuinely narrower: asking for
 * `'data'` yields an `IDataRenderer` and asking for `'grid'` yields an `IRenderer`, with
 * the check made by the compiler on both sides. A single callback returning `IRenderer`
 * would force a cast at the one call site that needs the wider type, and a cast there is
 * a hole exactly the size of the bug this seam exists to catch.
 */
export function createRenderer(role: 'data'): IDataRenderer;
export function createRenderer(role: 'grid' | 'ui'): IRenderer;
export function createRenderer(role: 'data' | 'grid' | 'ui'): IRenderer {
    return (override ?? defaultFactory)[role]();
}
