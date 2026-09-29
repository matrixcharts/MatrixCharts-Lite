/** Links chart view state without sharing data or creating a global chart singleton. */
export class ChartSyncGroup {
    constructor(options = {}) {
        this.members = new Map();
        this.syncing = false;
        this.options = { time: options.time !== false, price: options.price === true };
    }
    add(chart) {
        if (this.members.has(chart))
            return () => this.remove(chart);
        const subscriptions = [];
        if (this.options.time) {
            subscriptions.push(chart.subscribeVisibleRangeChange((event) => {
                if (this.syncing)
                    return;
                this.syncing = true;
                try {
                    for (const peer of this.members.keys()) {
                        if (peer === chart)
                            continue;
                        peer.setVisibleLogicalRange(event.logical);
                    }
                }
                finally {
                    this.syncing = false;
                }
            }));
        }
        if (this.options.price) {
            subscriptions.push(chart.subscribePaneRangeChange((event) => {
                if (event.pane !== 0 || this.syncing)
                    return;
                this.syncing = true;
                try {
                    for (const peer of this.members.keys()) {
                        if (peer === chart)
                            continue;
                        peer.setPriceRange(event.range);
                    }
                }
                finally {
                    this.syncing = false;
                }
            }));
        }
        this.members.set(chart, subscriptions);
        return () => this.remove(chart);
    }
    remove(chart) {
        const subscriptions = this.members.get(chart);
        if (!subscriptions)
            return;
        for (const unsubscribe of subscriptions)
            unsubscribe();
        this.members.delete(chart);
    }
    clear() {
        for (const chart of Array.from(this.members.keys()))
            this.remove(chart);
    }
    dispose() { this.clear(); }
}
