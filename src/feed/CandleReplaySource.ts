import type { CandleFeedMessage, CandleSource, CandleSourceState } from './CandleSource.js';

export interface CandleReplayFrame {
    message: CandleFeedMessage;
    delayMs?: number;
}

/** Deterministic feed source for incident replay, tests, and strategy review. */
export class CandleReplaySource implements CandleSource {
    private readonly frames: readonly CandleReplayFrame[];
    private messageHandler: ((message: CandleFeedMessage) => void) | null = null;
    private stateHandler: ((state: CandleSourceState) => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private cursor: number = 0;
    private running: boolean = false;
    private currentState: CandleSourceState = 'idle';

    public constructor(frames: readonly CandleReplayFrame[]) {
        this.frames = frames.slice();
    }

    public get state(): CandleSourceState { return this.currentState; }
    public get position(): number { return this.cursor; }

    public subscribe(
        onMessage: (message: CandleFeedMessage) => void,
        onStateChange: (state: CandleSourceState) => void,
    ): () => void {
        this.messageHandler = onMessage;
        this.stateHandler = onStateChange;
        onStateChange(this.currentState);
        return () => {
            this.messageHandler = null;
            this.stateHandler = null;
            this.stop();
        };
    }

    public start(): void {
        if (this.running) return;
        this.running = true;
        this.setState('connected');
        this.scheduleNext();
    }

    public stop(): void {
        this.running = false;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.setState('disconnected');
    }

    public pause(): void {
        this.running = false;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }

    public resume(): void {
        if (this.running) return;
        this.running = true;
        this.setState('connected');
        this.scheduleNext();
    }

    public seek(frameIndex: number): void {
        if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex > this.frames.length) {
            throw new Error('MatrixCharts: Replay frame index is out of range.');
        }
        this.pause();
        this.cursor = frameIndex;
    }

    public step(): boolean {
        if (this.cursor >= this.frames.length) return false;
        this.messageHandler?.(this.frames[this.cursor++].message);
        return true;
    }

    private scheduleNext(): void {
        if (!this.running || this.cursor >= this.frames.length || this.timer !== null) return;
        const frame = this.frames[this.cursor];
        this.timer = setTimeout(() => {
            this.timer = null;
            this.step();
            this.scheduleNext();
        }, Math.max(0, frame.delayMs ?? 0));
    }

    private setState(state: CandleSourceState): void {
        this.currentState = state;
        this.stateHandler?.(state);
    }
}