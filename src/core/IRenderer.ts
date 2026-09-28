// src/core/IRenderer.ts
import type { EventEmitter, ChartEvents } from './EventEmitter.js';
import type { OverlayPainter } from './paint.js';

export interface IRenderer {
    init(canvas: HTMLCanvasElement, emitter: EventEmitter<ChartEvents>): void;
    resize(width: number, height: number, dpr: number): void;
    clear(): void;
    render(): void;
    destroy(): void;
}

/**
 * A renderer that can host a caller's paint callback.
 *
 * Only the UI layer satisfies this. It is the one layer with a transparent 2D
 * context that composites over the data, so it is the only place a caller's own
 * drawing can go without either repainting the candles or landing under the
 * crosshair.
 *
 * Separate from `IRenderer` rather than a method on it, because the grid and data
 * layers cannot honour it and a contract that all three must satisfy is a contract
 * two of them have to lie about. `createRenderer` is overloaded on the role, so
 * asking for `'ui'` yields this and asking for `'grid'` yields the base interface,
 * with the check made by the compiler on both sides — a test double installed as the
 * UI layer without the method is a compile error rather than a painter that silently
 * never runs.
 */
export interface IOverlayHost {
    setOverlayPainter(painter: OverlayPainter | null): void;
}