# Changelog

Notable changes to MatrixCharts, newest first. The frozen v1 public surface and
its reasoning live in [docs/v1-contract.md](docs/v1-contract.md); this file
records what moved and why, per release.

## v1.3.1

- **Fix background grid canvas clearing on theme change** — `Canvas2DRenderer.clear()` now always calls `this.ctx.clearRect()` before filling `options.layout.background`. This eliminates ghost line and axis label accumulation during replay or viewport panning when switching themes or using `layout: { background: 'transparent' }`.

## v1.3.0

Unreleased.

**This is the first release that actually reaches npm.** The published `latest` is **1.2.0**,
so 1.2.1, 1.2.2 and 1.2.3 were version numbers this repository carried and never shipped —
which is why this is a minor bump rather than a patch: the unreleased work since 1.2.0 is
additive, and it includes a new public option.

Minor, not patch, and not by preference: `watermark: { visible, opacity }` is a new field on
the resolved options, and labelling an added option as a patch release is the same category of
error as calling a capability green when it is not there. `docs/v1-contract.md` explicitly
permits this — "additive APIs may appear in later 1.x releases" — so nothing in the frozen
surface moved.

Carried from the three commits tagged 1.2.1–1.2.3, none of which shipped:

- **Multi-pane coordinate projection** — `toData`/`toScreen`/`coordinateToPaneValue`/
  `paneValueToCoordinate`, and `drawingProjector`/`drawingUnprojector` across panes 0..N.
- **Configurable price axis placement** — `layout.priceAxisPosition: 'left' | 'right' | 'both'`.
- **Dynamic gutter width** — measured from font metrics, digits and precision.
- **Native histogram / area / band overlays** — `OverlaySpec.type` extended, with WebGL2
  instanced batching and a Canvas2D fallback.
- **A brand watermark badge** — `watermark.visible` and `watermark.opacity`.

Added since, and **not** a public API change:

- **The pointer-release teardown is now idempotent.** In a real browser `lostpointercapture`
  fires *after* a completed `pointerup`, so every release arrives twice. The teardown now drops
  a pointer the chart is not tracking. **No observable behaviour changes today** — `wasSinglePointer`
  is read before the delete, so the stray delivery was already suppressed — and the guard is
  there so the next feature that adds a side effect to the release path inherits a teardown that
  is safe to run twice. Nine contract tests in `tests/PointerRelease.test.cjs`.
- **The headless harness stamps `event.type`** onto dispatched pointer events. A stub that omits
  a field the chart reads is a stub that can disagree with a browser.
- **`check:interaction` refuses to run against the wrong engine.** Both packages ship
  `tests/browser/interaction.e2e.html` at the same path and the runner asked a bare
  `localhost:5173`, so whichever dev server was listening answered it. A run from this checkout
  against the advanced checkout's server reported 30/32 in which **every result was about the
  other engine**. The page now declares its repository and the runner asserts it.
- **`dist/` is no longer tracked**, so a commit can no longer be a day behind its own build, and
  `"prepack": "npm run build"` is restored so a publish cannot ship a stale bundle. Verified that
  the pnpm approval prompt which got `prepack` removed in `32b7b53` does not reproduce on
  pnpm 11.8.0; `prepublishOnly` was rejected in its favour because it does not run on `pnpm pack`.

## v1.2.3

Not published. See v1.3.0 above.

An additive core release providing configurable price axis placement, dynamic gutter width measurement, full multi-pane coordinate projections, and native histogram/area/band overlay rendering on WebGL2 and Canvas2D.

### Added

- **Configurable Price Axis Placement**: Added `layout.priceAxisPosition: 'left' | 'right' | 'both'`. Positions the price axis gutter, divider lines, tick marks, labels, last-price badges, price line tags, and crosshair badges to the left, right, or both sides of the chart.
- **Dynamic Gutter Width Measurement**: Replaced rigid fixed gutters with dynamic width calculation based on font metrics, digits, and decimal precision (`measureDynamicPriceAxisWidth`), with automatic resize adjustment during data updates.
- **Full Multi-Pane Coordinate Projection**: Upgraded `drawingProjector(pane)` and `drawingUnprojector(pane)` to project and unproject across both Pane 0 and Subpanes 1..N (RSI, MACD, etc.). Added public coordinate projection APIs: `toData(x, y, pane)`, `toScreen(point, pane)`, `coordinateToPaneValue(pane, y)`, and `paneValueToCoordinate(pane, value)`.
- **Native Histogram & Area Overlays**: Extended `OverlaySpec` with `type: 'line' | 'histogram' | 'band' | 'area'`, `baseline`, `fillColor`, and `points2`/`value2` for cloud band fills. Implemented native WebGL2 instanced triangle/quad geometry batching and Canvas2D fallback rendering.

