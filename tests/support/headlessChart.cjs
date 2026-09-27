// tests/support/headlessChart.cjs
//
// Builds a real `Chart` in node: no WebGL, no browser, no canvas.
//
// Two things stand in for the browser. The first is a DOM small enough to read in one
// sitting — `Chart` touches about fifteen globals, listed in `installDom` below, and
// nothing else. The second is a pair of renderer doubles, installed through the
// `rendererFactory` seam, which record the calls `Chart` makes instead of drawing.
//
// The doubles are fakes rather than mocks: they implement the real interfaces, so the
// compiler holds both them and `WebGL2Renderer` to the same shape. That is the point of
// the seam. A loose double typed to its own shape would keep passing after the real
// interface grew a method, which is the way a test seam turns into a way of not testing.
//
// The data double records the vertical transform it is handed. This codebase has shipped
// two defects where the model's price range and the transform given to the renderer
// disagreed — `getPriceRange` reporting -56732 for a 106-to-111 pane, and
// `setPriceRange` updating the model without ever broadcasting a frame — and neither was
// visible to any test that only read the public getters. `assertTransformMatchesModel`
// is the assertion that would have caught both.

const { createRequire } = require('node:module');
const requireFromSupport = createRequire(__filename);
const { setRendererFactory } = requireFromSupport('../../.test-build/core/rendererFactory.js');

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 600;

/** Every DOM global `Chart` reaches for, in one list so a leak is a visible omission. */
function installDom({ width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT } = {}) {
    const saved = {
        document: globalThis.document,
        window: globalThis.window,
        HTMLElement: globalThis.HTMLElement,
        ResizeObserver: globalThis.ResizeObserver,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
    };

    const style = () => ({});

    class StubElement {
        constructor(tagName) {
            this.tagName = String(tagName).toUpperCase();
            this.style = style();
            this.children = [];
            this.width = width;
            this.height = height;
            this.listeners = new Map();
            // Pointer capture is best-effort in the real chart and wrapped in try/catch;
            // the stub simply has no capture, which exercises that same path.
            this.captured = [];
        }

        appendChild(child) {
            this.children.push(child);
            child.parentElement = this;
            return child;
        }

        /** Detaches from the parent, as `Element.remove` does. `destroy()` calls it. */
        remove() {
            const parent = this.parentElement;
            if (!parent) return;
            const at = parent.children.indexOf(this);
            if (at >= 0) parent.children.splice(at, 1);
            this.parentElement = null;
        }

        addEventListener(type, handler) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(handler);
        }

        removeEventListener(type, handler) {
            this.listeners.get(type)?.delete(handler);
        }

        setPointerCapture(id) {
            this.captured.push(id);
        }

        /**
         * `syncRendererSize` reads `clientWidth`/`clientHeight`, not
         * `getBoundingClientRect`. A stub with only the rect method leaves these
         * `undefined`, the size check is skipped, and the chart silently falls back to
         * its 800x500 default — which then makes every pane calculation in a test wrong
         * by a hundred pixels. Worth having both.
         */
        get clientWidth() {
            return this.width;
        }

        get clientHeight() {
            return this.height;
        }

        getBoundingClientRect() {
            return {
                x: 0, y: 0, left: 0, top: 0,
                width: this.width, height: this.height,
                right: this.width, bottom: this.height,
            };
        }

        /** Dispatches straight to the registered handlers; enough for the chart's own use. */
        dispatch(type, event = {}) {
            for (const handler of this.listeners.get(type) ?? []) handler(event);
        }
    }

    class StubCanvasElement extends StubElement {
        constructor() {
            super('canvas');
            this.width = width;
            this.height = height;
            this.contexts = new Map();
        }

        getContext(kind) {
            if (kind === 'webgl2') {
                // The stub renderers never ask for a context. Returning null here is what
                // a browser without WebGL2 does, and the real renderers' fail-fast is
                // covered by its own test rather than being re-proved here.
                return null;
            }
            if (kind === '2d') {
                // A 2D context is not needed either: the UI layer is a double. Handing
                // back a no-op keeps `createLayer` honest about the shape it expects.
                return {
                    canvas: this,
                    save() {}, restore() {}, clearRect() {}, fillRect() {},
                    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
                    stroke() {}, fill() {}, fillText() {}, measureText: () => ({ width: 0 }),
                    setTransform() {}, translate() {}, scale() {}, drawImage() {},
                    createLinearGradient: () => ({ addColorStop() {} }),
                    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
                    set font(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
                    set globalAlpha(_v) {},
                };
            }
            return null;
        }
    }

    class StubHTMLElement extends StubElement {}

    const documentListeners = new Map();
    const documentStub = {
        visibilityState: 'visible',
        createElement(tagName) {
            return String(tagName).toLowerCase() === 'canvas'
                ? new StubCanvasElement()
                : new StubHTMLElement(tagName);
        },
        getElementById() {
            return null;
        },
        addEventListener(type, handler) {
            if (!documentListeners.has(type)) documentListeners.set(type, new Set());
            documentListeners.get(type).add(handler);
        },
        removeEventListener(type, handler) {
            documentListeners.get(type)?.delete(handler);
        },
    };

    // Frames are run on demand rather than on a timer. `flushFrames` drains them, so a
    // test that needs the scheduled viewport update to have happened says so, and a test
    // that does not is not at the mercy of a timer.
    let pending = [];
    let nextFrameId = 1;

    class StubResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.observed = [];
        }

        observe(element) {
            this.observed.push(element);
        }

        disconnect() {
            this.observed = [];
        }
    }

    globalThis.HTMLElement = StubHTMLElement;
    globalThis.document = documentStub;
    globalThis.window = { devicePixelRatio: 1 };
    globalThis.ResizeObserver = StubResizeObserver;
    globalThis.requestAnimationFrame = (callback) => {
        const id = nextFrameId++;
        pending.push({ id, callback });
        return id;
    };
    globalThis.cancelAnimationFrame = (id) => {
        pending = pending.filter((frame) => frame.id !== id);
    };

    return {
        document: documentStub,
        container: new StubHTMLElement('div'),
        width,
        height,
        /** Runs every queued animation frame callback, including ones they queue. */
        flushFrames() {
            let guard = 0;
            while (pending.length > 0 && guard < 50) {
                const batch = pending;
                pending = [];
                for (const frame of batch) frame.callback();
                guard += 1;
            }
        },
        pendingFrames: () => pending.length,
        dispose() {
            globalThis.document = saved.document;
            globalThis.window = saved.window;
            globalThis.HTMLElement = saved.HTMLElement;
            globalThis.ResizeObserver = saved.ResizeObserver;
            globalThis.requestAnimationFrame = saved.requestAnimationFrame;
            globalThis.cancelAnimationFrame = saved.cancelAnimationFrame;
        },
    };
}

