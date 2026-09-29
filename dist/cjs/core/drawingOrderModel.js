"use strict";
// src/core/drawingOrderModel.ts
//
// Complete editable drawing and order interaction model.
//
// This module provides the full interaction layer for drawings and orders:
// - Drag handles for resizing and repositioning drawings
// - Order state machine with transitions
// - Event contracts for all interactions
// - Hit testing with priority ordering
// - Drawing creation from pointer gestures
//
// The model is designed to be renderer-agnostic: it tracks geometry in data
// coordinates (slots and prices) and emits events that any renderer can
// consume. The Canvas2D and WebGL renderers draw the current state; this
// module manages the state.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DRAWING_TYPES = void 0;
exports.canTransitionOrder = canTransitionOrder;
exports.transitionOrder = transitionOrder;
exports.validateDrawings = validateDrawings;
exports.hitTestDrawings = hitTestDrawings;
exports.getDrawingHandles = getDrawingHandles;
exports.createDrawingFromGesture = createDrawingFromGesture;
exports.createOrderFromDrawing = createOrderFromDrawing;
// --- order state machine -----------------------------------------------------
/**
 * Valid order status transitions.
 *
 * A working order can be filled, cancelled, or rejected.
 * A filled order is terminal.
 * A cancelled order is terminal.
 * A rejected order is terminal.
 */
const ORDER_TRANSITIONS = {
    working: ['filled', 'cancelled', 'rejected'],
    filled: [],
    cancelled: [],
    rejected: [],
};
/**
 * Whether a status transition is valid.
 */
function canTransitionOrder(from, to) {
    return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}
/**
 * Attempts to transition an order to a new status.
 *
 * @returns true if the transition was valid and applied.
 */
function transitionOrder(order, to) {
    if (!canTransitionOrder(order.status, to))
        return false;
    order.status = to;
    return true;
}
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
function validateDrawings(drawings) {
    // Deliberately not `Array.isArray`. That guard is typed `arg is any[]`, so on a
    // `readonly EditableDrawing[]` parameter it narrows the *surviving* branch to
    // `any[]` and every element below loses its type — which is how `drawing.type`
    // becomes an unindexable `any` two checks later. The runtime check is worth
    // having for a public method that JS callers reach too; it just has to be
    // written so it does not erase the type on the way past.
    if (drawings === null || typeof drawings !== 'object' || typeof drawings.length !== 'number') {
        throw new Error('MatrixCharts: setDrawings requires an array of drawings.');
    }
    const source = drawings;
    const seen = new Set();
    return source.map((drawing, position) => {
        const where = `at position ${position}`;
        if (drawing === null || typeof drawing !== 'object') {
            throw new Error(`MatrixCharts: Drawing ${where} is not an object.`);
        }
        if (typeof drawing.id !== 'string' || drawing.id.trim().length === 0) {
            throw new Error(`MatrixCharts: Drawing ${where} must have a non-empty string id.`);
        }
        if (seen.has(drawing.id)) {
            throw new Error(`MatrixCharts: Drawing id ${JSON.stringify(drawing.id)} is used more than once.`);
        }
        seen.add(drawing.id);
        if (!exports.DRAWING_TYPES.includes(drawing.type)) {
            throw new Error(`MatrixCharts: Drawing ${JSON.stringify(drawing.id)} has type `
                + `${JSON.stringify(drawing.type)}; expected one of ${exports.DRAWING_TYPES.join(', ')}.`);
        }
        if (!Array.isArray(drawing.points)) {
            throw new Error(`MatrixCharts: Drawing ${JSON.stringify(drawing.id)} must supply a points array.`);
        }
        const points = drawing.points;
        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            if (point === null || typeof point !== 'object' || point === undefined
                || !Number.isFinite(point.time) || !Number.isFinite(point.value)) {
                throw new Error(`MatrixCharts: Drawing ${JSON.stringify(drawing.id)} point ${i} must have a `
                    + 'finite time and value.');
            }
        }
        const required = MIN_POINTS[drawing.type];
        if (points.length < required) {
            throw new Error(`MatrixCharts: Drawing ${JSON.stringify(drawing.id)} is a ${drawing.type} and needs `
                + `at least ${required} point${required === 1 ? '' : 's'}; received ${points.length}.`);
        }
        if (!Number.isFinite(drawing.lineWidth) || drawing.lineWidth <= 0) {
            throw new Error(`MatrixCharts: Drawing ${JSON.stringify(drawing.id)} must have a lineWidth greater than zero.`);
        }
        if (!Number.isFinite(drawing.opacity) || drawing.opacity < 0 || drawing.opacity > 1) {
            throw new Error(`MatrixCharts: Drawing ${JSON.stringify(drawing.id)} must have an opacity between 0 and 1.`);
        }
        if (drawing.lineStyle !== 'solid' && drawing.lineStyle !== 'dashed') {
            throw new Error(`MatrixCharts: Drawing ${JSON.stringify(drawing.id)} has lineStyle `
                + `${JSON.stringify(drawing.lineStyle)}; expected 'solid' or 'dashed'.`);
        }
        return {
            ...drawing,
            active: drawing.active === true,
            selected: drawing.selected === true,
            label: typeof drawing.label === 'string' ? drawing.label : '',
            points: points.map((point) => ({ ...point })),
        };
    });
}
/** Every drawing type the model knows how to describe. */
exports.DRAWING_TYPES = [
    'trend-line', 'horizontal-line', 'rectangle', 'fib-retracement',
];
/**
 * The fewest points each type can be drawn from.
 *
 * Two everywhere, because every type is defined by an edge: a trend line and a
 * rectangle are a segment, a horizontal line is a segment, and a fib's levels are
 * interpolated between two ends. The count is what makes a shape well-defined, and
 * accepting fewer produces a drawing that renders as nothing.
 */