## v1.2.0

Released: 2026-09-29

An additive release: two new public methods and a fix to a per-frame cost that made a
chart with many indicators miss the frame budget. No export, option or event field is
removed or repurposed.

### Added

**`Chart.setPointerClaimHandler(handler | null)` — a way for a drawing tool to take a press
the engine would otherwise turn into a pan.** The engine owns the pointer surface: a press
in the plot pans, a press in the gutter scales that pane. That is right for a chart and
wrong for a tool, and the drawing model was exported to build exactly those tools with no
way to say "this drag is mine". Every tool author therefore had to stop the engine's
events from reaching them, which means the tool and the chart each hold half of one
gesture. The symptom is the series sliding while a drawing moves.

A handler is offered every press **before** the chart decides what the gesture is, and
returns `true` to take it. A claimed press is the caller's from the release down: no pan,
no zoom, no pane scale, no order drag, and no click — a press that travelled far enough to
be a pan is not also a click, and here the caller is reporting its own gesture through its
own means. The crosshair stops reading the pointer as a hover for the duration, because a
pointer placing a drawing is not hovering the chart.

The claim is tracked by pointer id rather than in the set a pan and a pinch are built from,
so a second finger during a claimed drag cannot become a pinch underneath the caller's
gesture. The cost of that is stated rather than hidden: `pointerCount` excludes a press
this handler already claimed, so a handler that wants to decline a second finger tracks its
own outstanding claim and treats the next press as a second.

**A claim cannot outlive its gesture**, which is the invariant the whole seam rests on: an
unended claim would leave a chart that cannot be panned for the rest of the session, with
nothing on screen to explain why. Release, cancel and lost capture all end it, and the
release path is the first thing the pointer-end handler does. Replacing the handler mid
gesture drops the claim, and `destroy()` drops both. A handler that throws does **not**
claim and the press is declined — reported once per distinct error — because a handler
failing on every press would otherwise leave a chart that cannot be moved at all, which is
a far worse failure than the one it was working around.

`PointerClaim` and `PointerClaimHandler` are exported as types.

**`Chart.redraw()` is public, and the documentation that already told callers to call it
was wrong.** The paint seam's documentation says a caller that has just changed its own
model calls `redraw()` — and `redraw()` was `private`, so there was no way to do it. Every
method except two carried an `assertAlive()` guard and the six drawing mutators had
recently been given one; this was the remaining reachable path with no supported way to
trigger a frame, and it is the one the drawing tools depend on.

The visible consequence was that a drawing only appeared on screen when the user happened
to pan, zoom or move the pointer, which reads as lag in the tool rather than as a missing
API. `setOverlayPainter` deliberately emits no frame, which is correct — a painter changes
nothing the engine draws — but it left a caller whose own model changed with no route to
the screen.

**It repaints; it does not recompute.** The visible candle slice, the vertical fit and the
viewport are left exactly as they are, so it is the right call after changing something the
chart did not store and the wrong call after changing something it did. Emits no event,
because nothing the chart reports has changed.

### Changed

**A pan is bounded, a drawing is not, and the difference is now documented rather than
worked around.** A pan holds the view to half a plot width of slack past either end, which
is deliberate: it turns "I have scrolled the data off the screen" into a dead end
`scrollToRealtime()` undoes. It is also why a drawing whose anchor sits in empty space
cannot be reached by dragging to it. The two answer different questions — a gesture is a
user acting on the chart, content is content the caller owns and may place anywhere — and
the answer is `setVisibleLogicalRange`, which already honours a range past the series in
both directions while holding to the same bound so an ask and a gesture cannot disagree.
The contract now says so, under a heading of its own.

### Fixed

**Overlays were reduced over the whole retained series on every frame, so a chart with many
indicators missed the frame budget at 50,000 bars and ran out of memory at a million.** The
candle path was culled to the visible window; the overlay path was not. Every frame, for
every overlay, the engine re-reduced the entire series and uploaded all of it, including
the tens of thousands of bars scrolled off the left edge that the GPU clips anyway.
`uploadVisibleOverlays` passed `candlePyramid.candleCount` as the range, in the same method
that had computed the visible window for the candles thirty lines earlier; one argument
was the whole difference.

Per frame, 32 indicators, 800 bars on screen: **11.7 ms to 0.47 ms at 50,000 bars.** The
before figure was one frame from missing 60 Hz, and **over** it at 16.5 ms once a quarter of
the indicators carried a per-point colour — the MACD-histogram case, which the engine's own
overlay contract names as the reason per-point colour exists. At 1,000,000 bars the old path
exhausted the heap, since 32 coloured overlays at full width is 3.9 GB of colour buffers;
it now costs 0.50 ms. Measured through a real `Chart` on the headless harness, both
directions, in `PERFORMANCE.md`.

