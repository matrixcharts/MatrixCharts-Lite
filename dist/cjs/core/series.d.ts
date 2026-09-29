import type { OverlayPoint } from './overlays.js';
export interface LineSeriesOptions {
    id: string;
    color?: string;
    pane?: number;
    visible?: boolean;
}
/** Public lifecycle for a line series backed by the chart's existing overlay engine. */
export interface LineSeriesHandle {
    readonly id: string;
    setData(points: readonly OverlayPoint[]): void;
    setVisible(visible: boolean): void;
    remove(): void;
}
