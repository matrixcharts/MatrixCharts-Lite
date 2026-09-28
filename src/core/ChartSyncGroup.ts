import type { Chart } from './Chart.js';
import type { Unsubscribe } from './ChartEvents.js';

export interface ChartSyncOptions {
    time?: boolean;
    price?: boolean;
}

/** Links chart view state without sharing data or creating a global chart singleton. */
export class ChartSyncGroup {
    private readonly members: Map<Chart, Unsubscribe[]> = new Map();
    private readonly options: Required<ChartSyncOptions>;
    private syncing: boolean = false;

    public constructor(options: ChartSyncOptions = {}) {
        this.options = { time: options.time !== false, price: options.price === true };
    }

    public add(chart: Chart): () => void {
        if (this.members.has(chart)) return () => this.remove(chart);
        const subscriptions: Unsubscribe[] = [];
        if (this.options.time) {
            subscriptions.push(chart.subscribeVisibleRangeChange((event) => {
                if (this.syncing) return;
                this.syncing = true;
                try {
                    for (const peer of this.members.keys()) {
                        if (peer === chart) continue;
                        peer.setVisibleLogicalRange(event.logical);
                    }
                } finally {
                    this.syncing = false;
                }
            }));
        }
        if (this.options.price) {
            subscriptions.push(chart.subscribePaneRangeChange((event) => {
                if (event.pane !== 0 || this.syncing) return;
                this.syncing = true;
                try {
                    for (const peer of this.members.keys()) {
                        if (peer === chart) continue;
                        peer.setPriceRange(event.range);
                    }
                } finally {
                    this.syncing = false;
                }
            }));
        }
        this.members.set(chart, subscriptions);
        return () => this.remove(chart);
    }

    public remove(chart: Chart): void {
        const subscriptions = this.members.get(chart);
        if (!subscriptions) return;
        for (const unsubscribe of subscriptions) unsubscribe();
        this.members.delete(chart);
    }

    public clear(): void {
        for (const chart of Array.from(this.members.keys())) this.remove(chart);
    }

    public dispose(): void { this.clear(); }
}