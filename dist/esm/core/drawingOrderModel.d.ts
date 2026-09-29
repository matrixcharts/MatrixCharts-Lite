import type { DrawingPoint, OrderSide, OrderStatus } from './tradingTools.js';
/**
 * A drag handle on a drawing. Handles are the interactive control points
 * that let a user resize or reposition a drawing.
 */
export interface DragHandle {
    /** Which part of the drawing this handle controls. */
    role: 'move' | 'resize-start' | 'resize-end' | 'resize-top' | 'resize-bottom';
    /**
     * Which instance of a repeated role this is.
     *
     * A role is not a unique identifier. A fib retracement has seven level
     * handles, every one of them `resize-bottom`, because the union has no name
     * for "the 0.618 level" — so a handle hit could not be turned back into a
     * specific thing to drag. This is that thing: the ordinal of the level within
     * the drawing's own point array, absent for a handle that is not one of a set.
     */
    index?: number;
    /** Current position in data coordinates. */
    time: number;
    value: number;
    /** Visual size in CSS pixels. */
    size: number;
    /** Cursor style to show when hovering this handle. */
    cursor: string;
}
/**
 * A drawing that can be edited via drag handles.
 */
export interface EditableDrawing {
    id: string;
    type: 'trend-line' | 'horizontal-line' | 'rectangle' | 'fib-retracement';
    points: DrawingPoint[];
    color: string;
    lineWidth: number;
    lineStyle: 'solid' | 'dashed';
    /** Whether the drawing is currently being dragged. */
    active: boolean;
    /** Whether the drawing is selected (shows handles). */
    selected: boolean;
    /** Label drawn near the drawing. */
    label: string;
    /** Fill color for rectangle-type drawings. */
    fillColor?: string;
    /** Opacity 0-1. */
    opacity: number;
}
/**
 * State of a drag operation in progress.
 */
export interface DragState {
    /** What is being dragged. */
    target: 'drawing' | 'order' | 'handle' | 'create';
    /** ID of the drawing or order being dragged. */
    id: string;
    /** For handle drags, which handle. */
    handleRole?: DragHandle['role'];
    /** Original position at drag start. */
    startPoint: DrawingPoint;
    /** Current pointer position. */
    currentPoint: DrawingPoint;
    /** For create operations, the starting point. */
    createStart?: DrawingPoint;
}
/**
 * Whether a status transition is valid.
 */
export declare function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean;
/**
 * Attempts to transition an order to a new status.
 *
 * @returns true if the transition was valid and applied.
 */
export declare function transitionOrder(order: {
    status: OrderStatus;
}, to: OrderStatus): boolean;
/**
 * Base event for all drawing/order interactions.
 */
export interface InteractionEvent {
    /** Timestamp of the event. */
    time: number;
    /** ID of the drawing or order involved. */
    id: string;
}
/**
 * Emitted when a drawing is selected or deselected.
 */
export interface DrawingSelectionEvent extends InteractionEvent {
    type: 'drawing-select' | 'drawing-deselect';
    drawing: EditableDrawing;
}
/**
 * Emitted when a drawing is moved (dragged to a new position).
 */
export interface DrawingMoveEvent extends InteractionEvent {
    type: 'drawing-move';
    drawing: EditableDrawing;
    from: DrawingPoint;
    to: DrawingPoint;
}
/**
 * Emitted when a drawing is resized via a handle.
 */
export interface DrawingResizeEvent extends InteractionEvent {
    type: 'drawing-resize';
    drawing: EditableDrawing;
    handleRole: DragHandle['role'];
    points: DrawingPoint[];
}
/**
 * Emitted when a drawing is created.
 */
export interface DrawingCreateEvent extends InteractionEvent {
    type: 'drawing-create';
    drawing: EditableDrawing;
}
/**
 * Emitted when a drawing is deleted.
 */
export interface DrawingDeleteEvent extends InteractionEvent {
    type: 'drawing-delete';
    id: string;
}
/**
 * Emitted when an order's price is dragged.
 */
export interface OrderPriceEvent extends InteractionEvent {
    type: 'order-price-change';
    id: string;
    side: OrderSide;
    fromPrice: number;
    toPrice: number;
    status: OrderStatus;
}
/**
 * Emitted when an order's status changes.
 */
export interface OrderStatusEvent extends InteractionEvent {
    type: 'order-status-change';
    id: string;
    side: OrderSide;
    fromStatus: OrderStatus;
    toStatus: OrderStatus;
    price: number;
    quantity: number;
}
/**
 * Emitted when an order is created from a drawing.
 */
export interface OrderCreateEvent extends InteractionEvent {
    type: 'order-create';
    id: string;
    side: OrderSide;
    price: number;
    quantity: number;
    status: OrderStatus;
}
/**
 * All interaction event types.
 */
export type DrawingOrderEvent = DrawingSelectionEvent | DrawingMoveEvent | DrawingResizeEvent | DrawingCreateEvent | DrawingDeleteEvent | OrderPriceEvent | OrderStatusEvent | OrderCreateEvent;
/**
 * Result of a hit test against drawings and orders.
 */