The fix is a culled range, and it is free: the work is the same reduction over a narrower
window, and the emitted buckets are the same buckets the full reduction produced, in the
same order, with the same values. Three properties are asserted rather than assumed — a
culled reduction is a contiguous slice of the full one at every factor, the range is
clamped to the covered window and widened by a bucket at each end so an overlay entering
from off-screen still reaches the plot edge, and a trimmed series still buckets on the
absolute grid. That first one is the test that would catch a cull silently shifting an
indicator off the candles it annotates. Six of the eight new tests fail against the old
code.

The output buffer is sized from the emitted window rather than from the series length, since
allocating a full-length buffer per overlay per frame would leave the O(history) cost on
the allocation side after removing it from the write side.

## v1.1.0

Released: 2026-09-28

A Canvas2D fallback, a public seam for content the engine does not own, an incremental
indicator path, and two O(n) operations on the retention path taken to O(1). No export,
option or event field was removed or repurposed.

### Added

**`Chart.setOverlayPainter(painter)` — the engine's one drawing surface.** A charting
engine draws candles, axes, grids and the decorations it is told about. It does not draw
trend lines, Fibonacci levels, order blocks, or an application's own overlays, and there
was no way for an application to draw them: the pieces a drawing layer needs all existed
inside the engine and none of them were reachable together. The callback runs once per
frame on the UI layer, which sits over the candles and under the crosshair, and receives
a `PaintContext` carrying the layer's 2D context already scaled to CSS pixels, the plot
rect, every pane's rect, and projections in both directions. The crosshair is drawn after
the callback returns, so a crosshair stays legible over a filled rectangle without the
painter knowing anything about it. A callback that throws is reported once per distinct
error and the frame still completes; it is dropped on `destroy()`.

**`Chart.drawingProjector(pane?)` and `Chart.drawingUnprojector(pane?)`.** The other half
of that seam. A hit test or an editor outside the engine needs the same projection the
painter draws with, and the model's geometry functions take their projections as
arguments — but there was no way to obtain one, so the drawing model was unreachable from
outside despite the pieces being public. Both are pane-aware, because a series anchored in
a sub-pane is in that pane's units and not in prices.

**`Chart.appendOverlayValue(id, time, value, color?)`, `updateOverlayValue(...)` and
`appendOverlayValues(id, points, color?)`.** The O(1) path for feeding an indicator on a
live feed. `setOverlays` re-validates every point of every overlay and reallocates a
full-length buffer, so feeding it one value per tick is quadratic in the number of
values: 27 ms for a thousand, 85 ms for two thousand, 391 ms for four thousand, and
quadrupling with every doubling from there. `appendOverlayValue` is about 4 µs per value
and flat. `updateOverlayValue` is the other half of a live feed, revising the value on a
bar that is still forming, and is a separate method because a revision is expected to
land on a bar the overlay already covers while an append is expected to extend the
window. `appendOverlayValues` takes a catch-up batch with one viewport update rather
than one per value. Timestamps must still be a real candle's: snapping would let a
misaligned indicator look right, which is the rule `setOverlays` already enforces.

**The drawing model is exported rather than only reachable internally** — `hitTestDrawings`,
`getDrawingHandles`, `createDrawingFromGesture`, `createOrderFromDrawing`,
`canTransitionOrder`, `validateDrawings` and `DRAWING_TYPES`, with `DrawingOrderHitResult`
and `DrawPointProjector` as types. These are the renderer-agnostic half of a drawing
layer: geometry, hit testing, validation and the order state machine. They take their
projections as arguments and know nothing about this engine's internals. What is *not*
exported is any drawing rendering; that is the paint seam above. `PanesOptions` and
`VolumeOptions` are also exported now, having been reachable only structurally.

**`Chart.getPlotRect()`**, and `PlotRect` as an exported type. The region the series is drawn
into, in CSS px from the container's top-left — the canvas minus the price gutter and the
time-axis strip. `x = 0` in element coordinates is inside the price labels, not at the first
bar, so every hit-test, clamp and overlay a caller writes has to know where the data starts
and there was no way to ask. Returned by value, so writing to it cannot move the plot.

**`Chart.setVisibleLogicalRange(range)`**, the counterpart to the existing
`getVisibleLogicalRange()`. The only public way to place the viewport, and the one that was
missing: the complete list of mutators had no way to set a range, so a saved view could be
read but never restored. Sets position *and* bar spacing, because honouring a range that does
not fit at the current spacing is impossible and quietly showing a different range than the
one asked for is worse than not honouring it.

**A range past the data is honoured, and that is the point.** `from` may be below zero and
`to` above the candle count; outside the series the index axis continues at one bar per slot.
Drawing tools want somewhere to put a projection, and a viewport that can only be moved by
gesture is not one the caller owns. Held to the same bound as a pan, so an ask and a gesture
cannot disagree; throws on a non-finite or empty range, matching `setPriceRange()`.

