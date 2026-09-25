// src/core/Chart.ts
import type { IRenderer } from './IRenderer';
import { WebGL2Renderer } from '../renderers/WebGL2Renderer';
import { Canvas2DRenderer } from '../renderers/Canvas2DRenderer';

export class Chart {
    private container: HTMLElement;
    private canvasWrapper: HTMLDivElement;
    private resizeObserver: ResizeObserver;
    
    // Store your active renderers
    private renderers: IRenderer[] = [];
    private isDragging: boolean = false;
    private lastMouseX: number = 0;
    private offsetX: number = 0;
    private scaleX: number = 1;

    constructor(containerId: string) {
        const el = document.getElementById(containerId);
        if (!el) throw new Error(`MatrixCharts: Container '${containerId}' not found.`);
        this.container = el;

        this.canvasWrapper = document.createElement('div');
        this.canvasWrapper.style.position = 'relative';
        this.canvasWrapper.style.width = '100%';
        this.canvasWrapper.style.height = '100%';
        this.container.appendChild(this.canvasWrapper);

        // Initialize layers
        const gridCanvas = this.createLayer(0);
        const dataCanvas = this.createLayer(1);
        const uiCanvas = this.createLayer(2);

        // Layer 0: Background Grid
        const gridRenderer = new Canvas2DRenderer(true);
        gridRenderer.init(gridCanvas);
        this.renderers.push(gridRenderer);

        // Layer 1: GPU Data
        const dataRenderer = new WebGL2Renderer(); 
        dataRenderer.init(dataCanvas);
        this.renderers.push(dataRenderer);

        // Layer 2: UI Overlay
        const uiRenderer = new Canvas2DRenderer(false);
        uiRenderer.init(uiCanvas);
        this.renderers.push(uiRenderer);

        // Bind the resize observer to the wrapper
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                this.handleResize(width, height);
            }
        });
        
        this.resizeObserver.observe(this.canvasWrapper);
        this.bindEvents();
    }

    private createLayer(zIndex: number): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.transformOrigin = 'top left';
        canvas.style.pointerEvents = zIndex === 2 ? 'auto' : 'none'; // Top layer catches mouse events
        canvas.style.zIndex = zIndex.toString();
        this.canvasWrapper.appendChild(canvas);
        return canvas;
    }

    private handleResize(width: number, height: number): void {
        if (width === 0 || height === 0) return;
        
        const dpr = window.devicePixelRatio || 1;
        
        // Broadcast the resize and new DPR to all rendering engines
        for (const renderer of this.renderers) {
            renderer.resize(width, height, dpr);
        }
        
        // Trigger a complete redraw of the chart
        this.redraw();
    }

    private redraw(): void {
        for (const renderer of this.renderers) {
            renderer.clear();
            renderer.render();
        }
    }

    private bindEvents(): void {
        this.canvasWrapper.addEventListener('mousedown', this.handleMouseDown);
        window.addEventListener('mouseup', this.handleMouseUp);
        window.addEventListener('mousemove', this.handleMouseMove);
        this.canvasWrapper.addEventListener('wheel', this.handleWheel, { passive: false });
    }

    private handleMouseDown = (event: MouseEvent): void => {
        this.isDragging = true;
        this.lastMouseX = event.clientX;
    };

    private handleMouseUp = (): void => {
        this.isDragging = false;
    };

    private handleMouseMove = (event: MouseEvent): void => {
        if (!this.isDragging) return;

        const deltaX: number = event.clientX - this.lastMouseX;
        this.lastMouseX = event.clientX;
        this.offsetX += deltaX;
        this.updateViewport();
    };

    private handleWheel = (event: WheelEvent): void => {
        event.preventDefault();

        const zoomFactor: number = event.deltaY > 0 ? 0.9 : 1.1;
        this.scaleX *= zoomFactor;

        const rect: DOMRect = this.canvasWrapper.getBoundingClientRect();
        const mouseX: number = event.clientX - rect.left;
        this.offsetX = mouseX - (mouseX - this.offsetX) * zoomFactor;
        this.updateViewport();
    };

    private updateViewport(): void {
        for (const renderer of this.renderers) {
            renderer.setViewport(this.offsetX, 0, this.scaleX, 1);
        }
        this.redraw();
    }

    public destroy(): void {
        this.canvasWrapper.removeEventListener('mousedown', this.handleMouseDown);
        window.removeEventListener('mouseup', this.handleMouseUp);
        window.removeEventListener('mousemove', this.handleMouseMove);
        this.canvasWrapper.removeEventListener('wheel', this.handleWheel);
        this.resizeObserver.disconnect();
        for (const renderer of this.renderers) {
            renderer.destroy();
        }
        this.container.innerHTML = ''; // Clean up DOM
    }

    public testDrawWebGLData(): void {
        const dataRenderer = this.renderers[1] as WebGL2Renderer;
        
        const points = new Float32Array(20000); 
        for (let i = 0; i < 10000; i++) {
            const x = (i / 10000) * 800;
            const y = 250 + Math.sin(i * 0.05) * 100;
            points[i * 2] = x;
            points[i * 2 + 1] = y;
        }
        
        dataRenderer.drawLine(points, [0.0, 1.0, 1.0, 1.0]);
        this.redraw();
    }

    public testDrawWebGLCandlesticks(): void {
        const dataRenderer = this.renderers[1] as WebGL2Renderer;
        const candleCount: number = 70;
        const candles: Float32Array = new Float32Array(candleCount * 6);
        let randomState: number = 0x6d2b79f5;
        let previousClose: number = 250;
        const nextRandom = (): number => {
            randomState = (randomState * 1664525 + 1013904223) >>> 0;
            return randomState / 4294967296;
        };

        for (let candleIndex: number = 0; candleIndex < candleCount; candleIndex++) {
            const x: number = 24 + candleIndex * 11;
            const gap: number = (nextRandom() - 0.5) * 10;
            const open: number = Math.max(60, Math.min(440, previousClose + gap));
            const directionalMove: number = (nextRandom() - 0.48) * 22;
            const close: number = Math.max(60, Math.min(440, open + directionalMove));
            const upperWick: number = 5 + nextRandom() * 14;
            const lowerWick: number = 5 + nextRandom() * 14;
            const high: number = Math.min(470, Math.max(open, close) + upperWick);
            const low: number = Math.max(30, Math.min(open, close) - lowerWick);
            const inputIndex: number = candleIndex * 6;
            candles[inputIndex] = x;
            candles[inputIndex + 1] = open;
            candles[inputIndex + 2] = high;
            candles[inputIndex + 3] = low;
            candles[inputIndex + 4] = close;
            candles[inputIndex + 5] = 7;
            previousClose = close;
        }

        dataRenderer.drawCandlesticks(
            candles,
            [0.1, 0.85, 0.55, 0.9],
            [0.95, 0.25, 0.35, 0.9],
        );
        const uiRenderer = this.renderers[2] as Canvas2DRenderer;
        uiRenderer.setOHLCData(candles);
        this.redraw();
    }
}