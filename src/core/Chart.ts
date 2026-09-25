// src/core/Chart.ts

export class Chart {
    private container: HTMLElement;
    private canvasWrapper: HTMLDivElement;
    
    // The three hybrid layers
    private gridCanvas: HTMLCanvasElement;
    private dataCanvas: HTMLCanvasElement;
    private uiCanvas: HTMLCanvasElement;

    constructor(containerId: string) {
        const el = document.getElementById(containerId);
        if (!el) throw new Error(`MatrixCharts: Container '${containerId}' not found.`);
        this.container = el;

        // 1. Setup the wrapper container
        this.canvasWrapper = document.createElement('div');
        this.canvasWrapper.style.position = 'relative';
        this.canvasWrapper.style.width = '100%';
        this.canvasWrapper.style.height = '100%';

        // 2. Generate the stacked canvases
        this.gridCanvas = this.createLayer(0); // Bottom: Canvas 2D
        this.dataCanvas = this.createLayer(1); // Middle: WebGL2
        this.uiCanvas = this.createLayer(2);   // Top: Canvas 2D

        // 3. Inject into the user's DOM
        this.container.appendChild(this.canvasWrapper);
    }

    private createLayer(zIndex: number): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.zIndex = zIndex.toString();
        // We disable pointer events on all canvases so we can handle custom events
        // on the wrapper later if needed.
        canvas.style.pointerEvents = 'none'; 
        this.canvasWrapper.appendChild(canvas);
        return canvas;
    }
}