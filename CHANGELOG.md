# Changelog

Notable changes to MatrixCharts, newest first. The frozen v1 public surface and
its reasoning live in [docs/v1-contract.md](docs/v1-contract.md); this file
records what moved and why, per release.

## Unreleased

Nothing yet.

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