/** Records lifecycle only. This is the whole of what the grid and UI layers are asked. */
function makeStubRenderer(name, log) {
    return {
        name,
        init(canvas, emitter) {
            log.push([name, 'init', { canvas: canvas.tagName, emitter: typeof emitter }]);
            // The grid layer is what draws the crosshair, so the stub stands in for it
            // here. Recording the payload is how a test can assert what the crosshair
            // *reads* — `pane` and `value` are the only channel the renderer has, and
            // reading pixels back out of a canvas in node is not an option.
            if (name === 'grid') {
                emitter.on('crosshair', (payload) => {
                    this.crosshair.push({
                        x: payload.x, y: payload.y, pane: payload.pane, value: payload.value,
                    });
                });
            }
        },
        crosshair: [],
        resize(width, height, dpr) {
            log.push([name, 'resize', { width, height, dpr }]);
        },
        clear() {
            log.push([name, 'clear']);
        },
        render() {
            log.push([name, 'render']);
        },
        destroy() {
            log.push([name, 'destroy']);
        },
    };
}

/**
 * The data-layer double.
 *
 * It records every draw call with its arguments, and separately keeps the last vertical
 * transform it was handed so a test can compare it against the model. A real renderer
 * would consume that transform; here it is the assertion surface.
 */
function makeStubDataRenderer(log) {
    return {
        name: 'data',
        /** The last `scaleY`/`offsetY` this layer was handed, as the real one receives it. */
        lastVertical: null,
        lastHistogramTransform: null,
        calls: [],
        init(canvas, emitter) {
            log.push(['data', 'init', { canvas: canvas.tagName, emitter: typeof emitter }]);
            // The real renderer learns its transform from the 'viewport' broadcast and
            // from nowhere else — which is exactly why `setPriceRange` going unbroadcast
            // left the screen stale while every getter agreed with the model. Recording
            // it here is the assertion that defect was invisible to.
            emitter.on('viewport', (payload) => {
                this.lastVertical = { scaleY: payload.scaleY, offsetY: payload.offsetY };
                this.lastPlot = payload.plot;
                this.lastPanes = payload.panes;
            });
        },
        resize(width, height, dpr) {
            log.push(['data', 'resize', { width, height, dpr }]);
        },
        clear() {
            log.push(['data', 'clear']);
        },
        render() {
            log.push(['data', 'render']);
        },
        destroy() {
            log.push(['data', 'destroy']);
        },
        drawCandlesticks(candles, spec) {
            this.calls.push(['drawCandlesticks', candles.length, spec.style]);
            // The records, not just their count. Where each bar was placed is the whole
            // assertion surface for anything horizontal, and a length says nothing about
            // it. The renderer is handed a reused buffer, so a test reads this before the
            // next frame rather than holding on to it.
            this.lastCandles = candles;
        },
        clearCandlesticks() {
            this.calls.push(['clearCandlesticks']);
        },
        retainOverlays(activeIds) {
            this.calls.push(['retainOverlays', [...activeIds].join(',')]);
        },
        drawOverlay(id, points, stride, color, vertical, pane) {
            this.calls.push(['drawOverlay', id, points.length, stride, pane]);
            // Same reasoning as `lastCandles`: an overlay is read against the candles
            // beneath it, so a test comparing the two needs both sets of coordinates.
            this.overlays = this.overlays ?? {};
            this.overlays[id] = { points, stride };
            if (vertical) this.lastVertical = vertical;
        },
        drawLine(points) {
            this.calls.push(['drawLine', points.length]);
        },
        clearLine() {
            this.calls.push(['clearLine']);
        },
        drawArea(points) {
            this.calls.push(['drawArea', points.length]);
        },
        clearArea() {
            this.calls.push(['clearArea']);
        },
        drawHistogram(levels, colors, scaleY, offsetY) {
            this.calls.push(['drawHistogram', levels.length]);
            this.lastHistogramTransform = { scaleY, offsetY };
        },
        clearHistogram() {
            this.calls.push(['clearHistogram']);
        },
    };
}

