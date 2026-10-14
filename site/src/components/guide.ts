// The guide's MDX components. Import what a page uses:
//
//   import { Chart, Sim, Compare, Quiz, Predict, TryIt, KeyIdeas } from '~components/guide'
//   import Playground from '~components/Playground.astro'
//
// <Playground> is imported on its own: Astro adds the CSS of every component a page imports, used or not, so
// re-exporting it here put the playground's stylesheet (6 kB gzipped, render-blocking) on every page.
//
// Props are documented in docs-internal/CONTENT-PLAN.md ("Components for MDX") and in each component.
// Examples are named by path under src/examples without `.sctx`; a missing file fails the build.

export { default as Chart } from './Chart.astro'
export { default as Sim } from './Sim.astro'
export { default as Compare } from './Compare.astro'
export { default as Quiz } from './Quiz.astro'
export { default as Predict } from './Predict.astro'
export { default as TryIt } from './TryIt.astro'
export { default as KeyIdeas } from './KeyIdeas.astro'
