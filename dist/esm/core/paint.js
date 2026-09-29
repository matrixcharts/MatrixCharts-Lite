// src/core/paint.ts
//
// The engine's one drawing surface for code it does not own.
//
// A charting engine draws candles, axes, grids, and the decorations it is told
// about. It does not draw trend lines, Fibonacci levels, order blocks, magnet
// indicators, or whatever else an application layers on top. Those belong to the
// application, in the application's files, on the application's terms.
//
// That division is only real if the engine hands over a surface to paint on. The
// pieces a drawing layer needs — a context, the plot rect, and a projection from
// the engine's data space into pixels — all exist inside the engine and none of
// them were reachable together. This module is the seam: a caller registers a
// painter, the engine calls it once per frame on the layer that sits under the
// crosshair, and the caller draws whatever it likes with full knowledge of where
// every bar and every price currently is.
//
// Deliberately not a plugin system, a scene graph, or a retained-mode layer list.
// A callback and a context is the whole contract. Everything a richer design would
// add — a z-ordered object list, dirty tracking per object, a hit-test registry —
// is a decision about how drawings should behave, and that decision belongs to the
// code that owns the drawings.
export {};