**`crosshair.readoutBorderColor`**, a border colour for the OHLC panel that is its own option
rather than borrowed. Unset, the panel takes the candle's direction colour — a *data* colour
doing a *chrome* job, so the frame changes meaning with whatever the pointer is over, and on
a light theme it reads as an error state. It also could not be themed without recolouring the
candles, which is the one thing that must not double as UI.


### Fixed

**Overlay values were not shifted when history was trimmed, so every overlay on a chart
that reached its retention cap was drawn on the wrong bars.** The candles moved left and
the values did not, so an EMA lagged the price it annotates by exactly the trim count from
the first frame. There is no other symptom: the values are valid numbers on valid
ordinals, they are just the wrong ones, and the result reads as a stale indicator rather
than as a defect. Nothing in the engine can catch it, because nothing else in the engine
knows what a value is *for*. The values and their per-point colours now move with the
candles, and an overlay whose whole window has been trimmed away reports nothing rather
than leaving values behind to be drawn against bars they have nothing to do with.

**Drawings were never rendered, and `hitTestDrawings` was imported and never called.**
`emitDrawings` was a `redraw()`, so every call to a drawing method repainted three layers
to produce a pixel-identical frame, and the engine could not hit-test a drawing at all.
The store is now the engine's and painting is the caller's, through the paint seam above,
so the same call is what gets a drawing onto the screen. The geometry functions were
correct and are now reachable; five defects in them are fixed under *Changed* below.

**`updateOrderStatus` ignored the order state machine.** `ORDER_TRANSITIONS` declares
`filled`, `cancelled` and `rejected` terminal, and the chart validated only that the
requested status was one of the four names — so a filled order could be handed back to
`working`, and a cancelled one to `filled`. The machine existed, was tested, and was not
consulted from here: the only place it ran was inside `transitionOrder`, which nothing in
the class called. An illegal transition now leaves the order alone rather than throwing,
because a caller observing a rejection usually has a stale view and a race is not a
reason to crash a trading screen. Re-sending the status an order already has is a no-op.

**`destroy()` left three of its six subscriber sets in place.** Order, drawing/order
interaction and pane-range handlers survived, so a handler closure pinning a DOM node or a
drawing stayed reachable from a destroyed chart — while the comment above them claimed
every subscriber was dropped. The six drawing and order mutators also lacked the
`assertAlive()` guard the rest of the API has, so a chart torn down mid-gesture still
mutated state and still called live handlers. A gesture is asynchronous, so that is
ordinary use rather than misuse.

**`setDrawings` accepted anything.** It was the only bulk-ingest path in the library that
did not validate: no duplicate-id check, no finiteness check on an anchor, no check that
the point count suits the declared type, no bounds on `opacity` or `lineWidth`. A NaN
anchor projects to NaN and so fails every bounds check and every hit test silently rather
than visibly. `validateDrawings` refuses the whole set before anything is replaced, as
`setOrders`, `resolveOverlays`, `resolveZones` and `resolvePriceLines` already did.

**A drawing handed to a subscriber was the chart's live object.** `getDrawings()` cloned
each drawing and its points; the create, select and deselect events passed the live
instance out by reference. A subscriber could write `drawing.points[0].value` and move a
drawing on screen with no `redraw()` and no notification. Cloned now, on both paths.

**Session breaks in `proportional` mode compounded their own budget scale.** Each append
recovered the widths of existing breaks from the table, which already held *capped*
widths, and capped them again. Every append tightened the cap a little and shrank every
earlier break by the same little, so the gaps under the crosshair decayed geometrically
and a live proportional chart stopped showing session breaks a few minutes into a
session. The scale now travels with the table.

**A retention trim renumbered every session break in a retained series.** The incremental
slot append took its length from a *post-trim* times array while the existing table was
*pre-trim*, so pre-trim break indices were written into a post-trim table and every
break in the series shifted left by the trim count on each append. The length is now
derived from the table, so the two cannot disagree.

**Vertical grid lines stopped at the newest candle, so grid cells never closed in empty
space.** Reported as "the horizontal lines can be seen but the vertical lines don't form and
close a grid till the candles fully close". The two directions are derived differently:
horizontal lines come from each pane's price ticks, a statement about the scale, so they
always spanned the full width; vertical lines come from the time-axis tick list, and every
tick in it named a real candle. The window was clamped to the series, and each tick was
positioned with `indexToCoordinate`, which clamps its index to the slot table — so a window in
the void produced one label, on the newest candle.

