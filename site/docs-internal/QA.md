# Production QA

The checks the site passes before it is deployed, how to run each one again, and what the last run found. Last
run: 14 October 2026 (the final round after engine-4, widgets-D, playground-4, content-D and the editors), on the
production build of the `site` branch: 48 pages, that is the landing page and 45 guide pages, the playground and the
404 page. Re-run all of it after a change to the shell, the widgets or the build, and the relevant parts after
content changes.

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
suite whenever the dev server is up.

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

## Fixed in this round (from the workstreams' open requests and the reviews)

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
  the dev server); DESIGN.md (a historical sentence); `src/engine/sim/STATUS.md` (the new codes).
- **QA tools**: `keyboard.mjs` drives a *How KIELER reads it* frame (a trap, then typing).

## Not fixed (for the owners)

- **Engine**: KIELER rejects a backward `goto` in a code block that it inlines (`effect-code-goto`, `Can't schedule
  from _g3 to _g3`), even one a condition ends (content-D's `goto-back-guarded`); the engine accepts both. Which
  blocks KIELER inlines (no loop, under 30 nodes) needs probes first. Also: a trigger with a conditional without an
  `else` (`if (c) ? a`) keeps the previous tick's guard in KIELER; `pre(x)` next to `pre(x, c)` shares one memory per
  variable; an out-of-range constant index write (`a[3] = 9` with `int a[3]`) lands in the next variable in KIELER
  and nowhere in the engine (the cheat sheet and for-regions describe KIELER, so the playground contradicts them on
  these charts; no example uses them). `describeTick` names elements inside reference copies by internal id
  (`LampPanel.Left/PushSwitch.Off`) and formal name; an inlined method's `if`s are logged as checks after the Take
  (`advanced/methods`, Thermometer); `traceableVariables` gives a for-region state's local one key for all copies
  (`local-per-copy`); `parseExpression` has KIELER's wording for 61 % of broken texts; the `(did you mean 'X'?)` part
  of messages can now get backticks. Validation after a syntax error stays withheld on purpose (STATUS.md).
- **Widgets**: after a run-time error Step stays enabled and each press adds a tick with the same error (the message
  now names the right tick; disabling Step needs the focus kept, as Back does); `.sc-source`'s 32rem cap scrolls with
  no visual cue; short inline code in prose and captions can break mid-expression at 390; a copy state's accessible
  name says "left in this tick" for the union of the copies (`TickResult.copies` has no `exited`); code over 12
  characters in phone tables breaks at its spaces (the best that fits without scrolling); `advanced/time` keeps five
  collapsed loop-warning lines, one per widget, by choice.
- **Playground**: at 390 the Simulate tab's diagram head shrinks the chart's name to one letter; the inline
  playground grows by about 185 px when it starts (after the reader's input, so not counted as layout shift), its
  static diagram sits under the zoom buttons, and without JavaScript it still shows a Step bar that cannot work;
  shared-run notes name only the inputs that changed; Run until takes about 4 s for 1000 ticks; the watch reads only
  the top-level data pool; charts that fit only below 40 % open at 70 % from their top left; `runInputs` could use
  `TickResult.ranWith`.
- **Content**: the 404 hero's right two thirds stay empty at 1280.
- **Owner decisions**: the report channel (`REPORT_URL` in `src/components/site.ts` is unset, issues are off on
  Fallstop/sccharts-lab, and `reference/about` points to the Marketplace Q&A meanwhile); the upstream SCCharts Lab
  grammar lacks `deep` (the site's copy has it); a real screenshot of SCCharts Lab for `start/tools`.
- **Commit**: nothing of this round is committed. engine-4's `forCopies`/`copies` work, widgets-D's lanes and badges
  (with `tests/widgets/trace-extras.test.ts`) and the for-regions page that describes them belong in one commit.
