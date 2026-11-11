# SCCharts Lab's npm packages

| Package | What |
| --- | --- |
| [@sccharts-lab/engine](./engine/README.md) | SCCharts compiler, simulator and C code generator: parse SCTX, accept and reject charts as KIELER does, run them tick by tick, generate C |
| [@sccharts-lab/diagram](./diagram/README.md) | Diagrams in KIELER's notation: ELK layout and SVG rendering, with highlighting for simulations |
| [@sccharts-lab/trace](./trace/README.md) | Simulation traces: KTrace, CSV, JSON and XML files, replay and comparison |

A fourth workspace package, [@sccharts-lab/embed](./embed/README.md) (`<sccharts-lab-chart>` and the embed's
postMessage protocol), is not set up for npm yet: the site builds it into `/embed.js`. None of them is on npm yet.

The site imports them as TypeScript sources (each `package.json`'s `exports` points into `src/`), so the dev server and
the tests need no build. What npm gets is built: `publishConfig` (applied by `pnpm pack`) replaces `exports`, `main`
and `types` with `dist/` and turns the `workspace:*` versions into the release's version.

```sh
pnpm packages:build      # dist/ of each package (tools/packages/build.mjs)
pnpm packages:pack       # build, then a tarball each in packages/tarballs/, and checks what they hold
pnpm packages:smoke      # pack, install the tarballs with npm in a fresh project, check Node, TypeScript, a browser bundle
```

`pnpm packages:smoke` (tools/packages/smoke.mjs, under a minute; needs the npm registry, gcc and Playwright's
Chromium) is the proof that the published packages work: in a new project that installs the tarballs with npm it runs
ABRO against KIELER's recording, its generated C through gcc, its diagram, its trace in every format and the quick
start of each README; type-checks a consumer with `moduleResolution` `bundler` and `node16`; and bundles a page with
Vite that it loads in headless Chromium (diagram drawn with ELK on the main thread and in a Web Worker, text as wide
as measured, no console errors). It ends with the gzipped size of each package's main entry.

## Conventions (for a new package)

- `packages/<name>/src/` holds TypeScript (plus assets such as CSS). Relative imports have no extension, as everywhere
  in the site; the build writes `.js` into the emitted specifiers. No Node APIs and, apart from DOM helpers that take
  their root as a parameter, no DOM: the packages run in Node and in browsers.
- `package.json`: `"type": "module"`, `sideEffects`, `engines` (Node 20+), `license`, `repository` with its
  `directory`, `homepage`, `files: ["dist"]`. Development `exports` point into `src/` (keep `"./*": "./src/*.ts"` for
  the site's deep imports); `publishConfig.exports` lists the deliberate entry points, each `{ types, default }` in
  `dist/`. Every published entry needs the same subpath in the development `exports` (the build checks it).
- Another package of this workspace is a `peerDependency` (and a `devDependency`), `workspace:*`: one copy of the
  engine per project, pinned to the release's version. Import it only through its published entry points (the build
  resolves those imports against the other package's `publishConfig.exports` and fails otherwise).
- `tsconfig.build.json` extends `../tsconfig.build.json` (ES2022, lib ES2023: what Node 20 has; tests and fixtures
  are excluded). Add the package to `PACKAGES` in tools/packages/build.mjs, after the packages it imports, and copy
  any non-TypeScript asset there (as the diagram's CSS and fonts are).
- A `README.md` whose first `js` code block is a quick start that runs as it is (the smoke test runs it), and a copy of
  the repository's `LICENSE` (EPL-2.0; the pack checks it is identical).
- The packages are released together, all at one version.

## Releasing

Once:

1. Create the npm organisation `sccharts-lab` (npmjs.com, Add Organization, the free plan for public packages).
2. Create a granular access token (npmjs.com, Access Tokens, Generate New Token, Granular Access Token: "Packages and
   scopes" Read and write, for the scope `@sccharts-lab`) and add it to the GitHub repository as the Actions secret
   `NPM_TOKEN` (Settings, Secrets and variables, Actions).

Each release:

1. Set the same `version` in `packages/engine`, `packages/diagram` and `packages/trace` (`package.json`).
2. `pnpm packages:smoke` locally, then commit.
3. Tag and push: `git tag packages-v0.1.0 && git push origin packages-v0.1.0`.

The tag starts `.github/workflows/packages.yml`: it installs in `site/`, runs the whole test suite, runs
`pnpm packages:smoke --version <tag's version>` and publishes the smoke test's tarballs with npm provenance (the
engine first). A pre-release version (`0.2.0-beta.1`) goes to the dist-tag `next`; a version already on npm is skipped,
so a failed run can be re-run. The extension's own release tags (`v1.2.3`) do not start it.

After the first release, npm's trusted publishing can replace the token: on each package's Settings page on
npmjs.com add the GitHub repository and the workflow `packages.yml`, then delete the secret. To publish by hand
instead: `pnpm packages:smoke`, then `npm publish <tarball> --access public` for each tarball the smoke test names,
engine first.