export interface DrawingOrderHitResult {
    kind: 'drawing' | 'order' | 'handle' | 'create-handle';
    id: string;
    /** For handle hits, which handle was hit. */
    handleRole?: DragHandle['role'];
    /** For handle hits, `DragHandle.index` — which of a repeated role. */
    handleIndex?: number;
    /** Distance from the pointer to the target, in CSS pixels. */
    distance: number;
    /** The point that was hit, in data coordinates. */
    point: DrawingPoint;
}
/**
 * A projection from data space to screen space.
 *
 * `null` means "this point has no place on screen". The case that produces it in
 * practice is a chart with no data at all: a timestamp cannot name a bar that does
 * not exist.
 *
 * It is worth being explicit about what does *not* produce `null`, because the
 * intuitive answer is wrong. A timestamp inside a session break projects to the
 * nearer of the two bars bounding it, not to `null`. That is deliberate and it is
 * the right answer. A horizontal line's move handle is the mean of its two
 * endpoints, and a line drawn from Friday to Monday has a midpoint that lands in the
 * dead air between them; snapping to the nearer bar keeps that handle on the line the
 * user drew, where `null` would drop it and leave a line that cannot be moved.
 *
 * Declaring the return non-nullable instead would be a lie the compiler cannot
 * check, because the coordinate maths lives in the caller. Every consumer below
 * skips a `null` projection rather than dereferencing it, which also keeps the
 * function safe against a caller whose own transform answers `null` for a time it
 * cannot place.
 */
export type DrawPointProjector = (point: DrawingPoint) => {
    x: number;
    y: number;
} | null;
/**
 * Validates a drawing set on the way in.
 *
 * Every other bulk-ingest path in this library validates before it mutates —
 * `resolveZones`, `resolvePriceLines`, `resolveOverlays`, `setOrders` all reject
 * duplicate ids and non-finite numbers, and a refused call leaves the previous set
 * untouched. `setDrawings` was the one hole: it cloned whatever it was handed.
 *
 * A drawing that is not rejected here is not caught anywhere later. A NaN anchor
 * projects to NaN, so it fails every bounds check and every hit test silently
 * rather than visibly; a duplicate id makes `selectDrawing` and `deleteDrawing`
 * act on the first match and leave the second stranded; a one-point trend line is
 * accepted by the type and then renders as a zero-length segment.
 *
 * @returns Cloned drawings, safe to own.
 * @throws  On a duplicate id, a non-finite anchor, or a shape the type cannot draw.
 */
export declare function validateDrawings(drawings: readonly EditableDrawing[]): EditableDrawing[];
/** Every drawing type the model knows how to describe. */
export declare const DRAWING_TYPES: readonly EditableDrawing['type'][];
/**
 * Hit tests a point against all drawings and orders.
 *
 * Priority order, highest first:
 *  1. Drag handles
 *  2. Orders (price lines)
 *  3. Drawing bodies
 *
 * The order is honoured as *precedence*, not as a preference. The three passes
 * below each kept the best candidate by distance alone, and pass three ran last
 * with that same rule — so a rectangle body 1px from the pointer could displace a
 * handle 7px away, and the documented priority was inverted for exactly the case it
 * exists to resolve. Each pass now compares rank first and distance second.
 *
 * @param x         CSS x coordinate.
 * @param y         CSS y coordinate.
 * @param drawings  All drawings to test.
 * @param orders    All orders to test.
 * @param toScreen  Projects a data point to the screen, or null if it has none.
 * @param toData    Projects a screen point back to data coordinates.
 * @param tolerance Hit tolerance in CSS pixels.
 * @returns The closest hit, or null.
 */
export declare function hitTestDrawings(x: number, y: number, drawings: readonly EditableDrawing[], orders: readonly {
    id: string;
    price: number;
    status: OrderStatus;
}[], toScreen: DrawPointProjector, toData: (x: number, y: number) => DrawingPoint, tolerance?: number): DrawingOrderHitResult | null;
/**
 * Gets the drag handles for a drawing.
 */
export declare function getDrawingHandles(drawing: EditableDrawing): DragHandle[];
/**
 * Creates a new drawing from a pointer drag gesture.
 *
 * @param type      Drawing type.
 * @param start     Where the gesture began, in data coordinates.
 * @param end       Where it ended, in data coordinates.
 * @param id        Id for the new drawing.
 * @param color     Stroke colour.
 * @param timeSnap  Optional alignment for generated timestamps.
 *
 * `timeSnap` exists for the fib levels, and the reason is specific. A fib's seven
 * levels used to be interpolated linearly in wall-clock time between the two
 * gesture endpoints. The chart's x axis is *not* wall-clock — it is candle
 * ordinals, with closed intervals compressed out — so a linear time split does not
 * land on evenly spaced bars. Across a session break, the 0.5 level lands in dead
 * air with no candle behind it. At a coarser aggregation the levels land between
 * buckets. Five of the seven would be anchored to nothing, and the fib would lean
 * off the structure it was drawn against.
 *
 * Supplying the chart's time-to-index mapping here puts the levels on the candle
 * grid. It is a parameter rather than a hard dependency because this module is
 * renderer-agnostic and knows nothing about candles; a caller without a grid to
 * align to still gets a well-formed drawing, interpolated in time.
 */
export declare function createDrawingFromGesture(type: EditableDrawing['type'], start: DrawingPoint, end: DrawingPoint, id: string, color?: string, timeSnap?: (time: number) => number): EditableDrawing;
/**
 * Creates an order from a drawing.
 *
 * A horizontal line or the endpoint of a trend line can be converted to an order.
 */
export declare function createOrderFromDrawing(drawing: EditableDrawing, side: OrderSide, id: string, quantity?: number): {
    id: string;
    side: OrderSide;
    price: number;
    quantity: number;
    status: OrderStatus;
} | null;
//# sourceMappingURL=drawingOrderModel.d.ts.map