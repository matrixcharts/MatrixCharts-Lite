// Tests for src/core/drawingOrderModel.ts
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    canTransitionOrder,
    createDrawingFromGesture,
    createOrderFromDrawing,
    getDrawingHandles,
    hitTestDrawings,
    validateDrawings,
    DRAWING_TYPES,
} = require('../.test-build/core/drawingOrderModel.js');

/**
 * A projector over a plain time/price space, so geometry can be tested without a
 * chart. Times and values are used directly as pixels, which keeps the expected
 * coordinates in the assertions readable.
 */
const identity = (point) => (point.time < 0 ? null : { x: point.time, y: point.value });
const unproject = (x, y) => ({ time: x, value: y });

function drawing(overrides) {
    return {
        id: 'd',
        type: 'trend-line',
        points: [],
        color: '#fff',
        lineWidth: 1,
        lineStyle: 'solid',
        active: false,
        selected: false,
        label: '',
        opacity: 1,
        ...overrides,
    };
}

// --- order state machine -----------------------------------------------------

test('working order can transition to filled, cancelled, or rejected', () => {
    assert.equal(canTransitionOrder('working', 'filled'), true);
    assert.equal(canTransitionOrder('working', 'cancelled'), true);
    assert.equal(canTransitionOrder('working', 'rejected'), true);
});

test('filled order is terminal', () => {
    assert.equal(canTransitionOrder('filled', 'working'), false);
    assert.equal(canTransitionOrder('filled', 'cancelled'), false);
    assert.equal(canTransitionOrder('filled', 'rejected'), false);
});

test('cancelled order is terminal', () => {
    assert.equal(canTransitionOrder('cancelled', 'working'), false);
    assert.equal(canTransitionOrder('cancelled', 'filled'), false);
});

test('rejected order is terminal', () => {
    assert.equal(canTransitionOrder('rejected', 'working'), false);
    assert.equal(canTransitionOrder('rejected', 'filled'), false);
});

// --- drawing creation --------------------------------------------------------

test('createDrawingFromGesture creates a trend line', () => {
    const drawing = createDrawingFromGesture(
        'trend-line',
        { time: 100, value: 50 },
        { time: 200, value: 80 },
        'd1',
    );
    assert.equal(drawing.id, 'd1');
    assert.equal(drawing.type, 'trend-line');
    assert.equal(drawing.points.length, 2);
    assert.equal(drawing.points[0].time, 100);
    assert.equal(drawing.points[1].value, 80);
    assert.equal(drawing.selected, true);
});

test('createDrawingFromGesture creates a horizontal line', () => {
    const drawing = createDrawingFromGesture(
        'horizontal-line',
        { time: 100, value: 50 },
        { time: 200, value: 80 },
        'd2',
    );
    assert.equal(drawing.type, 'horizontal-line');
    assert.equal(drawing.points.length, 2);
    assert.equal(drawing.points[0].value, 50);
    assert.equal(drawing.points[1].value, 50);
});

test('createDrawingFromGesture creates a rectangle', () => {
    const drawing = createDrawingFromGesture(
        'rectangle',
        { time: 100, value: 50 },
        { time: 200, value: 80 },
        'd3',
    );
    assert.equal(drawing.type, 'rectangle');
    assert.equal(drawing.points.length, 2);
});

test('createDrawingFromGesture creates fib retracement with levels', () => {
    const drawing = createDrawingFromGesture(
        'fib-retracement',
        { time: 100, value: 50 },
        { time: 200, value: 100 },
        'd4',
    );
    assert.equal(drawing.type, 'fib-retracement');
    assert.equal(drawing.points.length, 7); // 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1
});

// --- drag handles ------------------------------------------------------------

test('getDrawingHandles returns handles for trend line', () => {
    const drawing = createDrawingFromGesture(
        'trend-line',
        { time: 100, value: 50 },
        { time: 200, value: 80 },
        'd1',
    );
    const handles = getDrawingHandles(drawing);
    assert.ok(handles.length >= 3);
    assert.ok(handles.some(h => h.role === 'resize-start'));
    assert.ok(handles.some(h => h.role === 'resize-end'));
    assert.ok(handles.some(h => h.role === 'move'));
});