A tick now carries the **slot** it belongs on, which extrapolates past either end of the
series at one bar per slot, and both the line and its label are drawn from it. Inside the
series the slot is exactly what `indexToCoordinate` would have said, so no existing chart
moves. Two asymmetries had to go with it: `barsBeforeSlot` extrapolates for a break-free
series and clamps for a gapped one, so the empty space was labelled on a continuous chart and
not on one with an overnight break in it — the difference being whether the instrument trades
overnight, which is what makes a code branch look like a data bug.

**The time axis repeated the date on every label.** A five-minute chart read `Sep 1, 09:35 AM
Sep 1, 09:40 AM Sep 1, 09:45 AM` and, being far wider than the space between labels,
overprinted itself into a row of clipped half-dates. Only a label that changes the coarse
part carries it now — the date on a minute-level axis, the month on a day-level one, the year
on a monthly one — with the first label in view always full so a view opening mid-day still
says what day it is. A label whose box would reach back into the previous one is dropped
rather than overprinted.

**Panning was unbounded in both directions.** The drag and pinch paths added a pointer delta
to the view offset with nothing bounding them, so the chart could be flung arbitrarily far
into empty space. The right-hand case is the one that hurt: flinging past the newest candle
clears the live-edge latch, the feed carries on appending into a window nobody is looking at,
and the chart is indistinguishable from a dead one until someone calls `scrollToRealtime()`.

The bound is **half the plot width** of slack past either end, in slots — a plot fraction
rather than a bar count, which is load-bearing. The first attempt used one bar and the
browser harness caught it: a 220px drag moved the series 11.76px, because the chart had
stopped following the pointer. A trading chart that does not track 1:1 cannot ship.

A **zoom is deliberately not bounded.** It is anchored on the bar under the pointer, so it
cannot throw the view where the user is not already pointing; clamping it would only pull
that bar out from under the cursor. The bound is on the gesture and not on the view, so
appends, `fitContent()` and a live-edge re-anchor are exempt — a panned viewport is the
caller's, and a bound that moved with every appended bar would pull it sideways underneath
them.

**A collapsed container was drawn into at fallback geometry.** `clientWidth || 800` cannot
tell "not measured yet" from "measured, and it is zero", so a panel taken through zero by a
divider drag got a frame laid out for 800×500 — labels sized for a wide plot and crammed
into a fraction of it. The chart now stops drawing into a container that has been sized and
is now zero-sized, leaving the last frame on the canvas. Feeding is not skipped: appends are
applied first, so a live feed does not build a backlog behind a collapsed panel.

### Changed

**`modalInterval` is no longer derived on the render path.** It collects every gap in the
retained series and sorts it to find the median, and the time axis needs it on every frame
to pick a step from the calendar ladder. At the default 1,000,000-candle retention that is
a 32 ms sort per frame — twice the 60 Hz budget spent before any rendering happened, on
every pan, zoom, append, resize and crosshair frame. It is now derived once per data change
and handed to the axis, which invalidates it from all four paths that write timestamps.
`updateLast` deliberately does not invalidate it: a forming candle rewrites OHLC and moves
no timestamp, and a live feed calls it on every tick.

**`OHLCPyramid.trimStart` is O(1) amortised rather than O(n).** It allocated a fresh
buffer, shifted the tail into it, subtracted the trim count from every x, and rebuilt every
level from scratch — four O(n) passes and two O(n) allocations, on every append batch that
arrives while the series sits at its retention cap, which on a live feed is every batch.
Measured at 1,000,000 bars: **34.9 ms to 0.005 ms**. It is now flat from 50,000 to
1,000,000 bars, which is the property rather than the number: a trim advances a per-level
window and recomputes only the one bucket per level that straddles the cut. A level is
rebuilt solely when the trim exceeds that level's group size, which bounds the rebuilds to
the size of the trim rather than the size of the series.

Two consequences are worth stating because they are visible in the diff. `CANDLE_X` is now
an **absolute** source-bar ordinal that is never rebased — rebasing is the O(n) pass — and
the pyramid assigns it rather than accepting it, so there is no second source of truth for
a coordinate a trim would otherwise rewrite on every bar. And the reduction grid is **not
re-cut on a trim**: bucket `b` at level `L` still covers absolute bars
`[b·2^L, (b+1)·2^L)`, holding only the part of that group still retained. Re-cutting is
precisely the re-aggregation being avoided. Candles, volume and overlays all reduce on that
grid, and `bucketCentreSlot` takes the base so the two cannot disagree — a chart that
panned after a trim would otherwise show a whole bucket of drift between an indicator and
the price it annotates.