const MIN_POINTS = {
    'trend-line': 2,
    'horizontal-line': 2,
    rectangle: 2,
    'fib-retracement': 2,
};
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
function hitTestDrawings(x, y, drawings, orders, toScreen, toData, tolerance = 8) {
    // Lower is more specific. A number rather than a comparison chain, so adding a
    // pass later cannot silently reorder the ones above it.
    const RANK_HANDLE = 0;
    const RANK_ORDER = 1;
    const RANK_BODY = 2;
    let best = null;
    let bestRank = Number.POSITIVE_INFINITY;
    let bestDistance = Number.POSITIVE_INFINITY;
    // A candidate wins only by being more specific than what is held, or equally
    // specific and genuinely closer. Distance alone would let a broad body
    // out-rank a precise handle.
    const consider = (rank, distance, result) => {
        if (rank > bestRank || (rank === bestRank && distance >= bestDistance))
            return;
        best = result;
        bestRank = rank;
        bestDistance = distance;
    };
    // 1. Drag handles on selected drawings. A handle's own size is a floor on its
    // capture radius: the cursor is drawn at `size`, so a 6px fib handle has to be
    // grabbable at 6px even where the caller asked for a 4px tolerance. The flat
    // tolerance made `size` decorative, which made a small handle feel ungrabbable
    // while a large one felt generous.
    for (const drawing of drawings) {
        if (!drawing.selected)
            continue;
        for (const handle of getDrawingHandles(drawing)) {
            const screen = toScreen(handle);
            if (screen === null)
                continue;
            const distance = Math.hypot(screen.x - x, screen.y - y);
            if (distance > Math.max(tolerance, handle.size / 2))
                continue;
            consider(RANK_HANDLE, distance, {
                kind: 'handle',
                id: drawing.id,
                handleRole: handle.role,
                handleIndex: handle.index,
                distance,
                point: toData(x, y),
            });
        }
    }
    // 2. Orders (price lines). Only the y of the projection matters for a
    // horizontal rule, so the time is an arbitrary sentinel rather than a
    // fabricated one — but a null projection is still tolerated, because a caller
    // may be projecting through a transform that rejects it.
    for (const order of orders) {
        if (order.status !== 'working')
            continue;
        const screen = toScreen({ time: 0, value: order.price });
        if (screen === null)
            continue;
        const distance = Math.abs(screen.y - y);
        if (distance > tolerance)
            continue;
        consider(RANK_ORDER, distance, {
            kind: 'order',
            id: order.id,
            distance,
            point: toData(x, y),
        });
    }
    // 3. Drawing bodies.
    for (const drawing of drawings) {
        const hit = hitTestDrawingBody(drawing, x, y, toScreen, tolerance);
        if (hit === null)
            continue;
        consider(RANK_BODY, hit.distance, {
            kind: 'drawing',
            id: drawing.id,
            distance: hit.distance,
            point: toData(x, y),
        });
    }
    return best;
}
/**
 * Gets the drag handles for a drawing.
 */
