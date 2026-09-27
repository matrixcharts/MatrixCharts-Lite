# Changelog

Notable changes to MatrixCharts, newest first. The frozen v1 public surface and
its reasoning live in [docs/v1-contract.md](docs/v1-contract.md); this file
records what moved and why, per release.

## Unreleased

Three defects on paths that had no test, three additions, and one behaviour change to an
existing option. No export, option or event field was removed or repurposed.

### Added

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
