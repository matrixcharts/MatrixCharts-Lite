// Support for testing the real Canvas2D UI layer in node.
//
// The headless chart harness installs renderer *doubles*, which is right for testing
// Chart's model and wrong for testing a renderer: a double cannot exercise the code
// under test, only the assumption that someone else wrote it. The paint seam lives
// inside the real renderer, so it is tested against the real renderer — with a
// recording 2D context standing in for the browser's.
//
// Nothing here interprets what was drawn. It records the calls, so a test can assert
// that a painter ran, in what order relative to the crosshair, and with what
// arguments. Pixels are the browser harness's job.

/** A 2D context that records every method call and returns chainable no-ops. */
function recordingContext(calls) {
    const noop = () => {};
    const chainable = () => new Proxy(noop, {
        get: (target, property) => (property === 'canvas' ? undefined : noop),
        set: () => true,
        apply: () => undefined,
    });
    const context = {
        canvas: null,
        calls,
        // Methods the renderer reads a value from rather than only writes to.
        measureText: (text) => ({ width: String(text).length * 6 }),
        createLinearGradient: () => ({ addColorStop: noop }),
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    };
    // Every other method is recorded then ignored. A Proxy over a plain object so an
    // unknown method is a recorded call rather than a TypeError, which keeps the
    // double honest when the renderer grows a new call.
    return new Proxy(context, {
        get(target, property) {
            if (property in target) return target[property];
            return (...args) => {
                calls.push({ method: property, args });
                return chainable();
            };
        },
        set(target, property, value) {
            target[property] = value;
            return true;
        },
    });
}

/**
 * A canvas stub. `width` and `height` are the backing-store size the renderer sets
 * from `resize`, and `getContext` hands back the recording context.
 */
function recordingCanvas(calls) {
    const ctx = recordingContext(calls);
    return {
        width: 0,
        height: 0,
        tagName: 'CANVAS',
        style: {},
        getContext: (kind) => (kind === '2d' ? ctx : null),
        addEventListener: () => {},
        removeEventListener: () => {},
        ctx,
    };
}

/**
 * Builds a real `Canvas2DRenderer` for the UI layer, wired to a real `EventEmitter`.
 *
 * @param isGridLayer `true` for the background/axis layer, `false` for the UI layer.
 *                  The UI layer is the one that hosts a caller's paint callback.
 * @returns The renderer, the emitter, the recorded calls, and a disposer.
 */
function createUiRenderer(isGridLayer = false) {
    const { Canvas2DRenderer } = requireFromTestBuild('renderers/Canvas2DRenderer.js');
    const { EventEmitter } = requireFromTestBuild('core/EventEmitter.js');
    const calls = [];
    const canvas = recordingCanvas(calls);
    const emitter = new EventEmitter();
    const renderer = new Canvas2DRenderer(isGridLayer);
    renderer.init(canvas, emitter);
    return {
        renderer,
        emitter,
        calls,
        canvas,
        dispose() {
            renderer.destroy();
        },
    };
}

/** Resolves a path relative to the compiled test tree, wherever this file sits. */
function requireFromTestBuild(relative) {
    return require(`${__dirname}/../../.test-build/${relative}`);
}

module.exports = {
    createUiRenderer,
    recordingCanvas,
    recordingContext,
};