function getDrawingHandles(drawing) {
    const handles = [];
    const points = drawing.points;
    if (points.length === 0)
        return handles;
    switch (drawing.type) {
        case 'trend-line': {
            // Start and end handles
            handles.push({
                role: 'resize-start',
                time: points[0].time,
                value: points[0].value,
                size: 8,
                cursor: 'nwse-resize',
            });
            const last = points[points.length - 1];
            handles.push({
                role: 'resize-end',
                time: last.time,
                value: last.value,
                size: 8,
                cursor: 'nwse-resize',
            });
            // Move handle halfway along the line in *data* space, which is what
            // "the middle of the line" means to the person looking at it.
            //
            // It used to be `points[Math.floor(points.length / 2)]`, the index
            // midpoint. For the two points a trend line actually has, that index
            // is 1 — the last point — so the move handle was drawn exactly on top of
            // the resize-end handle. Hit testing then returned resize-end every
            // time, because it was pushed first at an identical distance and the
            // comparison was a strict `<`, so the line could never be picked up to
            // move. The test only asserted `handles.length >= 3`, which a duplicate
            // satisfies.
            handles.push({
                role: 'move',
                time: (points[0].time + last.time) / 2,
                value: (points[0].value + last.value) / 2,
                size: 10,
                cursor: 'move',
            });
            break;
        }
        case 'horizontal-line': {
            // Move handle at the center
            const centerX = (points[0].time + points[points.length - 1].time) / 2;
            handles.push({
                role: 'move',
                time: centerX,
                value: points[0].value,
                size: 10,
                cursor: 'move',
            });
            break;
        }
        case 'rectangle': {
            // Four corner handles
            const xs = points.map(p => p.time);
            const ys = points.map(p => p.value);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            handles.push({ role: 'resize-top', time: (minX + maxX) / 2, value: maxY, size: 8, cursor: 'ns-resize' }, { role: 'resize-bottom', time: (minX + maxX) / 2, value: minY, size: 8, cursor: 'ns-resize' }, { role: 'resize-start', time: minX, value: (minY + maxY) / 2, size: 8, cursor: 'ew-resize' }, { role: 'resize-end', time: maxX, value: (minY + maxY) / 2, size: 8, cursor: 'ew-resize' });
            // Move handle at center
            handles.push({
                role: 'move',
                time: (minX + maxX) / 2,
                value: (minY + maxY) / 2,
                size: 10,
                cursor: 'move',
            });
            break;
        }
        case 'fib-retracement': {
            // One handle per level, each carrying its own index. The role stays
            // `resize-bottom` because the union has no per-level name, so a handle
            // hit could not previously be turned back into "drag the 0.618 line" —
            // seven indistinguishable handles, and `handleRole` alone said nothing
            // about which. `index` is what identifies the level.
            for (let index = 0; index < points.length; index++) {
                const point = points[index];
                handles.push({
                    role: 'resize-bottom',
                    index,
                    time: point.time,
                    value: point.value,
                    size: 6,
                    cursor: 'ns-resize',
                });
            }
            break;
        }
    }
    return handles;
}
/**
 * Hit tests a single drawing's body.
 *
 * The returned distance is a *comparable* measure of how near the pointer came, so
 * that the hit test can rank a rectangle against a line rather than just finding
 * that each was within tolerance. Distance to a shape's centre, which is what this
 * used for a rectangle, is not that: a pointer 2px inside a 400px-tall box reported
 * a distance of 200, so a large rectangle always lost to a line that was genuinely
 * closer and won against one that was further. Nearest edge is the measure that
 * means the same thing for every shape.
 *
 * Returns null for a drawing whose points do not project to screen at all, rather
 * than throwing on the null.
 */