**The drawing hit test honours its documented priority.** The three passes each kept the
nearest candidate by distance alone, and the body pass ran last, so a rectangle body 1px
from the pointer could displace a drag handle 7px away — inverting the priority for exactly
the case it exists to resolve. Rank now precedes distance. A handle's own `size` is also a
floor on its capture radius, rather than the size being decorative; a rectangle reports
distance to its outline rather than to its centre, which is the measure that means the same
thing for every shape and is comparable across them; a fib retracement has a body hit test
at all, where before it was ungrabbable once deselected; and a trend line's move handle sat
exactly on top of its resize-end handle, because the index midpoint of two points is the
last point, so a two-point trend line could never be picked up to move.

**Each Fibonacci level is now individually addressable.** Seven level handles shared one
role name, and the role is not a unique identifier, so a handle hit could not be turned back
into "drag the 0.618 line". `DragHandle.index` and `DrawingOrderHitResult.handleIndex`
carry it. A Fibonacci's levels are also interpolated onto the candle grid when the caller
supplies a mapping, rather than linearly in wall-clock time — the horizontal axis is candle
ordinals with closed intervals compressed out, so a linear time split lands between buckets
and, across a session break, in dead air.

**A null projection is skipped rather than dereferenced** by the drawing hit test. A
timestamp inside a session break projects to the nearer of the two bars bounding it, not to
`null` — snapping is what keeps a line drawn from Friday to Monday connected to the candles
it annotates — but a caller with its own transform is free to answer `null` for a time it
cannot place, and the model used to take the whole hit test down with it.

**The floating OHLC panel and the last-price tag are off by default.** Both were drawn unconditionally and neither could be removed: `crosshair.visible: false` took the crosshair lines, the panel and both gutter tags together, and the last-price tag had no option at all. They are UI, and a chart library's job is to report state, so they are now `crosshair.readout` and `candlestick.lastPriceTag`, both defaulting to `false`. A caller who wants one reads `crosshairMove` — which carries the whole `candle` — or `getLastCandle()`, and draws it in their own components.

This is a visible change: upgrading removes both. It is listed here rather than buried because the panel has been in every screenshot anyone has looked at.

The crosshair lines and the price and time tags in the gutters are **not** affected. They label the crosshair's own position and are part of the crosshair rather than the readout.

**`candlestick.lastPriceTag: false` also stops the tag reserving space on the axis.** The tag competes with price-line labels and wins, so leaving it in the layout while not drawing it would keep a caller's own price line from getting its label. The side effect is that a price line sitting at the newest close now keeps its axis label, where before the tag took the space.

**`priceFormat.precision` is a fixed number of fraction digits rather than a maximum**, so
`100` reads `100.00` and `100.1` reads `100.10`. A price axis where `100` sits beside
`100.1` and `763.25` makes the reader count decimals to find the tick spacing, which is the
one job an axis has. It also makes the float artefacts unreachable: tick values come out of
the tick arithmetic as doubles, so `100.1000001` was displayed whenever the configured
precision was wide enough to show it.

**If you are seeing seven decimals, something set `precision` to seven.** The default is `2`
and a chart at the default now reads `100.10`.

### Verification

472 unit tests (268 at v1.0.2), 29 browser interaction invariants and 10 packaging
checks, all from one `npm run verify`.

The browser harness reports 28 of 29. The one failure is a pre-existing theme contrast
issue on the price-axis chips — a worst pair of 1.06:1, which is a legibility problem
rather than a logic one — and it was confirmed against a pristine checkout of the
preceding commit before any of this work began, so it is not a regression from it. It
will fail a build server that enforces the interaction harness, and it is worth fixing
separately.

The work above was measured rather than assumed, and two of the three performance numbers
came from a finding that reversed the plan. `trimStart` was assumed to be one of three
roughly equal O(n) operations; isolating each showed it was 96% of the retention cost and
the other two together were under half a millisecond at the benchmark's retention level.
The reduction grid not re-cutting on a trim is a semantic change that reaches the draw
path, the overlay bucketing and the slot conversion, and is the reason the grid is stated
as a tested contract rather than compared against a rebuild: a rebuild *does* re-cut, so
comparing against one asserts the opposite of what was intended.

The tests that caught the most were the ones asserting properties rather than examples.
`assertLevelsAggregateTheAbsoluteGrid` derives each bucket's expected aggregate from the
source bars and the grid, rather than from a second implementation, and it found four
distinct defects: a level read before it was materialised, a sign error in the window
shift, empty buckets surviving a trim to empty, and an append silently dropped because a
capacity check was given a count where a position was needed. The last is the one worth
remembering — a `Float32Array` write past the end is a no-op rather than a throw, so a
capacity check that is off by a shift loses data without saying so.

The incremental overlay tests assert equivalence with `setOverlays` bar for bar, and that
both paths reject a misaligned timestamp the same way. A faster approximation of the
batch path would have satisfied a weaker test and produced an indicator that draws
differently depending on how it was fed, which is the hardest kind of defect to find.

