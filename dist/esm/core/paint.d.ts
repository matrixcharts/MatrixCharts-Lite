import type { PlotRect } from './coordinates.js';
import type { DrawingPoint } from './tradingTools.js';
/**
 * Everything a painter is given for one frame.
 *
 * The context is already scaled to CSS pixels and the layer's DPR, so a painter
 * draws in the same units as every other coordinate in this library and needs no
 * DPR arithmetic of its own. A 1px line drawn at an integer here is a 1px line at
 * every device pixel ratio, which is the same guarantee the engine holds itself to.
 */
export interface PaintContext {
    /**
     * The UI layer's 2D context, transformed to CSS pixels.
     *
     * This is the same layer the crosshair is drawn on, and it is cleared to
     * transparent every frame. A painter that wants the crosshair on top of its work
     * already has that: the engine draws the crosshair after the painter returns.
     */
    readonly ctx: CanvasRenderingContext2D;
    /** The region the series occupy, in CSS pixels. */
    readonly plot: PlotRect;
    /** Every pane's rect, index-aligned. `paneRects[0]` is the price pane. */
    readonly paneRects: readonly PlotRect[];
    /** How many panes the chart currently has. */
    readonly paneCount: number;
    /** The layer's size in CSS pixels. */
    readonly width: number;
    /** The height in CSS pixels. */
    readonly height: number;
    /** The device pixel ratio the layer is scaled for. */
    readonly dpr: number;
    /**
     * Projects a data-space point into CSS pixels, or `null` when it has no
     * position on screen — which in practice means the chart has no data.
     *
     * A timestamp inside a session break does **not** give `null`. It projects to
     * the nearer of the two bars bounding the break, because that is what makes a
     * drawing drawn across a weekend behave: its midpoint anchor lands on the last
     * bar before the gap rather than in dead air, so the line stays connected to the
     * candles it annotates. `null` there would draw a line that stops at the edge of
     * the data.
     *
     * An x outside the plot is also not `null`. A trend line wider than the viewport
     * has to be drawn to the edges and clipped by the canvas, not truncated at the
     * first bar.
     *
     * @param point The anchor, in data space.
     * @param pane  Which pane's vertical units the value is in. Defaults to the
     *              price pane, which is also the only one that can be a log scale.
     */
    toScreen(point: DrawingPoint, pane?: number): {
        x: number;
        y: number;
    } | null;
    /**
     * The inverse of `toScreen`.
     *
     * The returned time is a real candle timestamp, snapped to the nearest bar. A
     * painter that needs sub-bar precision should keep the fractional slot from
     * `Chart.coordinateToSlot` alongside it, because an interpolated timestamp is an
     * anchor that resolves to whichever bar is nearest, which changes as the chart
     * is panned.
     *
     * @param x    CSS x.
     * @param y    CSS y.
     * @param pane Which pane's units the y is in. Defaults to the price pane.
     */
    toData(x: number, y: number, pane?: number): DrawingPoint;
}
/**
 * A paint callback. Called once per rendered frame, on the UI layer, before the
 * crosshair is drawn.
 *
 * Called on the UI layer only, so the background and the candles are already on
 * their own layers underneath and do not need repainting to accommodate a painter.
 * A painter that redraws on every frame is the intended cost: the engine has no
 * retained scene to invalidate, so a layer that only changes when its own data
 * changes is the caller's to skip, and a caller that can tell it is unchanged should
 * return early.
 */
export type OverlayPainter = (context: PaintContext) => void;
/**
 * A press, offered to a caller's claim handler before the chart decides what the
 * gesture is.
 *
 * `clientX` and `clientY` are viewport coordinates, the same pair `PaintContext`'s
 * projections and every pointer-driven helper take, so a handler can hit-test a
 * drawing without a `getBoundingClientRect` of its own. The raw `event` is carried for
 * a caller that needs something the summary does not have.
 */
export interface PointerClaim {
    /** CSS x, relative to the viewport. */
    clientX: number;
    /** CSS y, relative to the viewport. */
    clientY: number;
    /** The pointer button, for a press to be claimed only on the primary one. */
    button: number;
    /** `mouse`, `touch`, or `pen`. */
    pointerType: string;
    /** The browser's pointer id, which identifies this press across moves and release. */
    pointerId: number;
    /**
     * Presses already down when this one arrived, **excluding any press this handler has
     * already claimed**.
     *
     * A claimed press is tracked by id rather than in the set a pinch is built from,
     * because a second finger arriving during a claimed drag must not become a pinch
     * underneath the caller's gesture. The consequence is that `pointerCount` does not
     * count a press this handler took: a handler that wants to decline a second finger
     * has to track its own outstanding claim and treat the second press as a second.
     */
    pointerCount: number;
    /** The original event, for anything the summary above does not carry. */
    readonly event: PointerEvent;
}
/**
 * Offered every press before the chart turns it into a pan, a zoom, a pane scale or an
 * order drag. Return `true` to take the press.
 *
 * The handler is asked, it does not decide alone: a `true` claims the press, and a
 * `false` — or a throw — leaves the chart to do exactly what it would have done.
 */
export type PointerClaimHandler = (claim: PointerClaim) => boolean;
//# sourceMappingURL=paint.d.ts.map