function hitTestDrawingBody(drawing, x, y, toScreen, tolerance) {
    const points = drawing.points;
    if (points.length === 0)
        return null;
    // A point with no screen position cannot anchor a shape, and a shape with
    // missing corners is not the shape the caller drew. One unprojectable point
    // drops the whole body rather than silently testing against a partial outline.
    const screenPoints = [];
    for (const point of points) {
        const screen = toScreen(point);
        if (screen === null)
            return null;
        screenPoints.push(screen);
    }
    if (drawing.type === 'horizontal-line') {
        const lineY = screenPoints[0].y;
        const distance = Math.abs(y - lineY);
        if (distance <= tolerance)
            return { distance };
        return null;
    }
    if (drawing.type === 'trend-line' && screenPoints.length >= 2) {
        // Distance from point to line segment
        const distance = pointToSegmentDistance(x, y, screenPoints[0], screenPoints[screenPoints.length - 1]);
        if (distance <= tolerance)
            return { distance };
        return null;
    }
    if (drawing.type === 'rectangle' && screenPoints.length >= 2) {
        return hitTestRectBody(screenPoints, x, y, tolerance);
    }
    if (drawing.type === 'fib-retracement' && screenPoints.length >= 2) {
        return hitTestFibBody(screenPoints, x, y, tolerance);
    }
    return null;
}
/**
 * Distance from the pointer to a rectangle's outline, or null when it is further
 * than the tolerance from the outline.
 *
 * The outline, not the centre and not the tolerance-expanded box. Distance to the
 * centre is not a measure of how near the pointer came — a pointer 2px inside a
 * 400px box reported 200 — so a large rectangle always lost to a line that was
 * genuinely closer and beat one that was further, and "closest hit" meant nothing
 * across mixed shapes. Measuring to the tolerance-expanded box is wrong in the other
 * direction: it reports every interior point as exactly `tolerance` away, so nothing
 * inside the box can outrank anything else.
 *
 * The tolerance decides *whether* the outline was hit. The distance reported is the
 * distance to it.
 */
function hitTestRectBody(screenPoints, x, y, tolerance) {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const point of screenPoints) {
        if (point.x < minX)
            minX = point.x;
        if (point.x > maxX)
            maxX = point.x;
        if (point.y < minY)
            minY = point.y;
        if (point.y > maxY)
            maxY = point.y;
    }
    // How far outside the box the pointer is on each axis, 0 when it is within.
    const outsideX = Math.max(minX - x, 0, x - maxX);
    const outsideY = Math.max(minY - y, 0, y - maxY);
    let distance;
    if (outsideX > 0 && outsideY > 0) {
        // Beyond a corner: the nearest point on the outline is the corner itself.
        distance = Math.sqrt(outsideX * outsideX + outsideY * outsideY);
    }
    else if (outsideX > 0) {
        distance = outsideX;
    }
    else if (outsideY > 0) {
        distance = outsideY;
    }
    else {
        // Inside: the nearest outline is the nearest of the four edges.
        distance = Math.min(x - minX, maxX - x, y - minY, maxY - y);
    }
    if (distance > tolerance)
        return null;
    return { distance };
}
/**
 * Nearest distance from the pointer to any of a fib retracement's level lines,
 * provided the pointer is between the first and last level horizontally.
 *
 * A fib had no body test at all — `hitTestDrawingBody` branched on the other three
 * types and then fell through to `null` — so a deselected fib was completely
 * ungrabbable, while a trend line drawn through the same pixels was not. The test
 * is against the level lines rather than the filled area between them, because
 * between the levels is empty space and clicking it should not select the drawing.
 */
