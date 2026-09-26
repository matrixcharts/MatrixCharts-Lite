import type { CandleData } from '../core/CandleData.js';
import type { CandleFeedMessage, CandleSource, CandleSourceState } from './CandleSource.js';

type WebSocketFactory = (url: string) => WebSocket;
type FeedListener = (message: CandleFeedMessage) => void;
type StateListener = (state: CandleSourceState) => void;

export interface WebSocketCandleSourceOptions {
    reconnectMinDelayMs?: number;
    reconnectMaxDelayMs?: number;
    heartbeatTimeoutMs?: number;
    watchdogIntervalMs?: number;
    webSocketFactory?: WebSocketFactory;
}

export class WebSocketCandleSource implements CandleSource {
    private socket: WebSocket | null = null;
    private currentState: CandleSourceState = 'idle';
    private readonly messageListeners: Set<FeedListener> = new Set<FeedListener>();
    private readonly stateListeners: Set<StateListener> = new Set<StateListener>();
    private readonly reconnectMinDelayMs: number;
    private readonly reconnectMaxDelayMs: number;
    private readonly heartbeatTimeoutMs: number;
    private readonly watchdogIntervalMs: number;
    private readonly createSocket: WebSocketFactory;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private watchdogTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectAttempt: number = 0;
    private lastSequence: number | null = null;
    private lastHeartbeatAt: number = 0;
    private resyncRequestedAt: number = 0;
    private synchronized: boolean = false;
    private resyncRequested: boolean = false;
    private manuallyStopped: boolean = true;

    constructor(private readonly url: string, options: WebSocketCandleSourceOptions = {}) {
        if (!url.trim()) throw new Error('MatrixCharts: WebSocket feed URL cannot be empty.');
        this.reconnectMinDelayMs = options.reconnectMinDelayMs ?? 500;
        this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
        this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15_000;
        this.watchdogIntervalMs = options.watchdogIntervalMs ?? Math.max(100, this.heartbeatTimeoutMs / 4);
        this.createSocket = options.webSocketFactory ?? ((socketUrl: string): WebSocket => new WebSocket(socketUrl));
        if (
            !Number.isFinite(this.reconnectMinDelayMs) ||
            this.reconnectMinDelayMs < 0 ||
            !Number.isFinite(this.reconnectMaxDelayMs) ||
            this.reconnectMaxDelayMs < this.reconnectMinDelayMs ||
            !Number.isFinite(this.heartbeatTimeoutMs) ||
            this.heartbeatTimeoutMs < 100 ||
            !Number.isFinite(this.watchdogIntervalMs) ||
            this.watchdogIntervalMs < 10
        ) {
            throw new Error('MatrixCharts: Invalid WebSocket reconnect or heartbeat timing options.');
        }
    }

    public get state(): CandleSourceState {
        return this.currentState;
    }

    public subscribe(onMessage: FeedListener, onStateChange: StateListener): () => void {
        this.messageListeners.add(onMessage);
        this.stateListeners.add(onStateChange);
        onStateChange(this.currentState);
        return (): void => {
            this.messageListeners.delete(onMessage);
            this.stateListeners.delete(onStateChange);
        };
    }

    public start(): void {
        if (!this.manuallyStopped) return;
        this.manuallyStopped = false;
        this.reconnectAttempt = 0;
        this.lastSequence = null;
        this.synchronized = false;
        this.resyncRequested = false;
        this.setState('connecting');
        this.watchdogTimer = setInterval(this.checkHealth, this.watchdogIntervalMs);
        this.connect(false);
    }

    public stop(): void {
        this.manuallyStopped = true;
        this.clearReconnectTimer();
        if (this.watchdogTimer !== null) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        this.detachSocket(true);
        this.synchronized = false;
        this.resyncRequested = false;
        this.setState('disconnected');
    }

    public requestSnapshot(reason: string): void {
        this.requestResync(reason);
    }