/**
 * A `Chart` in node, with the DOM and the renderers both stood in for.
 *
 * `rendererLog` and `dataRenderer` are handed back so a test can assert on what the
 * chart asked for. Everything is torn down in the returned `dispose`, including the
 * factory override, which is why the override is scoped rather than global-and-forgotten.
 */
function createHeadlessChart(options = {}) {
    const { data: _ignored, ...chartOptions } = options;
    const dom = installDom(options.dom);
    const rendererLog = [];
    const dataRenderer = makeStubDataRenderer(rendererLog);
    // The grid stub is kept so a test can read what the crosshair was told.
    const gridRenderer = makeStubRenderer('grid', rendererLog);
    const restoreFactory = setRendererFactory({
        data: () => dataRenderer,
        grid: () => gridRenderer,
        ui: () => makeStubRenderer('ui', rendererLog),
    });
    let chart = null;
    try {
        const { Chart } = requireFromSupport('../../.test-build/core/Chart.js');
        chart = new Chart(dom.container, chartOptions);
    } catch (error) {
        restoreFactory();
        dom.dispose();
        throw error;
    }

    return {
        chart,
        dom,
        dataRenderer,
        gridRenderer,
        rendererLog,
        /** The chart's own wrapper element — the single input surface. */
        wrapper: dom.container.children[0],
        /**
         * Dispatches a pointer event at the chart.
         *
         * The chart listens for `pointerdown`/`pointermove`/`pointerup` on its wrapper,
         * so a real `PointerEvent` is not needed — only the fields the handlers read.
         * That is what makes the gestures testable here rather than in the browser: the
         * hit-test, the slop gate and the drag arithmetic are all reachable without a
         * compositor.
         */
        pointer(type, x, y, { id = 1, button = 0, pointerType = 'mouse' } = {}) {
            dom.container.children[0].dispatch(type, {
                pointerId: id, clientX: x, clientY: y, button, pointerType,
                preventDefault() {},
            });
        },
        /** A press, a move, and a release, as one gesture. */
        drag(fromX, fromY, toX, toY, options) {
            this.pointer('pointerdown', fromX, fromY, options);
            this.pointer('pointermove', toX, toY, options);
            this.pointer('pointerup', toX, toY, options);
        },
        /** Drains queued animation frames, for the paths that schedule a viewport update. */
        flush() {
            dom.flushFrames();
        },
        dispose() {
            try {
                chart?.destroy();
            } finally {
                restoreFactory();
                dom.dispose();
            }
        },
    };
}

/** `n` candles with a flat, predictable body, for geometry that must not depend on data. */
function flatCandles(count, { start = 100, step = 0, minute = 60_000, from = 1_700_000_000_000 } = {}) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const close = start + i * step;
        out.push({
            time: from + i * minute,
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 100,
        });
    }
    return out;
}

module.exports = {
    createHeadlessChart,
    flatCandles,
    installDom,
    makeStubDataRenderer,
    makeStubRenderer,
};