## v1.0.2

Three defects on paths that had no test, and one addition. None is a change of contract: no
export, option or event field was removed or repurposed, one field was added to an existing
payload, and every "fix" below is a path doing the thing the rest of the engine already did.

### Added

**`VisibleRangeEvent.atRealtime`**, and `isAtRealtime()` / `scrollToRealtime()` documented
and pinned as public. A chart that has been panned takes its view over while the feed keeps
appending into it, and from outside the chart that is indistinguishable from a feed that has
stopped — a chart twenty-six bars behind reads as frozen. The event now says which state it
is in, so a `LIVE` badge, a jump-to-latest button and a dimmed newest-price tag are all
consequences a caller can derive.

The chart draws nothing about it. No badge, no banner, no element of its own and no text it
chose: a charting library that renders its own chrome is one every application has to fight,
so the library reports a boolean and the caller's UI decides what that looks like.

The field rides on the events that were already firing rather than adding any, so *when* the
event fires is unchanged. The `followsLiveEdge` latch moves in exactly three places — a pan
away from the edge, `fitContent()` and `scrollToRealtime()` — and each of those changes which
bars are on screen, which was already a reason to notify. So there is no transition the field
can report that the existing firing rule does not cover, and no way for it to go stale
between events. A chart with no data reports `true`: there is no state to be behind.

### Fixed

**Switching back to a candle style no longer leaves the previous style on the GPU.** The
data layer holds each series in a persistent buffer and empties it only when told to, and
the two directions of the style switch were not symmetric: moving *to* a line cleared the
candle series, and moving *back* cleared nothing. A chart switched from `area` to
`candlestick` therefore kept drawing the fill and the polyline it was drawn on top of,
which reads as a fault in the candles rather than as a style that was never switched off.
`candlestick`, `hollow`, `ohlc` and `baseline` all share the branch and are all fixed.

The rule is now the one the renderer already implies, and it is worth stating because it
is what was half-implemented: `drawCandlesticks`, `drawLine` and `drawArea` each *replace*
the pass list of the series they draw, so the only geometry that can survive a frame is
geometry belonging to a series that frame never drew. Anything not drawn is now cleared
explicitly, and the full six-by-six style matrix is asserted against that rule rather than
against a list of the transitions that happened to be tried.

**A live feed that crosses a session break kept up with it.** The slot table is the one
place that knows where the whitespace is, and it was rebuilt on `setData`, on
`applyOptions` and on the replace path — but not when bars were appended. So on a feed the
table went on describing the series as it was at the first snapshot, and everything that
reads it clamps to its length:

- the visible-window cull stopped at the last bar the table knew about, so `getVisibleLogicalRange()`
  reported `48..120 of 124` while the array went on growing;
- the axis ticks stopped one bar *later* rather than one bar earlier, because
  `barsBeforeSlot` answers "one past the last bar whose left edge is before this slot" and
  a slot past the end of a stale table lands it one bar too far — the surplus ticks then
  bunched against the right-hand edge;
- with no breaks in the series at all, the table was `null` rather than stale, so the
  chart silently fell out of slot space and drew in ordinals, putting the new bars off
  the right side of the plot.

The shift that follows the live edge was also measured in bars, which is the same number
only while bars are adjacent. A chart following the feed drifted by the whole of each
break, and a panned chart saw the bar under the crosshair slide out from under the
pointer, by half a session for every close it lived through. Both are now in slots, and
the follow case recomputes the live edge from the rebuilt table rather than shifting by
the width that was added, so it self-corrects after a resize instead of compounding.

The rebuild runs only when bars were appended, never for a bare `updateLast`. The table is
O(n) in the length of the series and a live feed calls `updateLast` on every tick, so
rebuilding a million-bar table at ten hertz to accommodate a price change that moved no
timestamp would have been a far worse defect than the one being fixed.

### Verification

268 unit tests (254 at v1.0.1), 21 browser interaction invariants and 10 packaging checks,
all from one `npm run verify`. Every fix above was reverted to confirm its new tests fail
against the old code — the three fixes took 3, 3 and 1 failing tests respectively, and the
addition took 0 because it is an addition.

Two of those regressions are worth keeping in mind when reading the diffs. The data-layer
test double records candle *records* rather than their length, which is the assertion surface
the slot work lives on; before that it recorded a number that said nothing about where the
bars were, and that one gap is why six defects reached a suite that was otherwise thorough.
And the style-switch tests state a rule — every series the next style will not draw has to be
cleared — rather than a list of the transitions somebody happened to try, because a missing
edge is only ever found by a rule.

## v1.0.1

The session-break slot seam, repaired. Six shipped defects, five of them one
family: somewhere a bar was turned into a pixel with index arithmetic where the
axis is in slots, so the chart drew its candles, its overlays, its axis, its own
reported range and its fit in five slightly different places.

