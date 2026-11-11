# Production QA

The checks the site passes before it is deployed, how to run each one again, and what the last run found. Last
full run: 14 October 2026 (the final round after engine-4, widgets-D, playground-4, content-D and the editors), on the
production build of the `site` branch: 48 pages, that is the landing page and 45 guide pages, the playground and the
404 page. Partly re-run on 11 November 2026 (see "11 November 2026" below). Re-run all of it after a change to the
shell, the widgets or the build, and the relevant parts after content changes. The site is light-only for now
(27 October), so the dark configurations no longer apply.

Most checks need a build and a server for it. The tools in `tools/qa/` start their own `astro preview` of `dist/`
when they get no `--url`; to run several, start one and pass it:

```sh
pnpm build
node node_modules/astro/bin/astro.mjs preview --port 4330 --host 127.0.0.1 --ignore-lock &   # or let each tool start its own
U=http://127.0.0.1:4330
```

| # | Check | Command | Last result |
| --- | --- | --- | --- |
| 1 | Tests, types, build | `pnpm exec vitest run`; `pnpm check`; `pnpm build` | 6410 passed, 35 skipped; 0 errors, 0 warnings (11 hints); no build warnings |
| 2 | Links | `node tools/qa/links.mjs --external` | 7084 links on 48 pages (7006 internal): no problems; of 54 external URLs, 3 ACM DOIs are bot-blocked (below) |
| 3 | Accessibility | `node tools/qa/pages.mjs --url $U --configs light-1280,dark-390,dark-1280,light-390`; `node tools/qa/keyboard.mjs --url $U [--route … --frame n \| --playground]` | 0 axe violations on every page in all four configurations, before and after engaging a widget; keyboard walks pass |
| 4 | Console | `node tools/qa/pages.mjs --url $U` (same run) | no errors or warnings on load or while stepping, on any page |
| 5 | Visual | `node tools/screenshot.mjs --url $U --widths 1280 --themes light <routes>` and `--widths 390 --themes dark`; `node tools/qa/phone.mjs --url $U`; `node tools/qa/nojs.mjs --url $U <route>` | all 96 full-page shots looked at; no sideways page scroll at 390; no table scrolls at 390; no-JS pages show every diagram and tour, in the reader's colour scheme |
| 6 | Performance | `node tools/qa/pages.mjs` (bytes, layout shift, hydration); `node tools/qa/interactive.mjs --url $U [--fast]` | see below |
| 7 | SEO and meta | `node tools/qa/meta.mjs` | no problems |
| 8 | Search | `node tools/qa/search.mjs --url $U` | all eight terms find their page first |
| 9 | Deployment config | read `wrangler.jsonc`, `public/_headers`, `public/robots.txt` against `dist/` | matches (below); not deployed |
| 10 | Leftovers, COMPSYS 303 | the `grep` commands below | none |

`pages.mjs` writes its details (every request with its gzip size, every axe node) to `--out`, by default
`$TMPDIR/qa-pages.json`. Last full runs: light 1280 and dark 390, then dark 1280 and light 390, each with the first
widget engaged on every page: 192 page loads, no problems. After the last fixes (the parser, the page title's search
weight, the causality description) nine pages were run again in all four configurations (36 loads, no problems).
`tests/widgets/browser.test.ts` and `PLAYGROUND_E2E=1 pnpm exec vitest run tests/playground/e2e.test.ts` need the
shared dev server (`tools/dev-server.sh`); both pass (42 and 20 tests). `browser.test.ts` also runs in the whole
suite whenever the dev server is up. `FOOT_E2E=1 pnpm exec vitest run tests/widgets/foot.test.ts --silent=false` (the dev server
too, about 17 minutes) steps every simulation widget of the landing page and the guide at 1280 and 390 and checks
that stepping never changes the height of its foot or of the page: one height in the tour, one in free play
(`src/components/sim/README.md`, "The foot").

## 1. Tests, types, build

- `pnpm exec vitest run`: 53 files passed, 2 skipped (the opt-in KIELER diff and playground e2e), 6410 tests
  passed, 35 skipped. `tests/conformance/engine-expected-failures.json` lists nothing: the engine reproduces every
  recording it can run, the 21 new probes of this round included.
- `pnpm check`: 0 errors, 0 warnings, 11 hints (unused names and two deprecations in `tools/fuzz/register.mjs`;
  harmless).
- `pnpm build`: no warnings, 48 pages. No `[widgets]` warning (an example KIELER accepts but the engine rejects, or a
  diagram that cannot be laid out) is printed.
