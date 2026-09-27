# Changelog

Notable changes to MatrixCharts, newest first. The frozen v1 public surface and
its reasoning live in [docs/v1-contract.md](docs/v1-contract.md); this file
records what moved and why, per release.

## Unreleased

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
