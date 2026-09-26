// src/core/EventEmitter.ts
import type { CandleData } from './CandleData.js';
import type { ResolvedChartOptions } from './options.js';

export interface ChartEvents {
    'viewport': { offsetX: number; offsetY: number; scaleX: number; scaleY: number };
    /**
     * Retained candle timestamps, used by the axis renderer to label ticks. The
     * candle buffer itself is passed straight to the WebGL renderer rather than
     * broadcast, so it is not copied per frame here.
     */
    'data': { times: readonly number[] };
    /** Fully resolved options. Emitted once on construction and on every apply. */
    'options': ResolvedChartOptions;
    /**
     * Crosshair state owned by Chart. The UI layer only draws from this; it never
     * hit-tests the pointer itself, so the drawn crosshair and the public
     * crosshairMove event cannot disagree.
     */
    'crosshair': {
        x: number | null;
        y: number | null;
        time: number | null;
        candle: CandleData | null;
    };
}

type Listener<T> = (data: T) => void;

export class EventEmitter<T extends Record<string, any>> {
    private listeners: { [K in keyof T]?: Array<Listener<T[K]>> } = {};

    public on<K extends keyof T>(event: K, listener: Listener<T[K]>): void {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event]!.push(listener);
    }

    public off<K extends keyof T>(event: K, listener: Listener<T[K]>): void {
        const eventListeners = this.listeners[event];
        if (eventListeners) {
            this.listeners[event] = eventListeners.filter(cb => cb !== listener);
        }
    }

    public emit<K extends keyof T>(event: K, data: T[K]): void {
        const eventListeners = this.listeners[event];
        if (eventListeners) {
            eventListeners.forEach(listener => listener(data));
        }
    }
}