test('getDrawingHandles returns handles for rectangle', () => {
    const drawing = createDrawingFromGesture(
        'rectangle',
        { time: 100, value: 50 },
        { time: 200, value: 80 },
        'd2',
    );
    const handles = getDrawingHandles(drawing);
    assert.ok(handles.length >= 5);
    assert.ok(handles.some(h => h.role === 'resize-top'));
    assert.ok(handles.some(h => h.role === 'resize-bottom'));
    assert.ok(handles.some(h => h.role === 'move'));
});

test('getDrawingHandles returns empty for empty drawing', () => {
    const drawing = { id: 'd', type: 'trend-line', points: [], color: '#fff', lineWidth: 1, lineStyle: 'solid', active: false, selected: true, label: '', opacity: 1 };
    const handles = getDrawingHandles(drawing);
    assert.equal(handles.length, 0);
});

// --- order creation from drawings --------------------------------------------

test('createOrderFromDrawing creates order from horizontal line', () => {
    const drawing = createDrawingFromGesture(
        'horizontal-line',
        { time: 100, value: 50 },
        { time: 200, value: 50 },
        'd1',
    );
    const order = createOrderFromDrawing(drawing, 'buy', 'o1', 10);
    assert.ok(order);
    assert.equal(order.price, 50);
    assert.equal(order.side, 'buy');
    assert.equal(order.quantity, 10);
    assert.equal(order.status, 'working');
});

test('createOrderFromDrawing creates order from trend line endpoint', () => {
    const drawing = createDrawingFromGesture(
        'trend-line',
        { time: 100, value: 50 },
        { time: 200, value: 80 },
        'd2',
    );
    const order = createOrderFromDrawing(drawing, 'sell', 'o2', 5);
    assert.ok(order);
    assert.equal(order.price, 80);
    assert.equal(order.side, 'sell');
});

test('createOrderFromDrawing returns null for rectangle', () => {
    const drawing = createDrawingFromGesture(
        'rectangle',
        { time: 100, value: 50 },
        { time: 200, value: 80 },
        'd3',
    );
    const order = createOrderFromDrawing(drawing, 'buy', 'o3');
    assert.equal(order, null);
});

// --- hit testing -------------------------------------------------------------

test('hitTestDrawings finds a working order', () => {
    const drawings = [];
    const orders = [{ id: 'o1', price: 100, status: 'working' }];
    const toScreen = (p) => ({ x: p.time, y: p.value });
    const toData = (x, y) => ({ time: x, value: y });

    const hit = hitTestDrawings(50, 100, drawings, orders, toScreen, toData, 8);
    assert.ok(hit);
    assert.equal(hit.kind, 'order');
    assert.equal(hit.id, 'o1');
});

test('hitTestDrawings finds a selected drawing handle', () => {
    const drawing = createDrawingFromGesture(
        'trend-line',
        { time: 100, value: 50 },
        { time: 200, value: 80 },
        'd1',
    );
    drawing.selected = true;
    const orders = [];
    const toScreen = (p) => ({ x: p.time, y: p.value });
    const toData = (x, y) => ({ time: x, value: y });

    // Hit near the start handle
    const hit = hitTestDrawings(100, 50, [drawing], orders, toScreen, toData, 8);
    assert.ok(hit);
    assert.equal(hit.kind, 'handle');
    assert.equal(hit.id, 'd1');
    assert.equal(hit.handleRole, 'resize-start');
});

test('hitTestDrawings returns null when nothing is hit', () => {
    const drawings = [];
    const orders = [{ id: 'o1', price: 100, status: 'working' }];
    const toScreen = (p) => ({ x: p.time, y: p.value });
    const toData = (x, y) => ({ time: x, value: y });

    const hit = hitTestDrawings(500, 500, drawings, orders, toScreen, toData, 8);
    assert.equal(hit, null);
});