- Every dependency in `package.json` names an exact version (ten were `"*"` and TypeScript was `^6.0.0`; they are
  pinned to the versions the lockfile already had, so `pnpm install --frozen-lockfile` installs the same tree).

## 2. Links

`tools/qa/links.mjs` reads `dist/`: every internal `href`/`src` resolves to a file, page links end in `/` (no
redirects), every `#anchor` exists on its target page, playground `?example=`/`&solution=` ids exist, nothing
links to a draft. With `--external` it fetches every external URL (GET, redirects followed, a browser user agent).
Last run: 7006 internal links, no problems. Of the 54 external URLs, the three ACM DOIs on Further reading
(`10.1145/2594291.2594310`, `10.1145/2627350`, `10.1145/3453482`) answer 403: doi.org redirects them to
`dl.acm.org/doi/…`, which blocks scripted requests. Each was looked up on Crossref, and its title is that of the
entry that links it. Every other URL answers 2xx. The 404 page's own canonical and `og:url` (Starlight's `/404/`)
are ignored: the page is `noindex`.

## 3. Accessibility

`@axe-core/playwright` 4.13.0 (axe-core 4.13), tags WCAG 2.0/2.1/2.2 A and AA plus best practices, on every page in
light and dark at 1280 and 390, before and after engaging the first widget (hydrated, stepped three times). Last
run: 0 violations. Fixed this round: the inline playground on `learn/first-chart` (its server-rendered code scrolls
sideways at 390 and could not take focus, `scrollable-region-focusable`) is a named, focusable region now, like the
other scrolling code.

Keyboard-only walks (`tools/qa/keyboard.mjs`), each with a visible focus ring on every stop and no console output:
- **Sim** (`/learn/transitions/`, widget 0): 10 stops (view tab, playground link, the diagram, Step, Run, speed, the
  input, the timing diagram, Next, Take over); Enter, Space, Backspace and the trace's arrow keys step and go back;
  Previous to tick 0 keeps the focus in the widget.
- **Compare** (widget 1): 11 stops, the same keys.
- **Predict** (widget 5): 7 stops; answered from the keyboard and submitted with Enter, the verdict announced.
- **How KIELER reads it** (`/reference/operators/`, widget 0): 9 stops (the text field, the two modes, the traps);
  the walk now presses a trap with Enter and types an expression, and both change the reading.
- **Playground**: the skip link, the header, the trust note's two links, the toolbar (Examples, New, Open,
  Download, Copy link, Help), then the editor (13 stops); typing works; Escape (twice when the completion list is
  open) then Tab leaves the editor; Step with Enter.
- Colour contrast is covered by axe on every page and by `node tools/contrast.mjs` (in the tests).

## 4. Console

No console errors or warnings on any page, on load or while hovering, hydrating and stepping its first widget, in
any of the four configurations. The only message is Chromium's own "Failed to load resource: 404" on the unknown
path, which is the point of that request.

## 5. Visual

- Every page at 1280 light and 390 dark, full page, from the production build, looked at as contact sheets (each
  shot cut into pieces; 112 sheets at 1280, 53 at 390). One defect found and fixed: `text-wrap: balance` on
  headings had no effect, because Starlight makes a heading `display: inline` inside its `.sl-heading-wrapper`, so
  headings at 390 ended in a lone word ("Nothing happens in tick / 1"). The rule is on the wrapper now
  (`theme.css`), and the headings balance ("Nothing happens / in tick 1").
- Seen and left for their owners (list at the end): the inline playground's static diagram under its zoom
  buttons, and at 390 the playground's Simulate tab shrinking the chart's name to one letter.
- No sideways page scroll at 390 on any page (scripted: `document.documentElement.scrollWidth`).
- `tools/qa/phone.mjs`: no Markdown table scrolls sideways at 390 (181 code blocks scroll inside themselves, as
  code should).
- No JavaScript (`tools/qa/nojs.mjs` on `/`, `/learn/first-chart/`, `/learn/transitions/`, `/learn/variables/`,
  `/reference/notation/`, `/reference/operators/`, `/patterns/level-crossing/`, `/advanced/history/`,
  `/reference/errors/` and `/playground/`): every widget frame shows its diagram and its code, a guided tour is
  listed as text, no overflow. The theme follows the reader's colour scheme without JavaScript (light at 1280
  light, dark at 390 dark; looked at). *How KIELER reads it* frames (`.sc-frame--reads`) have no diagram by design;
  they show their first example and a note, and are not counted. Run `nojs.mjs` on a few routes at a time: a run
  over nine long pages can lose its Chromium screenshot ("Unable to capture screenshot"), and each route on its own
  passes (`/` did this round).