    private connect(isReconnect: boolean): void {
        if (this.manuallyStopped) return;
        this.setState(isReconnect ? 'reconnecting' : 'connecting');
        try {
            const socket: WebSocket = this.createSocket(this.url);
            this.socket = socket;
            socket.addEventListener('open', this.handleOpen);
            socket.addEventListener('message', this.handleSocketMessage);
            socket.addEventListener('error', this.handleError);
            socket.addEventListener('close', this.handleClose);
        } catch (error: unknown) {
            console.error('MatrixCharts: WebSocket connection could not be created.', error);
            this.scheduleReconnect();
        }
    }

    private handleOpen = (): void => {
        const socket: WebSocket | null = this.socket;
        if (!socket || socket.readyState !== 1) return;
        this.lastHeartbeatAt = Date.now();
        this.synchronized = false;
        this.resyncRequested = true;
        this.resyncRequestedAt = Date.now();
        this.setState('resyncing');
        try {
            socket.send(JSON.stringify({ type: 'subscribe' }));
        } catch (error: unknown) {
            console.error('MatrixCharts: Failed to send feed subscription.', error);
            this.restartConnection();
        }
    };

    private handleSocketMessage = (event: MessageEvent<unknown>): void => {
        if (typeof event.data !== 'string') {
            this.requestResync('WebSocket messages must be JSON text.');
            return;
        }

        let message: CandleFeedMessage;
        try {
            message = this.parseMessage(JSON.parse(event.data) as unknown);
        } catch (error: unknown) {
            this.requestResync(error instanceof Error ? error.message : 'Malformed feed message.');
            return;
        }

        if (message.type === 'snapshot') {
            this.lastSequence = message.sequence;
            this.synchronized = true;
            this.resyncRequested = false;
            this.lastHeartbeatAt = Date.now();
            this.reconnectAttempt = 0;
            this.setState('connected');
            this.emitMessage(message);
            return;
        }

        if (this.lastSequence === null || !this.synchronized) {
            this.requestResync('Received a delta before an authoritative snapshot.');
            return;
        }
        if (message.sequence <= this.lastSequence) return;
        if (message.sequence !== this.lastSequence + 1) {
            this.requestResync(`Sequence gap: expected ${this.lastSequence + 1}, received ${message.sequence}.`);
            return;
        }

        this.lastSequence = message.sequence;
        if (message.type === 'heartbeat') {
            this.lastHeartbeatAt = Date.now();
            return;
        }
        this.emitMessage(message);
    };

    private handleError = (): void => {
        this.setState('error');
        this.restartConnection();
    };

    private handleClose = (): void => {
        this.detachSocket(false);
        if (!this.manuallyStopped) this.scheduleReconnect();
    };

    private checkHealth = (): void => {
        if (this.manuallyStopped || !this.socket || this.socket.readyState !== 1) return;
        const now: number = Date.now();
        if (now - this.lastHeartbeatAt > this.heartbeatTimeoutMs) {
            this.restartConnection();
            return;
        }
        if (this.resyncRequested && now - this.resyncRequestedAt > this.heartbeatTimeoutMs) {
            this.restartConnection();
        }
    };

    private requestResync(reason: string): void {
        const socket: WebSocket | null = this.socket;
        if (!socket || socket.readyState !== 1) return;
        if (!this.resyncRequested) {
            this.resyncRequested = true;
            this.resyncRequestedAt = Date.now();
            this.synchronized = false;
            this.setState('resyncing');
            try {
                socket.send(JSON.stringify({
                    type: 'resync',
                    afterSequence: this.lastSequence,
                    reason,
                }));
            } catch (error: unknown) {
                console.error('MatrixCharts: Failed to request a feed snapshot.', error);
                this.restartConnection();
            }
        }
    }

