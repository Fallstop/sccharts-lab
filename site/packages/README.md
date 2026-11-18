# SCCharts Lab's npm packages

| Package | What |
| --- | --- |
| [@sccharts-lab/engine](./engine/README.md) | SCCharts compiler, simulator and C code generator: parse SCTX, accept and reject charts as KIELER does, run them tick by tick, generate C |
| [@sccharts-lab/diagram](./diagram/README.md) | Diagrams in KIELER's notation: ELK layout and SVG rendering, with highlighting for simulations |
| [@sccharts-lab/trace](./trace/README.md) | Simulation traces: KTrace, CSV, JSON and XML files, replay and comparison |
| [@sccharts-lab/embed](./embed/README.md) | Live charts on any page: the `<sccharts-lab-chart>` element (also one script, `dist/embed.min.js`, the site's `/embed.js`), the embed's options and postMessage protocol |

Each is on npm, published from this repository with provenance. Their documentation is the site's `/packages/`
section (`src/content/docs/packages/`: an overview, a quick start, and a guide and an API reference per package); each
package's `homepage` and README link to its pages there.

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
as measured, no console errors). It loads the embed package's `dist/embed.min.js` in a host page whose
`<sccharts-lab-chart>` frames a built site served on another origin, gets ready and steps ABRO, and checks that the
file is the site's `/embed.js` byte for byte; that part needs `pnpm build` first (`site/dist`, or `--site <dir>`),
and without a built site it only checks that the script registers the element and frames the right address. It ends
with the gzipped size of each package's main entry.

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
  any non-TypeScript asset there (as the diagram's CSS and fonts are, and the embed's single-file script, made by
  tools/packages/embed-bundle.mjs, the build the site's `/embed.js` uses too). An entry the build makes rather than
  compiles goes in `GENERATED` there.
- A `README.md` whose first `js` code block is a quick start that runs as it is (the smoke test runs it), and a copy of
  the repository's `LICENSE` (EPL-2.0; the pack checks it is identical).
- Its documentation: `src/content/docs/packages/<name>/index.mdx` (the guide) and `api.mdx` (the API reference), in the
  sidebar's Packages group (astro.config.mjs), with `homepage` set to `https://sccharts.jmw.nz/packages/<name>/` and
  the README linking there. `tests/packages-docs` checks all of it: the API page names every export with the source's
  signatures and members, the pages' code is the files of `src/components/packages/samples` (each `.mjs` is run and
  its output compared with the `.out.txt` the page shows; `vitest -u` records it), and the smoke test runs the same
  samples against the tarballs.
- The packages are released together, all at one version.
- A script for a script tag (not a module) is named `*.min.js` and has no declarations; `jsdelivr` and `unpkg` point
  at it, so `https://cdn.jsdelivr.net/npm/@sccharts-lab/<name>` serves it.

## Releasing

The packages are published by npm's trusted publishing: each one's Settings page on npmjs.com names the GitHub
repository `Fallstop/sccharts-lab` and the workflow `packages.yml` (with "Allow npm publish" ticked), and only that
workflow can publish them; there is no token. Publishing access is set to require 2FA and refuse tokens that bypass it.

Each release:

1. Set the same `version` in the four `packages/*/package.json` (`pack.mjs` refuses different ones), and, when the
   minor version changes, in the jsDelivr addresses (`@sccharts-lab/embed@0.3`) of `packages/embed/README.md` and of
   the documentation's `samples/embed/tag.html` (`tests/packages-docs` fails until they agree).
2. `pnpm exec vitest run && pnpm build && pnpm packages:smoke --site dist`, then commit. Run it in a fresh clone of
   that commit: the CI on `main` does not run the site's tests, and a file only in your worktree passes locally.
3. Tag that commit and push the tag: `git tag packages-v0.3.0 <commit> && git push origin packages-v0.3.0`.

The tag starts `.github/workflows/packages.yml`: it installs in `site/`, runs the whole test suite, builds the site,
runs `pnpm packages:smoke --version <tag's version> --site dist` and publishes the smoke test's tarballs with npm
provenance (the engine first). A pre-release version (`0.2.0-beta.1`) goes to the dist-tag `next`; a version already on
npm is skipped, so a failed run can be re-run. The extension's own release tags (`v1.2.3`) do not start it.

A new package cannot be published this way the first time: trusted publishing is set on a package that exists. Publish
its first version by hand (`pnpm packages:smoke`, then `npm publish <tarball> --access public`, logged in to an npm
account in the `sccharts-lab` organisation), then add the trusted publisher on its Settings page.