## 6. Performance

Bytes before any interaction, on the wire (gzip for HTML, CSS and JS; fonts as they are), cold cache, at 1280
(`pages.mjs`, kB = 1024 bytes). JS includes Starlight's search UI, which loads on idle.

| Page | Total | HTML | JS | CSS | Fonts | First engagement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/playground/` | 1013 kB | 38 | 866 | 32 | 77 | – |
| `/` (landing) | 330 kB | 15 | 207 | 31 | 77 | – |
| `/advanced/history/` | 266 kB | 78 | 44 | 31 | 114 | 163 |
| `/patterns/level-crossing/` | 260 kB | 72 | 44 | 31 | 114 | 164 |
| `/reference/errors/` | 258 kB | 70 | 44 | 31 | 114 | 164 |
| `/learn/first-chart/` (an inline playground) | 241 kB | 33 | 57 | 37 | 114 | 161 |
| a typical chapter (`/learn/transitions/`) | 235 kB | 47 | 44 | 31 | 114 | 164 |
| `/reference/further-reading/` (no widgets) | 182 kB | 13 | 30 | 25 | 114 | – |

- The playground loads ELK's layout worker and CodeMirror at start: the price of laying out diagrams in the
  browser. The landing page loads the engine at once at desktop width, because its live chart is in view
  (`client:visible`, the one autoplaying chart); on a phone it loads 43 kB of JS until scrolled to.
- Guide pages load about 13 kB of their own JS; the first widget a reader engages loads about 163 kB (the engine
  chunk, Svelte and the panel), once per page.
- **Inline playground** (`learn/first-chart`): it starts when the reader engages with it (the first pointer, touch,
  key or focus in its frame; a pointer over it prefetches the app), no longer when it scrolls near. Scrolling past it
  loads nothing; starting it loads 813 kB (the playground's app), and a click in its code puts the cursor in the
  editor. Before, every reader who scrolled past "Building the chart" downloaded the whole app.
- **Time to interactive of a Sim** (`interactive.mjs`, `/learn/transitions/`): on Lighthouse's slow-phone profile
  (slow 4G, CPU 4x slower) the first contentful paint is at 1.32 s, and a tap on Step shows tick 1 after 1.51 s
  (the island is live after 1.47 s, mostly the engine download); without throttling 0.24 s and 0.12 s.
- **Layout shift**: none on hydration on any page (hydration takes at most 112 ms); on load at most 0.05 (the
  playground) and 0.04 elsewhere, from the web fonts swapping in.

## 7. SEO and meta

`tools/qa/meta.mjs`: 48 distinct titles and descriptions of 50 to 170 characters, canonical URLs and `og:url` on
https://sccharts.jmw.nz, Open Graph and Twitter tags with `/og.png`, `lang="en"`, the favicons. The sitemap lists
the 47 pages (no drafts, no 404); `robots.txt` allows all and names the sitemap; the 404 page is `noindex`.

## 8. Search

Pagefind (`search.mjs`), each term with its page first: "abort" (23 results) `/learn/preemption/`; "pre" (43)
`/learn/pre/`; "causality" (14) `/learn/causality/`; "valued signal" (26) `/learn/signals/`; "level crossing" (5)
`/patterns/level-crossing/`; "enum" (12) `/advanced/data-types/`; "troubleshooting" (3)
`/reference/troubleshooting/`; "arbiter" (4) `/patterns/arbiter/`. (The tool fails only when the page is not among
the first five.) Fixed: "causality" put Further reading first and its chapter third, and "troubleshooting" put the
level crossing first. The lede under each title (the page's description, `PageTitle.astro`) now has Pagefind weight
3, between body text (1) and the title (7), and the causality chapter's description names what it is about ("why it
refuses a causality cycle"). The draft pages and the 404 page are not indexed.

## 9. Deployment

`wrangler.jsonc` serves `./dist` as Worker static assets with `html_handling: "auto-trailing-slash"` (Astro writes
one directory per page, and every internal link ends in `/`) and `not_found_handling: "404-page"` (`dist/404.html`,
status 404). `public/_headers` is copied to `dist/_headers` unchanged: a year's `immutable` cache for `/_astro/*`
(every file name there carries a content hash, Expressive Code's `ec.*.js` and `ec.*.css` included) and, for every
path, `X-Content-Type-Options`, `Referrer-Policy` and `Strict-Transport-Security`; no Content-Security-Policy
(Starlight's theme script and Astro's islands are inline, Pagefind needs WebAssembly). `dist/` has 1741 files and
24 MB, none over 5 MB, inside the static-asset limits. Not deployed: no wrangler command was run, and Cloudflare was
not contacted.

## 10. Leftovers and COMPSYS 303

```sh
grep -rnI -E '\b(TODO|FIXME|XXX|HACK)\b|lorem ipsum|coming soon' src tools public astro.config.mjs ec.config.mjs
grep -rnI -E 'console\.(log|debug)\(' src --include='*.ts' --include='*.svelte' --include='*.astro' | grep -v '\.test\.ts'
grep -rlI -iE 'TODO|FIXME|lorem|coming soon' dist --include='*.html'
grep -ohE '\((basics|concurrency|preemption|structure)\.md [A-Z]{1,3}-[0-9]+[a-z]?\)' -r dist --include='*.html' | sort | uniq -c
grep -rnI -iE 'traffic|pedestrian|crosswalk|zebra|stop ?light' src tests docs-internal tools public
```

Nothing in the sources or the build. A stray scratch test (`tests/playground/zz-qa-tmp.test.ts`) was removed.
COMPSYS 303: no traffic lights or pedestrian crossings in `src/`, `tests/` or the docs. What remains of the word: the
railway level crossing stops road "traffic" (the capstone, chosen because it is no course's assignment), the rules
in these docs, and `tests/corpus/expectations.cs303.json`, which is git-ignored (it quotes the course files the
corpus test reads where they are, never copied). No file in the site has the content of a file in the CS303 folder
(SHA-1 of every file; the only match is the empty probe `tests/corpus/probes/empty-file.sctx`).

## Fixed on 14 October 2026 (from the workstreams' open requests and the reviews)

- **Engine, KIELER's verdict**: five kinds of chart the engine accepted and KIELER rejects in gcc are rejected now,
  with gcc's first message (21 new probes in `tests/engine/kieler/rare/`, recorded with the lab server; official
  0.3.0 agrees; rule S-72 in `semantics/structure.md`): a string literal whose escape breaks the C code (`"a\nb"`,
  `"a\"b"`, a trailing `\`; code `c-string`), `%` on a float (`c-float-modulo`, also `%=` and in methods), a
  parameter or local named `d` in a method or code effect that KIELER keeps as a C function (`c-name`; an inlined
  method's `d` and a loop counter stay accepted), and an `extern` function named without a call
  (`extern-not-called`, `‘absolute’ undeclared`). The `c-keyword` wording is gcc's for each keyword (`char`,
  `double`, `union`, `volatile`, `long`, …).
- **Engine, messages**: after a division by zero, every later step names the tick in which the simulation stopped
  (`Diagnostic.tick`), and the hint names the chart's divisor (`if B != 0`). The chained-comparison hint is
  `x > 0 && x < 10` (`0 < x` in a trigger is a count delay). The host-code `unsupported` hint no longer promises
  that KIELER accepts the chart; where the recording says it does, the frame says so. `return v;` says that a
  `return` takes no `;` (and no longer cascades into "States must be inside an scchart"), and a keyword as a class
  method's name (`void reset()`) says it is a keyword.
- **Widgets**: the guide's own lints (`ternary-grouping`, `swallowed-line`) are listed as notes, not KIELER
  warnings; *About this message* links for `count-delay-reset`, `c-name`, `c-string`, `c-float-modulo`,
  `state-access` and `extern-not-called`; headings balance (above); the page lede is weighted for search.
- **Playground**: the inline playground starts on engagement and its static code is a focusable region (above);
  the for-region ×n badges and "active in n of m copies" names on its diagram; *Compare with the model solution*
  says that a chart the browser cannot run cannot be compared, instead of reporting a run-time error; negative
  numbers in comparisons use U+2212; quick fixes read `Diagnostic.suggestion`.
- **Content**: `learn/hierarchy`'s Shadowing Sim traces `Outer.count`; the comparison-chain advice on
  `learn/variables` and the cheat sheet's trap 16 (`x > 1 && x < 3`); the cheat sheet's row for a primed name;
  `reference/errors` splits the `d` messages (a local, a parameter) and dates `abs` (an error from gcc 14 on);
  the causality chapter's description.
- **Docs**: ARCHITECTURE.md (the Engine API's `forCopies`, `copies`, `ranWith`, an error's tick, `suggestion`; the
  playground's exercise banner, Watch and Run until and links in an open tab; Vite's dependency cache shared with
  the dev server); DESIGN.md (a historical sentence); `packages/engine/src/sim/STATUS.md` (the new codes).
- **QA tools**: `keyboard.mjs` drives a *How KIELER reads it* frame (a trap, then typing).

## 11 November 2026

Checks run on the production build: tests, types and build (6540 passed, 38 skipped; 0 errors, 0 warnings, 12
hints, as before the changes; no build warnings); links without `--external` (7135 links on 48 pages, 7011
internal: no problems); meta (no problems); search (every term finds its page first); `pages.mjs` in light-1280
and light-390 (96 page loads, no problems; `/start/tools/` and the 404 page CLS 0); the playground e2e suite
(`PLAYGROUND_E2E=1`, 23 passed); `/start/tools/` and the 404 page looked at, at 1280 and 390.

- **Engine**: `parseExpression` gives KIELER's words for 68 % of broken texts (was 61 %): new rules in
  `kielerWording.ts` (`recovered`), checked on 1500 fresh texts recorded with the oracle and added to
  `tests/engine/kieler/expressions/wording.json` (3119 texts; none worded wrongly). See STATUS.md.
- **Corpus**: the four CS303 files edited after their recording are recorded again, so no CS303 verdict is
  skipped. They now import charts next to them; the recorder opens each file alone, as the engine sees it, and the
  lab server words that broken import differently from KIELER (`Broken import: there is no X.sctx next to this
  file.`), which the corpus test maps to KIELER's wording. Official KIELER 0.3.0 hangs compiling such a chart, so
  it cannot record these.
- **Oracle**: finds a full JDK 21 itself (`tools/oracle/java.mjs`: `SCCHARTS_JAVA`, else the extension build's
  runtime cache, else `java`); the old default on `/mnt` is gone.
- **Playground**: Run until runs its ticks without drawing them (`SimHost.stepQuietly`) and draws every 100 ms and at
  the end (`settle`): 1000 ticks take about 0.1 s instead of 3 to 4 s. The e2e test covers a goal never reached.
- **Content**: `start/tools` has a screenshot of SCCharts Lab 0.10.0 (`public/images/sccharts-lab.webp`, the Washer
  from `learn/hierarchy` after four ticks; it links to the full-size image). The 404 page no longer shows
  "Report a mistake on this page" (its own text asks for a broken link to be reported).
- **Extension**: the SCCharts Lab grammar (`keith-vscode/syntaxes/sctx.tmLanguage.json`, main branch) highlights
  `deep`, under Unreleased in its CHANGELOG.

## 11 November 2026: official KIELER 0.4.3

KIELER released 1.6.0 and 1.6.1 (October 2026); the official KIELER VS Code extension 0.4.3 ships 1.6.1, which is
the fork's upstream base plus one diagram line (now ported to the server). Every recorded scenario was run
through the 0.4.3 jar (`tools/oracle/official-diff.mjs`, results in `semantics/basics.md` 10.1): no chart that 0.4.3
accepts is rejected by the lab, values agree except for string inputs, and 0.4.3 still never answers on the
crashes the lab reports. Checks: `pnpm exec vitest run` (6494 passed, 84 skipped: the opt-in browser, e2e and
Java suites), `pnpm check` (0 errors, 0 warnings, 12 hints), `pnpm build`, links (7142 links, no problems).

- **Content**: the guide names no KIELER version. "Official KIELER" and "the KIELER VS Code extension" mean the
  current release, and only differences that hold for it are described; everything about 0.3.0 is gone from the
  pages (it stays in the specs as evidence). Claims written against 0.3.0 that 0.4.3 contradicts were corrected
  (`'bool'` wording, `output const`, extra call arguments, `b = a` on enums, a `for` bound that is a name now never
  answers, `weak suspend` without `if` never answers). Eclipse KIELER needs Java 21.
- **Engine**: the S-71 `kieler-divergence` warning on a called `^` method is gone; 0.4.3 compiles that chart.

## Not fixed (for the owners)

- **Engine**: the remaining 32 % of broken texts keep the guide's own message only; what is left is the shape where
  KIELER backtracks to an earlier operator by precedence, which no simple rule predicted without mistakes. Validation
  after a syntax error stays withheld on purpose (STATUS.md).
- **Widgets** (by choice, not bugs): inline code over 12 characters (16 without spaces) in prose, captions and
  phone tables may break at its spaces (the best that fits at 390 without scrolling); `advanced/time` keeps five
  collapsed loop-warning lines, one per widget.
- **Playground** (by choice): charts that fit only below 40 % open at 70 % from their top left (readable; Fit shows
  the whole).
- **Owner decisions**: dark mode stays off until it gets a design pass.
