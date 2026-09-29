/** Deterministic feed source for incident replay, tests, and strategy review. */
export class CandleReplaySource {
    constructor(frames) {
        this.messageHandler = null;
        this.stateHandler = null;
        this.timer = null;
        this.cursor = 0;
        this.running = false;
        this.currentState = 'idle';
        this.frames = frames.slice();
    }
    get state() { return this.currentState; }
    get position() { return this.cursor; }
    subscribe(onMessage, onStateChange) {
        this.messageHandler = onMessage;
        this.stateHandler = onStateChange;
        onStateChange(this.currentState);
        return () => {
            this.messageHandler = null;
            this.stateHandler = null;
            this.stop();
        };
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.setState('connected');
        this.scheduleNext();
    }
    stop() {
        this.running = false;
        if (this.timer !== null)
            clearTimeout(this.timer);
        this.timer = null;
        this.setState('disconnected');
    }
    pause() {
        this.running = false;
        if (this.timer !== null)
            clearTimeout(this.timer);
        this.timer = null;
    }
    resume() {
        if (this.running)
            return;
        this.running = true;
        this.setState('connected');
        this.scheduleNext();
    }
    seek(frameIndex) {
        if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex > this.frames.length) {
            throw new Error('MatrixCharts: Replay frame index is out of range.');
        }
        this.pause();
        this.cursor = frameIndex;
    }
    step() {
        if (this.cursor >= this.frames.length)
            return false;
        this.messageHandler?.(this.frames[this.cursor++].message);
        return true;
    }
    scheduleNext() {
        if (!this.running || this.cursor >= this.frames.length || this.timer !== null)
            return;
        const frame = this.frames[this.cursor];
        this.timer = setTimeout(() => {
            this.timer = null;
            this.step();
            this.scheduleNext();
        }, Math.max(0, frame.delayMs ?? 0));
    }
    setState(state) {
        this.currentState = state;
        this.stateHandler?.(state);
    }
}
