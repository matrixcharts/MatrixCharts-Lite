// src/core/IRenderer.ts

export interface IRenderer {
    init(canvas: HTMLCanvasElement): void;
    resize(width: number, height: number, dpr: number): void;
    setViewport(offsetX: number, offsetY: number, scaleX: number, scaleY: number): void;
    clear(): void;
    render(): void;
    destroy(): void;
}