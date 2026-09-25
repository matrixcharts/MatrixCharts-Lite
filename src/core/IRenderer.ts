// src/core/IRenderer.ts

export interface IRenderer {
    /** Initializes the rendering context on the provided canvas */
    init(canvas: HTMLCanvasElement): void;
    
    /** Clears the canvas for the next frame */
    clear(): void;
    
    /** Draws the queued operations to the screen */
    render(): void;
    
    /** Cleans up memory and buffers when the chart is destroyed */
    destroy(): void;
}