    private restartConnection(): void {
        if (this.manuallyStopped) return;
        this.detachSocket(true);
        this.synchronized = false;
        this.resyncRequested = false;
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.manuallyStopped || this.reconnectTimer !== null) return;
        this.setState('reconnecting');
        const delay: number = Math.min(
            this.reconnectMaxDelayMs,
            this.reconnectMinDelayMs * Math.pow(2, this.reconnectAttempt),
        );
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect(true);
        }, delay);
    }

    private detachSocket(close: boolean): void {
        const socket: WebSocket | null = this.socket;
        this.socket = null;
        if (!socket) return;
        socket.removeEventListener('open', this.handleOpen);
        socket.removeEventListener('message', this.handleSocketMessage);
        socket.removeEventListener('error', this.handleError);
        socket.removeEventListener('close', this.handleClose);
        if (close && (socket.readyState === 0 || socket.readyState === 1)) {
            socket.close(1000, 'MatrixCharts feed reconnecting');
        }
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer === null) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private emitMessage(message: CandleFeedMessage): void {
        for (const listener of Array.from(this.messageListeners)) listener(message);
    }

    private setState(state: CandleSourceState): void {
        if (this.currentState === state) return;
        this.currentState = state;
        for (const listener of Array.from(this.stateListeners)) listener(state);
    }

    private parseMessage(value: unknown): CandleFeedMessage {
        if (typeof value !== 'object' || value === null || !('type' in value)) {
            throw new Error('Expected a typed candle feed message.');
        }
        const message: {
            type?: unknown;
            sequence?: unknown;
            candles?: unknown;
            candle?: unknown;
        } = value;
        if (!Number.isSafeInteger(message.sequence) || (message.sequence as number) < 0) {
            throw new Error('Feed sequence must be a non-negative safe integer.');
        }
        const sequence: number = message.sequence as number;

        if (message.type === 'snapshot' && Array.isArray(message.candles)) {
            return {
                type: 'snapshot',
                sequence,
                candles: message.candles.map((candidate: unknown): CandleData => this.parseCandle(candidate)),
            };
        }
        if (message.type === 'append' && Array.isArray(message.candles)) {
            return {
                type: 'append',
                sequence,
                candles: message.candles.map((candidate: unknown): CandleData => this.parseCandle(candidate)),
            };
        }
        if (message.type === 'update') {
            return { type: 'update', sequence, candle: this.parseCandle(message.candle) };
        }
        if (message.type === 'heartbeat') return { type: 'heartbeat', sequence };
        throw new Error('Expected snapshot, append, update, or heartbeat feed message.');
    }

    private parseCandle(value: unknown): CandleData {
        if (typeof value !== 'object' || value === null) throw new Error('Candle must be an object.');
        const candle: {
            time?: unknown; open?: unknown; high?: unknown; low?: unknown; close?: unknown; volume?: unknown;
        } = value;
        // `Number.isFinite`, not `typeof`: JSON.parse turns an out-of-range literal
        // such as 1e999 into Infinity, which is a number but not a usable price or
        // timestamp. Rejecting it here keeps the parser's contract honest instead of
        // relying on every downstream consumer to re-check.
        if (
            !Number.isFinite(candle.time) ||
            !Number.isFinite(candle.open) ||
            !Number.isFinite(candle.high) ||
            !Number.isFinite(candle.low) ||
            !Number.isFinite(candle.close)
        ) {
            throw new Error('Candle fields time/open/high/low/close must be finite numbers.');
        }
        // Volume is optional on the wire. A present volume is validated rather
        // than passed through, because a candle whose volume cannot be drawn is a
        // malformed frame, not a candle with no volume: dropping it silently would
        // leave a feed that looks healthy while the histogram is quietly wrong.
        if (candle.volume !== undefined && (!Number.isFinite(candle.volume) || (candle.volume as number) < 0)) {
            throw new Error('Candle volume must be a finite, non-negative number when present.');
        }
        const parsed: CandleData = {
            time: candle.time as number,
            open: candle.open as number,
            high: candle.high as number,
            low: candle.low as number,
            close: candle.close as number,
        };
        // Only carried when the wire carried it, so an absent volume stays
        // absent rather than becoming a zero that reads like real data.
        if (candle.volume !== undefined) parsed.volume = candle.volume as number;
        return parsed;
    }
}
