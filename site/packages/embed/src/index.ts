// @sccharts-lab/embed: SCCharts Lab's embeds. The postMessage protocol (protocol.ts), the embed's options and
// address (options.ts) and the <sccharts-lab-chart> element (element.ts; `define()` registers it; loader.ts is the
// entry point of the site's /embed.js).
export * from './protocol'
export * from './options'
export { SCChartsLabChart, TAG, define, dedent, inlineFiles, type SCChartsLabChartEventMap } from './element'
