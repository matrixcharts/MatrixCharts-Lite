import type { CandleData } from '../core/CandleData.js';
export type CandleFeedMessage = {
    type: 'snapshot';
    sequence: number;
    candles: readonly CandleData[];
} | {
    type: 'append';
    sequence: number;
    candles: readonly CandleData[];
} | {
    type: 'update';
    sequence: number;
    candle: CandleData;
} | {
    type: 'heartbeat';
    sequence: number;
};
export type CandleSourceState = 'idle' | 'connecting' | 'connected' | 'resyncing' | 'reconnecting' | 'disconnected' | 'error';
export interface CandleSource {
    readonly state: CandleSourceState;
    subscribe(onMessage: (message: CandleFeedMessage) => void, onStateChange: (state: CandleSourceState) => void): () => void;
    start(): void;
    stop(): void;
    requestSnapshot?(reason: string): void;
}
/** Operational counters for a feed controller, suitable for telemetry or replay UIs. */
export interface FeedDiagnostics {
    received: number;
    applied: number;
    rejected: number;
    lastSequence: number | null;
    lastMessageType: CandleFeedMessage['type'] | null;
    lastError: string | null;
}
export interface CandleTarget {
    setData(candles: readonly CandleData[]): void;
    replaceData(candles: readonly CandleData[]): void;
    appendBatch(candles: readonly CandleData[]): void;
    updateLast(candle: CandleData): void;
}
//# sourceMappingURL=CandleSource.d.ts.map