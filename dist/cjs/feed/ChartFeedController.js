"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChartFeedController = void 0;
class ChartFeedController {
    constructor(chart, source, onStateChange = () => undefined, onError = (error) => {
        console.error('MatrixCharts feed message rejected:', error);
    }) {
        this.chart = chart;
        this.source = source;
        this.onStateChange = onStateChange;
        this.onError = onError;
        this.disposed = false;
        this.diagnostics = {
            received: 0,
            applied: 0,
            rejected: 0,
            lastSequence: null,
            lastMessageType: null,
            lastError: null,
        };
        this.diagnosticHandlers = new Set();
        this.handleMessage = (message) => {
            if (this.disposed)
                return;
            this.diagnostics.received++;
            this.diagnostics.lastSequence = message.sequence;
            this.diagnostics.lastMessageType = message.type;
            try {
                if (message.type === 'snapshot') {
                    this.chart.replaceData(message.candles);
                }
                else if (message.type === 'append') {
                    this.chart.appendBatch(message.candles);
                }
                else if (message.type === 'update') {
                    const candle = message.candle;
                    this.chart.updateLast(candle);
                }
                this.diagnostics.applied++;
            }
            catch (error) {
                this.diagnostics.rejected++;
                this.diagnostics.lastError = error instanceof Error ? error.message : String(error);
                this.onError(error);
                this.source.requestSnapshot?.('Chart rejected feed data.');
            }
            this.emitDiagnostics();
        };
        this.unsubscribe = source.subscribe(this.handleMessage, this.onStateChange);
        source.start();
    }
    get state() {
        return this.source.state;
    }
    getDiagnostics() {
        return { ...this.diagnostics };
    }
    subscribeDiagnostics(handler) {
        this.diagnosticHandlers.add(handler);
        handler(this.getDiagnostics());
        return () => this.diagnosticHandlers.delete(handler);
    }
    emitDiagnostics() {
        const snapshot = this.getDiagnostics();
        for (const handler of Array.from(this.diagnosticHandlers))
            handler(snapshot);
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.unsubscribe();
        this.source.stop();
    }
}
exports.ChartFeedController = ChartFeedController;
