import type { CandleFeedMessage, CandleSource, CandleSourceState } from './CandleSource.js';
export interface CandleReplayFrame {
    message: CandleFeedMessage;
    delayMs?: number;
}
/** Deterministic feed source for incident replay, tests, and strategy review. */
export declare class CandleReplaySource implements CandleSource {
    private readonly frames;
    private messageHandler;
    private stateHandler;
    private timer;
    private cursor;
    private running;
    private currentState;
    constructor(frames: readonly CandleReplayFrame[]);
    get state(): CandleSourceState;
    get position(): number;
    subscribe(onMessage: (message: CandleFeedMessage) => void, onStateChange: (state: CandleSourceState) => void): () => void;
    start(): void;
    stop(): void;
    pause(): void;
    resume(): void;
    seek(frameIndex: number): void;
    step(): boolean;
    private scheduleNext;
    private setState;
}
//# sourceMappingURL=CandleReplaySource.d.ts.map