test('hitTestDrawings skips non-working orders', () => {
    const drawings = [];
    const orders = [{ id: 'o1', price: 100, status: 'filled' }];
    const toScreen = (p) => ({ x: p.time, y: p.value });
    const toData = (x, y) => ({ time: x, value: y });

    const hit = hitTestDrawings(50, 100, drawings, orders, toScreen, toData, 8);
    assert.equal(hit, null);
});

// --- handle geometry ---------------------------------------------------------

// A trend line has three handles and the move handle used to sit on top of the
// resize-end handle. The index midpoint of two points is 1, which is also the last
// point, so a two-point trend line had two handles at the same place and hit
// testing returned resize-end every time — the line could never be picked up to
// move. The test that existed asserted `handles.length >= 3`, which a duplicate
// satisfies.

test('a two-point trend line has three distinct handle positions', () => {
    const handles = getDrawingHandles(drawing({
        type: 'trend-line',
        points: [{ time: 0, value: 0 }, { time: 100, value: 50 }],
    }));
    assert.equal(handles.length, 3);
    const key = (h) => `${h.role}@${h.time},${h.value}`;
    assert.equal(new Set(handles.map(key)).size, 3, 'no two handles coincide');
});

test('the trend line move handle is halfway along the line', () => {
    const handles = getDrawingHandles(drawing({
        type: 'trend-line',
        points: [{ time: 0, value: 0 }, { time: 100, value: 50 }],
    }));
    const move = handles.find((h) => h.role === 'move');
    assert.ok(move, 'a move handle exists');
    assert.equal(move.time, 50);
    assert.equal(move.value, 25);
});

// Seven fib levels, seven identical `resize-bottom` handles, and a role is not a
// unique identifier — so a handle hit could not be turned back into "drag the
// 0.618 line". `index` is what identifies the level.

test('each fib level has its own handle index', () => {
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const points = levels.map((level) => ({ time: level * 100, value: 100 - level * 50 }));
    const handles = getDrawingHandles(drawing({ type: 'fib-retracement', points }));
    assert.equal(handles.length, levels.length);
    assert.deepEqual(handles.map((h) => h.index), levels.map((_, i) => i));
    for (let i = 0; i < handles.length; i++) {
        assert.equal(handles[i].time, points[i].time);
        assert.equal(handles[i].value, points[i].value);
    }
});

test('a handle hit reports which level was hit', () => {
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const points = levels.map((level) => ({ time: level * 100, value: 100 - level * 50 }));
    const fib = drawing({ type: 'fib-retracement', points, selected: true });
    // Level 4 is 0.618: time 61.8, value 69.1.
    const hit = hitTestDrawings(61.8, 69.1, [fib], [], identity, unproject, 8);
    assert.ok(hit, 'the level was hit');
    assert.equal(hit.kind, 'handle');
    assert.equal(hit.handleIndex, 4);
});

// --- hit-test priority -------------------------------------------------------

// The documented order is handles, then orders, then bodies. The three passes each
// kept the nearest candidate by distance alone and the body pass ran last, so a
// broad body 1px away could displace a handle 7px away.

test('a handle outranks a nearer body', () => {
    const rect = drawing({
        type: 'rectangle',
        selected: true,
        points: [{ time: 0, value: 0 }, { time: 100, value: 100 }],
    });
    // The pointer is 1px from the middle of the rectangle's right edge, and 7px from
    // the trend line's midpoint handle.
    const line = drawing({
        type: 'trend-line',
        selected: true,
        points: [{ time: 20, value: 100 }, { time: 60, value: 100 }],
    });
    const hit = hitTestDrawings(100, 50, [rect, line], [], identity, unproject, 8);
    assert.ok(hit, 'something was hit');
    assert.equal(hit.kind, 'handle', 'the more specific target wins');
    assert.equal(hit.id, 'd');
});

test('an order outranks a nearer drawing body', () => {
    const line = drawing({
        type: 'trend-line',
        points: [{ time: 0, value: 100 }, { time: 100, value: 100 }],
    });
    const orders = [{ id: 'o1', price: 102, status: 'working' }];
    // 2px from the order, and on the line itself.
    const hit = hitTestDrawings(50, 102, [line], orders, identity, unproject, 8);
    assert.ok(hit);
    assert.equal(hit.kind, 'order');
});

