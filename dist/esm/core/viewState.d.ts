import type { LogicalRange } from './coordinates.js';
/** Serializable viewport and pane state for workspace persistence or linking. */
export interface ChartViewState {
    logical: LogicalRange;
    barSpacing: number;
    priceRange: readonly [number, number];
    paneRanges: readonly {
        pane: number;
        range: readonly [number, number];
    }[];
    atRealtime: boolean;
}
//# sourceMappingURL=viewState.d.ts.map