import type { Chart } from './Chart.js';
export interface ChartSyncOptions {
    time?: boolean;
    price?: boolean;
}
/** Links chart view state without sharing data or creating a global chart singleton. */
export declare class ChartSyncGroup {
    private readonly members;
    private readonly options;
    private syncing;
    constructor(options?: ChartSyncOptions);
    add(chart: Chart): () => void;
    remove(chart: Chart): void;
    clear(): void;
    dispose(): void;
}
//# sourceMappingURL=ChartSyncGroup.d.ts.map