test('a body is still found when nothing more specific is near', () => {
    const line = drawing({
        type: 'trend-line',
        points: [{ time: 0, value: 0 }, { time: 100, value: 100 }],
    });
    const hit = hitTestDrawings(50, 54, [line], [], identity, unproject, 8);
    assert.ok(hit);
    assert.equal(hit.kind, 'drawing');
});

// --- body distance is comparable across shapes --------------------------------

// Distance to a rectangle's centre is not a measure of how near the pointer came: a
// pointer 2px inside a 400px box reported 200, so a large rectangle always lost to a
// line that was genuinely closer and beat one that was further. Nearest edge is the
// measure that means the same thing for every shape.

test('a rectangle reports distance to its nearest edge, not its centre', () => {
    const rect = drawing({
        type: 'rectangle',
        points: [{ time: 0, value: 0 }, { time: 400, value: 400 }],
    });
    // 2px inside the top edge of a 400px box. Distance to the centre would be 200;
    // distance to the outline is 2.
    const near = hitTestDrawings(200, 2, [rect], [], identity, unproject, 8);
    assert.ok(near, 'inside the box');
    assert.equal(near.kind, 'drawing');
    assert.ok(Math.abs(near.distance - 2) < 1e-9, `expected 2, got ${near.distance}`);

    // 2px outside the left edge, same distance, so the two are comparable.
    const outside = hitTestDrawings(-2, 200, [rect], [], identity, unproject, 8);
    assert.ok(outside, 'just outside the box');
    assert.ok(Math.abs(outside.distance - 2) < 1e-9, `expected 2, got ${outside.distance}`);

    // 100px inside the top edge is outside the 8px tolerance.
    const far = hitTestDrawings(200, 100, [rect], [], identity, unproject, 8);
    assert.equal(far, null);
});

// A fib had no body test at all — the function branched on the other three types and
// fell through to null — so a deselected fib was ungrabbable while a trend line
// through the same pixels was not.

test('a deselected fib is grabbable on one of its levels', () => {
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const fib = drawing({
        type: 'fib-retracement',
        selected: false,
        points: levels.map((level) => ({ time: level * 100, value: 100 - level * 50 })),
    });
    // Level 3 is 0.5: time 50, value 75.
    const hit = hitTestDrawings(50, 76, [fib], [], identity, unproject, 8);
    assert.ok(hit, 'the fib body was hit');
    assert.equal(hit.kind, 'drawing');
    assert.equal(hit.distance, 1);
});

test('empty space between fib levels is not a hit', () => {
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const fib = drawing({
        type: 'fib-retracement',
        points: levels.map((level) => ({ time: level * 100, value: 100 - level * 50 })),
    });
    // Fib levels are horizontal lines across the whole span, so "near a level" is the
    // nearest of the seven. The levels here sit at 100, 88.2, 80.9, 75, 69.1, 60.7
    // and 50; y=72 is 2.9 from the nearest, which is beyond a 2px tolerance.
    const hit = hitTestDrawings(50, 72, [fib], [], identity, unproject, 2);
    assert.equal(hit, null);
});

test('a fib outside its own span is not a hit however close the y', () => {
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const fib = drawing({
        type: 'fib-retracement',
        points: levels.map((level) => ({ time: level * 100, value: 100 - level * 50 })),
    });
    // Exactly on the 0.786 level's height, but 30px to the right of the last one.
    const hit = hitTestDrawings(130, 60.7, [fib], [], identity, unproject, 8);
    assert.equal(hit, null);
});

// --- a projection with no screen position -------------------------------------

// `Chart.timeToCoordinate` answers null when there is nothing to project onto, and a
// caller with its own transform is free to answer null for a time it cannot place.
// `hitTestDrawings` dereferenced the result unconditionally, so a transform that
// skipped one point took the whole hit test down with it. The stub here projects
// null for a time inside a gap, which is the shape a caller's transform can have even
// though the engine's own snaps to the nearer bar.

