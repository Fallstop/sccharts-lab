# SCCharts Lab: an interactive guide and playground for SCCharts

The source of [sccharts.jmw.nz](https://sccharts.jmw.nz): a beginner-friendly, comprehensive guide to the
SCCharts language whose examples run in the browser, the playground (an in-browser IDE for SCCharts), and live
charts to embed in other sites. A TypeScript engine parses SCTX, draws charts in KIELER's notation, simulates them
tick by tick and generates C; every example is checked against the real KIELER compiler.

```sh
pnpm install
pnpm dev                 # http://localhost:4321
pnpm test                # parser, semantics conformance, diagrams, widgets, playground (no Java needed)
pnpm build               # static site in dist/
pnpm cgen:check          # the generated C of every recorded scenario through gcc, against KIELER's recordings
pnpm packages:smoke      # the npm packages (packages/README.md), packed and checked in a fresh project
```

Checking against KIELER needs Java 21, gcc and the sccharts-lite server JAR (see
`docs-internal/ARCHITECTURE.md`): `pnpm oracle:record` re-records every example's trace with the real
compiler and simulator.

Deploying: `pnpm build && pnpm dlx wrangler deploy` (Cloudflare static assets, `wrangler.jsonc`).

| Path | What |
| --- | --- |
| `src/content/docs/` | the guide's pages (MDX) |
| `src/examples/` | every chart used on a page, with its scenario and KIELER recording |
| `packages/engine/src/` | parser, resolver, validator, simulator, C code generator |
| `packages/diagram/src/` | ELK layout and SVG rendering in KIELER's notation |
| `packages/trace/src/` | simulation traces (KTrace, CSV, JSON, XML), replay and comparison, as the VS Code extension's |
| `packages/embed/src/` | `<sccharts-lab-chart>` and the embed's postMessage protocol (served as `/embed.js`) |
| `packages/README.md` | the packages on npm (`@sccharts-lab/engine`, `/diagram`, `/trace`, `/embed`): building, conventions, releasing |
| `src/components/` | the guide's interactive widgets |
| `src/components/playground/` | the playground at `/playground/` (its `README.md` describes it) |
| `src/components/embed/` | the embed at `/embed/` and the playground's Embed dialog |
| `tests/conformance/` | probe charts that pin down KIELER's semantics, with recordings |
| `docs-internal/` | architecture, semantics specs, design system, content plan, QA |
| `tools/oracle/` | the KIELER oracle harness |
| `tools/cgen/`, `tools/fuzz/` | the generated C through gcc (`pnpm cgen:check`); the differential fuzzer |
| `tools/qa/` | checks of the built site (links, accessibility, phone width, search) |

SCCharts and KIELER are by the Real-Time and Embedded Systems group at Kiel University. SCCharts Lab is an
independent project.
