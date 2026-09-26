// src/core/EventEmitter.ts

export interface ChartEvents {
    'viewport': { offsetX: number; offsetY: number; scaleX: number; scaleY: number };
    'data': { ohlc: Float32Array; times: readonly number[] };
    'theme': 'dark' | 'paper';
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