test('a null projection is skipped rather than dereferenced', () => {
    // A horizontal line drawn across a session break. Its move handle is the mean of
    // two timestamps that straddle the gap.
    const line = drawing({
        type: 'horizontal-line',
        selected: true,
        points: [{ time: 100, value: 50 }, { time: 500, value: 50 }],
    });
    const withGap = (point) => (point.time === 300 ? null : { x: point.time, y: point.value });
    const hit = hitTestDrawings(500, 50, [line], [], withGap, unproject, 8);
    // The gap handle is skipped; the line body is still hit on the visible half.
    assert.ok(hit, 'the line is still reachable');
    assert.equal(hit.kind, 'drawing');
});

test('a handle on the only visible anchor is found when the other has no position', () => {
    const line = drawing({
        type: 'horizontal-line',
        selected: true,
        points: [{ time: 100, value: 50 }, { time: 500, value: 50 }],
    });
    const withGap = (point) => (point.time === 300 ? null : { x: point.time, y: point.value });
    // The move handle is the gap point, so it is gone. A resize handle at each real
    // endpoint is not, and one of them is 2px from the pointer.
    const hit = hitTestDrawings(100, 52, [line], [], withGap, unproject, 8);
    assert.ok(hit);
    assert.equal(hit.kind, 'drawing');
});

test('an order whose projection is null is skipped', () => {
    const orders = [{ id: 'o1', price: 100, status: 'working' }];
    const nothing = () => null;
    assert.equal(hitTestDrawings(0, 100, [], orders, nothing, unproject, 8), null);
});

test('a drawing with any unprojectable point is not hit', () => {
    const rect = drawing({
        type: 'rectangle',
        points: [{ time: 0, value: 0 }, { time: -1, value: 100 }],
    });
    const withGap = (point) => (point.time < 0 ? null : { x: point.time, y: point.value });
    assert.equal(hitTestDrawings(0, 0, [rect], [], withGap, unproject, 8), null);
});

// --- handle size is a floor on its own capture radius -------------------------

// `size` used to be ignored, so a 6px fib handle had the caller's 8px tolerance and
// a 10px move handle had the same 8px. The size is the drawn size, so a handle
// cannot be smaller than the cursor the user is being asked to hit.

test('a handle is grabbable at least at its own drawn size', () => {
    const levels = [0, 0.5, 1];
    const fib = drawing({
        type: 'fib-retracement',
        selected: true,
        points: levels.map((level) => ({ time: level * 100, value: 100 - level * 50 })),
    });
    // A tight tolerance the 6px handles should still survive at 3px.
    const hit = hitTestDrawings(50, 78, [fib], [], identity, unproject, 2);
    assert.ok(hit, 'grabbable at 3px with a 2px tolerance');
    assert.equal(hit.kind, 'handle');
});

// --- gesture validation ------------------------------------------------------

// A NaN anchor projects to NaN, so it fails every bounds check and every hit test
// silently. A gesture comes from a pointer, so the realistic route is a division by
// a zero-width viewport during a resize.

test('a gesture with a non-finite anchor is refused', () => {
    assert.throws(
        () => createDrawingFromGesture('trend-line', { time: Number.NaN, value: 1 }, { time: 2, value: 3 }, 'd'),
        /finite time and value/,
    );
    assert.throws(
        () => createDrawingFromGesture('trend-line', { time: 1, value: 1 }, { time: 2, value: Number.POSITIVE_INFINITY }, 'd'),
        /finite time and value/,
    );
});

test('a gesture with an empty id is refused', () => {
    assert.throws(
        () => createDrawingFromGesture('trend-line', { time: 1, value: 1 }, { time: 2, value: 3 }, '  '),
        /non-empty string/,
    );
});

// The chart's x axis is candle ordinals with closed intervals compressed out, not
// wall clock, so a linear time split does not land on evenly spaced bars. Across a
// session break the 0.5 level lands in dead air with no candle behind it.