No breaking change. No export, option, event payload or documented convention
changed. One public method added, and one documented meaning clarified. The
version moves by a patch because two fixes change an observable value for
existing code, which a patch release is the right home for — both were enforcing
what the contract already promised rather than redefining it.

### Fixed

**A bar's centre is now a bar, not a bar plus half the following break.**
`indexToCoordinate` returned the midpoint between a bar's left edge and the next
bar's left edge, which is a bar plus half the break. The last candle of a session
was therefore drawn half a gap into the whitespace, and anything anchored to it —
an overlay, a crosshair, a caller's own drawing — drifted with it. A bar is one
slot wide and the whitespace belongs to the bar *after* the break, which is what
the slot model has specified since it shipped. This is the only fix here that
changes a value existing code can read: the contract already promised "screen x
of a candle index", and the old answer was not that.

**Chart instances now isolate their `sessionBreaks` configuration.** The resolved
defaults were built with a shallow spread of the time scale, so every options
object shared one nested `sessionBreaks` with the module-level defaults — and
`applyOptions` merges that block field by field *in place*, because it is a patch
and writes into whatever object it is handed. Configuring the gaps on one chart
rewrote the defaults for every chart created afterwards in the same process. On a
page with two charts, the first turning session breaks off silently turned them
off for the second, and for a third that never mentioned them.

**The time axis no longer stops at the first session break.** Ticks were stepped
in slots, and a slot inside a break resolves to the bar before it, so two ticks
in the same break produced the same x and tripped the loop's exit for "x stopped
advancing". Labels and vertical grid lines were drawn for the first session and
never again. Ticks are now chosen in bar-index space, in a pure module so they
are testable at all, and aligned to a time ladder, so labels read as 10:00 rather
than 10:07 and every label sits on a real candle rather than on an instant the
market was shut.

**Candles at aggregated zoom levels no longer drift into the gaps.** The pyramid
produced buckets in ordinal space while the shader transformed slots, so each
candle was drawn short by the sum of the breaks before it — an error that grows
rightward and is worst exactly where the gaps are. Overlays were already mapped
through the slot table and the candles were not, so at an aggregated level the
two sat a whole gap apart. Both now go through one conversion, which is also what
keeps the pyramid index-space end to end; that in turn repairs `trimStart`, whose
re-basing of level 0 by the trimmed count was only ever right in index space.

**`fitContent` no longer drops part of a series with gaps.** It divided the plot
width by the bar count, so a spacing wide enough for the bars left the whitespace
nowhere to go. The overflow hung off the left edge, where no caller can scroll
to it: 150 of 600 bars simply absent on a three-session chart, silently. It now
fits the slot count.

### Added

**`coordinateToSlot(x)`** — the sub-bar precision `coordinateToIndex` rounds away,
for hit-testing within a candle. A whole index answers "which candle is under the
pointer", which is what a tooltip wants; a drawing layer wants "where in that
candle", and a trend line grabbed at a bar's left edge and one grabbed at its
right edge are the same point to `coordinateToIndex` and different points here. It
returns a slot rather than a fractional index, because the two stop being
interchangeable the moment a break is in the series, and it is not clamped so a
caller can tell that a pointer is outside the plot. There is deliberately no
public inverse yet: a caller anchoring to a bar has `indexToCoordinate`, and a
caller anchoring between bars interpolates, which is exact because the transform
is affine in slots.

### Clarified

**`getBarSpacing()` returns pixels per slot, not pixels per candle index.** The
two are the same number only while bars are adjacent. Code multiplying it by
`candleCount` to get the width of a series overstates that width by the whole of
its whitespace. Use `indexToCoordinate` on the first and last index instead.

### Investigated, unchanged

**The visible-window cull was audited and needed no change.** `coordinateToIndex`
reads like a raw affine inverse and was assumed to be one; its body resolves
through the slot table and was already correct, so the first guess at a fix would
have introduced a regression rather than removed one. Confirmed by reverting the
other fixes and watching the drawn slice still cover every bar on screen. It is
recorded here because "looked broken, was not" is worth as much to the next
reader as the fixes, and because the name invites the same wrong assumption again.

### Verification

254 unit tests (231 at v1.0.0), 21 browser interaction invariants and 10
packaging checks, all from one `npm run verify`. Every fix above was reverted to
confirm the new tests fail against the old code, and the data-layer test double
now keeps the candle records rather than their length, which is the assertion
surface all of this lives on.

## v1.0.0

The first frozen contract. Session breaks in slot space, per-pane vertical
scales, panes, overlays, decorations and a dual ESM/CJS package. See the `v1.0.0`
tag annotation for the full account of the design and of the seams that made a
silent disagreement visible.
