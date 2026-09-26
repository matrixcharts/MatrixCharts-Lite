// src/index.ts

export { Chart } from './core/Chart';
export type { CandleData } from './core/CandleData';
export type { ChartOptions } from './core/ChartOptions';
export type { IRenderer } from './core/IRenderer';
export { WebGL2Renderer } from './renderers/WebGL2Renderer';
export { LTTBDownsampler } from './math/LTTBDownsampler';
export type {
	CandleFeedMessage,
	CandleSource,
	CandleSourceState,
	CandleTarget,
	WebSocketCandleSourceOptions,
} from './feed';
export {
	ChartFeedController,
	MockCandleSource,
	WebSocketCandleSource,
} from './feed';