test('a fib aligns its levels to the candle grid when given a snap', () => {
    // Snap onto a 1-minute grid, which is what a caller with a candle series passes.
    const grid = (time) => Math.round(time / 60_000) * 60_000;
    const drawingResult = createDrawingFromGesture(
        'fib-retracement',
        { time: 0, value: 100 },
        { time: 600_000, value: 200 },
        'fib',
        '#fff',
        grid,
    );
    for (const point of drawingResult.points) {
        assert.equal(point.time % 60_000, 0, `level time ${point.time} is off the candle grid`);
    }
    // Without a snap the levels are still well formed, just interpolated in time.
    const unsnapped = createDrawingFromGesture(
        'fib-retracement', { time: 0, value: 100 }, { time: 600_000, value: 200 }, 'fib2',
    );
    assert.equal(unsnapped.points.length, 7);
    assert.equal(unsnapped.points[0].time, 0);
    assert.equal(unsnapped.points[6].time, 600_000);
});

// --- setDrawings validation --------------------------------------------------

// Every other bulk-ingest path in the library validates before it mutates, and a
// refused call leaves the previous set untouched. `setDrawings` was the one hole.

test('duplicate drawing ids are refused', () => {
    const a = drawing({ id: 'same', points: [{ time: 0, value: 0 }, { time: 1, value: 1 }] });
    assert.throws(() => validateDrawings([a, { ...a }]), /used more than once/);
});

test('an empty or non-string drawing id is refused', () => {
    assert.throws(() => validateDrawings([drawing({ id: '' })]), /non-empty string id/);
    assert.throws(() => validateDrawings([drawing({ id: 7 })]), /non-empty string id/);
});

test('an unknown drawing type is refused', () => {
    assert.throws(
        () => validateDrawings([drawing({ type: 'ray', points: [{ time: 0, value: 0 }, { time: 1, value: 1 }] })]),
        /expected one of/,
    );
});

test('a non-finite anchor is refused', () => {
    assert.throws(
        () => validateDrawings([drawing({ points: [{ time: 0, value: 0 }, { time: Number.NaN, value: 1 }] })]),
        /finite time and value/,
    );
});

test('a drawing with too few points for its type is refused', () => {
    assert.throws(
        () => validateDrawings([drawing({ type: 'trend-line', points: [{ time: 0, value: 0 }] })]),
        /needs at least 2 points/,
    );
});

test('an out-of-range opacity or line width is refused', () => {
    const two = [{ time: 0, value: 0 }, { time: 1, value: 1 }];
    assert.throws(() => validateDrawings([drawing({ points: two, opacity: 1.5 })]), /opacity between 0 and 1/);
    assert.throws(() => validateDrawings([drawing({ points: two, opacity: -0.1 })]), /opacity between 0 and 1/);
    assert.throws(() => validateDrawings([drawing({ points: two, lineWidth: 0 })]), /lineWidth greater than zero/);
});

test('an unknown line style is refused', () => {
    const two = [{ time: 0, value: 0 }, { time: 1, value: 1 }];
    assert.throws(() => validateDrawings([drawing({ points: two, lineStyle: 'dotted' })]), /expected 'solid' or 'dashed'/);
});

test('validation clones, so the caller cannot write into the result', () => {
    const points = [{ time: 0, value: 0 }, { time: 1, value: 1 }];
    const result = validateDrawings([drawing({ id: 'a', points })]);
    result[0].points[0].value = 999;
    assert.equal(points[0].value, 0, 'the input points are untouched');
});

test('validation normalises the selection flags', () => {
    const result = validateDrawings([drawing({
        id: 'a',
        selected: 'yes',
        active: 1,
        points: [{ time: 0, value: 0 }, { time: 1, value: 1 }],
    })]);
    assert.equal(result[0].selected, false);
    assert.equal(result[0].active, false);
});

test('a non-array argument is refused', () => {
    assert.throws(() => validateDrawings(null), /requires an array/);
    assert.throws(() => validateDrawings(undefined), /requires an array/);
});

test('an empty drawing list is valid', () => {
    assert.deepEqual(validateDrawings([]), []);
});

test('every declared drawing type has a minimum point count', () => {
    for (const type of DRAWING_TYPES) {
        const points = [{ time: 0, value: 0 }];
        assert.throws(
            () => validateDrawings([drawing({ type, points })]),
            /needs at least 2 points/,
            `${type} should reject a single point`,
        );
    }
});