function hitTestFibBody(screenPoints, x, y, tolerance) {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    for (const point of screenPoints) {
        if (point.x < minX)
            minX = point.x;
        if (point.x > maxX)
            maxX = point.x;
    }
    // Outside the levels' own span, with the tolerance applied, there is nothing to
    // grab: the fib has no extent there.
    if (x < minX - tolerance || x > maxX + tolerance)
        return null;
    let nearest = Number.POSITIVE_INFINITY;
    for (const point of screenPoints) {
        const distance = Math.abs(y - point.y);
        if (distance < nearest)
            nearest = distance;
    }
    if (nearest > tolerance)
        return null;
    return { distance: nearest };
}
/**
 * Distance from a point to a line segment.
 *
 * Compares squared distances internally and takes one square root, rather than a
 * square root per candidate. At the scale this runs — every handle of every
 * selected drawing, on every hit test — the root is the expensive part and it was
 * being paid for each one only to be compared against a tolerance.
 */
function pointToSegmentDistance(px, py, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0)
        return Math.hypot(px - a.x, py - a.y);
    let t = ((px - a.x) * dx + (py - a.y) * dy) / lengthSq;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const ex = px - (a.x + t * dx);
    const ey = py - (a.y + t * dy);
    return Math.sqrt(ex * ex + ey * ey);
}
// --- drawing creation --------------------------------------------------------
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
function createDrawingFromGesture(type, start, end, id, color = '#4c9aff', timeSnap) {
    assertAnchor(start, 'start');
    assertAnchor(end, 'end');
    if (typeof id !== 'string' || id.trim().length === 0) {
        throw new Error('MatrixCharts: A drawing id must be a non-empty string.');
    }
    const points = [];
    const place = (time) => (timeSnap ? timeSnap(time) : time);
    switch (type) {
        case 'trend-line':
            points.push(start, end);
            break;
        case 'horizontal-line':
            // Both endpoints carry the start's price: the line is horizontal, and
            // storing the end's price would make `createOrderFromDrawing` and any
            // consumer reading `points[1].value` disagree with what was drawn.
            points.push({ time: start.time, value: start.value }, { time: end.time, value: start.value });
            break;
        case 'rectangle':
            points.push({ time: start.time, value: start.value }, { time: end.time, value: end.value });
            break;
        case 'fib-retracement': {
            const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
            const minVal = Math.min(start.value, end.value);
            const maxVal = Math.max(start.value, end.value);
            for (const level of levels) {
                points.push({
                    time: place(start.time + (end.time - start.time) * level),
                    value: minVal + (maxVal - minVal) * level,
                });
            }
            break;
        }
    }
    return {
        id,
        type,
        points,
        color,
        lineWidth: 1,
        lineStyle: 'solid',
        active: false,
        selected: true,
        label: '',
        opacity: 1,
    };
}
/**
 * A NaN anchor is not a drawing that renders slightly wrong, it is a drawing whose
 * every projected coordinate is NaN, which silently fails every hit test and every
 * bounds check downstream. The gesture comes from a pointer, so the realistic route
 * is a division by a zero-width viewport during a resize.
 */
function assertAnchor(point, which) {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.value)) {
        throw new Error(`MatrixCharts: Drawing ${which} point must have a finite time and value; `
            + `received time ${point.time}, value ${point.value}.`);
    }
}
// --- order creation from drawings --------------------------------------------
/**
 * Creates an order from a drawing.
 *
 * A horizontal line or the endpoint of a trend line can be converted to an order.
 */
function createOrderFromDrawing(drawing, side, id, quantity = 1) {
    if (drawing.type === 'horizontal-line') {
        return {
            id,
            side,
            price: drawing.points[0].value,
            quantity,
            status: 'working',
        };
    }
    if (drawing.type === 'trend-line' && drawing.points.length >= 2) {
        const lastPoint = drawing.points[drawing.points.length - 1];
        return {
            id,
            side,
            price: lastPoint.value,
            quantity,
            status: 'working',
        };
    }
    return null;
}
