// src/core/IRenderer.ts
import type { EventEmitter, ChartEvents } from './EventEmitter';

export interface IRenderer {
    init(canvas: HTMLCanvasElement, emitter: EventEmitter<ChartEvents>): void;
    resize(width: number, height: number, dpr: number): void;
    clear(): void;
    render(): void;
    destroy(): void;
}