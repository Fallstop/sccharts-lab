# SCCharts: an interactive guide

The source of [sccharts.jmw.nz](https://sccharts.jmw.nz): a beginner-friendly, comprehensive guide to the
SCCharts language whose examples run in the browser. A TypeScript engine parses SCTX, draws charts in
KIELER's notation and simulates them tick by tick; every example is checked against the real KIELER
compiler.

```sh
pnpm install
pnpm dev                 # http://localhost:4321
pnpm test                # parser, semantics conformance, diagrams, widgets (no Java needed)
pnpm build               # static site in dist/
```

Checking against KIELER needs Java 21, gcc and the sccharts-lite server JAR (see
`docs-internal/ARCHITECTURE.md`): `pnpm oracle:record` re-records every example's trace with the real
compiler and simulator.

Deploying: `pnpm build && pnpm dlx wrangler deploy` (Cloudflare static assets, `wrangler.jsonc`).

| Path | What |
| --- | --- |
| `src/content/docs/` | the guide's pages (MDX) |
| `src/examples/` | every chart used on a page, with its scenario and KIELER recording |
| `src/engine/` | parser, resolver, validator, simulator |
| `src/diagram/` | ELK layout and SVG rendering in KIELER's notation |
| `src/components/` | the interactive widgets and the playground |
| `tests/conformance/` | probe charts that pin down KIELER's semantics, with recordings |
| `docs-internal/` | architecture, semantics specs, design system, content plan |
| `tools/oracle/` | the KIELER oracle harness |

SCCharts and KIELER are by the Real-Time and Embedded Systems group at Kiel University. This guide is an
independent project.
