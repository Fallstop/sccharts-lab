# SCCharts Guide: design

How the site looks, why, and how to use it. Owner: the design workstream. Read this before you style a
component or write a chapter.

## Name and titles

- **Site title (header, `<title>` suffix):** `SCCharts`. The header lockup adds the subtitle *an
  interactive guide* from 34em up (`src/components/overrides/SiteTitle.astro`).
- **The guide's full name:** *SCCharts: an interactive guide*. It is the landing page's `<title>` and
  `og:title` (`src/content/docs/index.mdx`, `head` frontmatter), and the name to use when linking to
  the site from elsewhere.
- **Page titles:** `<Chapter title> | SCCharts`, e.g. *Thinking in ticks | SCCharts* (Starlight's
  default with `title: 'SCCharts'`).
- **Landing headline:** *Statecharts, one tick at a time.*

## Identity

The subject is synchronous reactive programming: a program reacts in discrete ticks, and its states and
transitions are drawn as KIELER draws them. The readers are students and engineers who move between this
site and KIELER or SCCharts Lab all day. So the site is a calm, precise engineering handbook whose
ornament is the notation itself:

- **The notation is the ornament.** Every decorative device is a piece of SCCharts notation or of a
  timing diagram, and means what it means in a chart:
  - buttons and "you are here" markers are **states** (capsules with KIELER's blue-grey gradient);
  - the primary action, the first step and the start of the learning path are **initial states**
    (heavy outline); the chapter summary and the end of the path are **final states** (double outline);
  - the header's bottom edge, horizontal rules and the chapter ruler are **time axes** (a tick every
    8 px, a longer one every eighth);
  - the stage behind a diagram is a faint **graticule** (dot grid), as on a scope screen.
- **Colour carries meaning, never decoration.** Plum is the language (KIELER's keyword colour: links,
  keywords, focus). Red is *active now* (KIELER's current-state red). Blue is *what just happened*
  (KIELER's traversed blue: taken transitions, entered states, the latest tick). Green is *terminated /
  correct*. Nothing else is coloured.
- **One loud moment.** The landing page's live chart replays its opening once (seven ticks), then
  waits for the reader. Everywhere else motion only answers the reader (a pulse runs along a transition
  when it fires; a tab switches). `prefers-reduced-motion` turns all of it off.
- **Light and dark are equals.** Light mode is KIELER's own look on the page; dark mode is the same
  notation on a blue-graphite ground. Both meet WCAG AA. Without JavaScript the page follows the system's
  colour scheme (Starlight alone would always be dark): `src/components/overrides/theme-middleware.ts` drops
  the server-rendered `data-theme="dark"` from `<html>`, and a PostCSS plugin (`src/styles/no-js-theme.mjs`,
  registered in `astro.config.mjs`) gives every `[data-theme=…]` rule a copy for `:root:not([data-theme])`
  under `prefers-color-scheme`; Expressive Code's code blocks do the same on their own. With JavaScript,
  Starlight's ThemeProvider sets the attribute before the first paint, so nothing flashes.

What the site deliberately does not do: cream paper with a serif display, a black page with one neon
accent, identical rounded cards with soft shadows, all-caps eyebrow labels, `A · B · C` meta strings,
monospace for decoration (mono is only for code and identifiers), arrows appended to link text.

## Colour

Tokens live in `src/styles/tokens.css`. Starlight's convention: `:root` is the dark theme,
`:root[data-theme='light']` the light one. Our CSS uses the `--c-*` tokens; Starlight's own `--sl-*`
variables are mapped onto them, so built-in UI (search, sidebar, asides, tabs) matches.

### Base palette

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--c-paper` | `#f8f9fd` | `#0f141e` | page background. Light is KIELER's state-gradient start (248, 249, 253): the page is the inside of a state |
| `--c-sheet` | `#ffffff` | `#151b27` | raised surfaces: widget frames, quiz, exercise |
| `--c-rail` | `#f1f4fa` | `#121823` | sidebar, frame headers and control bars |
| `--c-inset` | `#fbfcfe` | `#0c1018` | the diagram stage inside a frame |
| `--c-code-bg` | `#f3f5fa` | `#141a26` | code blocks |
| `--c-ink` | `#111a2c` | `#eef2f8` | headings, strong text, identifiers |
| `--c-text` | `#283246` | `#c8d0dd` | body text |
| `--c-muted` | `#536075` | `#93a0b4` | secondary text, captions, ledes |
| `--c-faint` | `#8b96a8` | `#5a667b` | decoration only, never text |
| `--c-rule` / `--c-rule-strong` | `#dce2ec` / `#b8c3d4` | `#232b3a` / `#364155` | hairlines; ruler ticks |
| `--c-control` | `#77839a` | `#69768c` | borders of interactive controls |
| `--c-accent` | `#7a1452` | `#eda6d6` | links, accent text (KIELER keyword plum, 115 0 65) |
| `--c-accent-bright` | `#a8287a` | `#f27fc7` | focus rings, current-page indicators |
| `--c-accent-soft` | `#f5e6ef` | `#34203a` | tinted backgrounds (current page, selected option) |
| `--c-signal` | `#c61f3a` | `#ff6b7d` | active state, wrong answer |
| `--c-trace` | `#1769d6` | `#5aa9ff` | taken transition, entered state, latest tick |
| `--c-go` | `#1a7f42` | `#4fd283` | termination, correct answer |

Semantic colours for asides and badges: `--c-note-*` (blue), `--c-tip-*` (green; Starlight's tips are
purple, ours are green because purple is the accent), `--c-caution-*` (amber), `--c-danger-*` (red),
each with `-ink` (text), `-bg` and `-rule` (border).

### Contrast (measured, WCAG 2.x)

Body text on paper: 12.2 (light) / 11.9 (dark). Muted text on paper, rail and inset: 5.8 to 7.2. Accent
links on paper: 9.7 / 9.7. Every code-highlighting colour on the code background: 5.4 to 14.0. Aside text
on its background: 6.6 to 10.7. Simulation highlights against the region fill (graphics, 3:1 needed):
active 5.7 / 6.5, taken 5.2 / 7.3. State labels on the darkest end of the state gradient: 11.7 / 6.1.
Control borders: 3.6 / 4.0. `node tools/contrast.mjs` checks all of these (and more) straight from
`tokens.css`; `tests/design/contrast.test.ts` runs it in `pnpm test`, so a colour change that breaks AA
fails the tests. Add a pair to `PAIRS` when you introduce a new combination. A pair can name layered
colours (a tint painted over a surface, `['--c-sheet', ['--sc-error', 0.12]]`, as `color-mix(... 12%,
transparent)` on a sheet) and translucent foregrounds (`['--c-muted', 0.9]`, as `opacity`); the code
highlighting colours are checked on every line tint of the source view (active, fired, error, focused),
and so are the timing diagram's values on the cursor column and on Compare's difference mark, the focus
ring on every surface it can appear on, and the diagnostics' colours. Line numbers are drawn at 90 %
opacity (4.5:1 still); the light theme's `--c-caution-rule` is `#b57509` so that the caution mark and the
notice border reach 3:1.

## Diagram and simulation tokens (the `--sc-*` contract)

The diagram renderer (`src/diagram`) and the widgets read exactly these names, always with a fallback:
`var(--sc-state-fill, #f8f9fd)`. KIELER's look stays recognisable: blue-grey gradient states, black
outlines on initial and final states, grey outlines on the others, plum declaration keywords, red
strong-abort dots, green termination triangles, yellow comments, red current states and blue traversed
transitions in simulation.

| Token | Light | Dark | KIELER |
| --- | --- | --- | --- |
| `--sc-font` / `--sc-font-mono` | Atkinson Hyperlegible Next / Mono | same | |
| `--sc-root-fill` / `--sc-root-stroke` | `#fafbfe` / `#a3aebd` | `#141a26` / `#4a5873` | root state |
| `--sc-state-fill` → `--sc-state-fill-end` | `#f8f9fd` → `#cddcf3` | `#3a4760` → `#4f5d7a` | state gradient (248 249 253 → 205 220 243) |
| `--sc-state-stroke` | `#182030` | `#dfe5ef` | initial (3 px) and final states: black |
| `--sc-state-outline` | `#7d889b` | `#8592a8` | simple states and superstates: grey (new; see below) |
| `--sc-state-text` | `#111826` | `#f3f6fa` | state names |
| `--sc-superstate-fill` → `-end` | `#fafbfe` → `#e3ebf8` | `#1d2536` → `#26314a` | superstate gradient |
| `--sc-region-fill` / `--sc-region-stroke` / `--sc-region-label` | `#ffffff` / `#b4bfce` / `#5b6678` | `#121822` / `#3f4b62` / `#a3aec0` | regions |
| `--sc-keyword` | `#730041` | `#f0b2df` | declaration and action keywords (115 0 65) |
| `--sc-decl-text` / `--sc-action-text` | `#182030` | `#dfe5ef` | declarations, actions |
| `--sc-edge` / `--sc-edge-label` / `--sc-edge-label-bg` | `#182030` / `#111826` / white 86% | `#d4dbe7` / `#eef2f8` / paper 86% | transitions |
| `--sc-strong-abort` | `#dc2633` | `#ff5c6c` | strong-abort dot (red) |
| `--sc-termination` | `#1c9a43` | `#48d17c` | termination triangle (green) |
| `--sc-history` | `#3c3c3c` | `#c9d1dd` | history marker (60 60 60) |
| `--sc-comment-fill` / `-stroke` / `-text` | `#fffbd1` / `#d4c23a` / `#2b2a1e` | `#353222` / `#8f866a` / `#ede6d2` | comments (yellow) |
| `--sc-shadow` | ink 14% | black 50% | state drop shadow (new; see below) |
| `--sc-active-stroke` / `--sc-active-fill` / `--sc-active-glow` | `#c61f3a` / `#ffe7ea` / red 30% | `#ff6b7d` / `#4a2232` / red 42% | current state (red) |
| `--sc-taken` / `--sc-taken-glow` | `#1769d6` / blue 26% | `#5aa9ff` / blue 40% | traversed transition (dodger blue) |
| `--sc-entered` | `#1769d6` | `#5aa9ff` | traversed state |
| `--sc-error` | `#c4361c` | `#ff8a65` | diagnostics |
| `--sc-active-width` / `--sc-taken-width` / `--sc-glow-width` | `3.5px` / `3px` / `7px` | same | highlight geometry |

**Highlights never rely on colour alone.** An active state gets the red outline *and* a thicker stroke
(`--sc-active-width`) *and* a halo (`--sc-active-glow`, drawn as a wider stroke underneath or a
`drop-shadow`) *and* a bold name. A taken transition gets blue *and* a heavier stroke *and* a halo, its
label box a blue outline, and a one-off pulse runs along it when it fires (not under reduced motion).

**Highlights never add dashes.** In KIELER's notation a dashed transition is an immediate one, so every
edge keeps its own dash pattern in a simulation: a delayed transition that fired is solid, an immediate one
dashed. A state left in the tick (or entered and left within it) gets a solid outline in `--sc-entered` and
a tint of it that fades; an element a compiler message is about, a solid `--sc-error` outline with a glow
and a marker, a small `--sc-error` disc with a "!" (`markErrors` in `src/components/sim/link.ts`, called by
`markDiagram` and by DiagramView for errors drawn at build time). Only `is-focus` (pointer and keyboard)
outlines a state with dashes; a focused transition stays solid. The landing chart (`src/components/landing/HeroChart.astro`) is the reference
implementation; the diagram renderer's `src/diagram/diagram.css` follows the same rules.

Two tokens were added beyond the original list, for the diagram workstream to adopt:
`--sc-state-outline` (KIELER draws simple states and superstates with a grey outline; with
`--sc-region-stroke` that outline is only 1.6:1 against the state gradient, `--sc-state-outline` keeps
the grey look at 3:1 against the region) and `--sc-shadow` (a drop shadow that is darker than the ground
in both themes; `--sc-edge` at 12% turns light in dark mode).

### Timing diagrams

`src/components/frame/wave.ts` (`renderWave`) draws the guide's waveforms; `src/styles/wave.css` styles
them. One lane per variable, one column per tick, inputs first, then outputs, then the active state,
with a little gap between the groups. Booleans and pure signals are a line, high while true / present,
with the area under it filled (`--sc-wave-fill`, the state-gradient blue). Other values are a bus of
hexagon-ended segments that carry the value. The latest tick's column is shaded (`--sc-wave-cursor`)
and its number is bold. Variable names are monospaced (they are identifiers). Tokens:
`--sc-wave-line`, `--sc-wave-fill`, `--sc-wave-grid`, `--sc-wave-text`, `--sc-wave-value`,
`--sc-wave-cursor`.

- **Columns** are as wide as the longest state name (40 to 72 px) and, while every tick drawn still fits,
  as the longest value, so a short trace writes `97321` in full (`columnWidthForTrace`); a long trace keeps
  the narrow columns and scrolls, a cut value showing its full text as a tooltip.
- **Scrolling.** The lane names stay put (sticky, on an opaque ground with a hairline at their edge); the
  trace scrolls only when the tick shown would be out of view beside them, and only as far as needed
  (`keepTickInView`). The screen-reader table sits in a hidden wrapper, so it never widens the scroll area.
- **Termination** is a small green triangle in the tick header; in `Compare` each chart's own triangle sits
  in its caption row (`groupMarks`).
- **Suspended spans.** A state lane whose region a `suspend` froze in a tick is hatched there (thin 45°
  lines over the value's shape, under its text), the table says "suspended", and a legend under the trace
  explains the hatching (`.sc-trace-legend`), shown only when the run has such a span.
- **For-region copies.** The engine reports the copies (`CompileResult.forCopies` before the first tick,
  `TickResult.copies` per tick: per copy, its active and entered states), so each copy gets its own lane from
  tick 0, named with the counter (`Seat i=2`; an unnamed for-region of the chart is `region i=2`, the regions
  inside a copy `W i=2`), and on the diagram (which draws the region once) each state active in some copies
  gets a badge with their number (`×3`, `markCopies`). Its accessible name says what it did per copy rather
  than for all of them at once (the diagram's marks are the union): "initial state Open, active in 3 of 4 copies
  (i = 1, 2 and 3), left in this tick in the copy i = 0" (`copyMarks`, `copyPhrase` in `trace.ts`: the engine reports
  each copy's active and entered states, and the states left are worked out from the tick before).

## Typography

Fonts are self-hosted through Fontsource (registered in `astro.config.mjs` `customCss`):

| Role | Face | Why |
| --- | --- | --- |
| Text, UI, H2 and below | **Atkinson Hyperlegible Next** (variable, 200–800, with italics) | drawn by the Braille Institute so that easily confused letters differ: `I`, `l`, `1` and `O`, `0` never look alike. Charts are full of one-letter names (`A`, `B`, `R`, `O`, `I`) next to digits. |
| Code and identifiers | **Atkinson Hyperlegible Mono** (variable) | the same skeleton, so inline code sits naturally in a sentence |
| Page titles and the landing headline only | **Archivo**, expanded (`font-stretch: 112%`, weight 580) | the extended grotesque of instrument front panels (scopes, logic analysers). It appears once per page. |

Scale (rem at 16 px): 12, 13, 15, **18** (body), 20 (ledes, quiz questions), 24, 30 (h2), 36 / 46 (h1 on
phones / from 50em); the landing headline is fluid, 38 to 68 px. Body line height 1.65; headings 1.15.

Measure: at most about 75 characters per line (`--measure: 32em`). It is set in em, not ch: Atkinson's
zero, which `ch` measures, is 0.65 em wide while the average character is 0.425 em, so `68ch` would allow
about 100 characters. The content column is wider (`--sl-content-width: 44rem`), so widgets, code and
tables get room while paragraphs, lists, headings, asides, quizzes and exercises keep the measure.

Heading rhythm: more space above than below (h2: 2.75rem above, 0.625rem below), so a heading belongs to
what follows. Numbers in tables and counters use tabular figures.

## Layout

- Starlight's three columns: sidebar 17.5rem, content up to 44rem, "On this page" from 72rem.
- Phones (390 px): 16 px gutters, the sidebar becomes Starlight's menu, frames keep a 12 px inner padding,
  tables and code scroll inside themselves, never the page. Tables get tighter cells below 40rem and a size
  smaller below 30rem, headers wrap, and code in a cell never breaks inside an expression it can keep whole: up
  to 12 characters it stays on one line even with spaces (`x += 1`, `c ? a : b`: `.sc-nobr`), longer code whose
  words are short breaks only at its spaces (`.sc-words`), and only a long name or token (more than 16
  characters) may break anywhere, so tick tables of up to six columns fit 358 px; a table that still scrolls shows a soft shadow at the edge
  with more to see (covers in `--sc-table-bg`, the surface it sits on: paper, a `details` box's sheet, an
  aside's tint). `details` boxes keep 10 px side padding on phones.
- The landing page is a splash page (67.5rem wide): hero (copy and live chart side by side from 64rem,
  stacked below), *What you'll learn*, *Ways in* (a full row, two by two, a full row from 48rem; one column
  below), *Credits*, each separated by a hairline.
- `/playground` is full width: editor | diagram on one row from 60rem, simulation underneath.

## Chrome

- **Header:** the mark, *SCCharts* in Archivo, *an interactive guide*; search; theme switch. Its bottom
  edge is the tick ruler.
- **Mark** (`public/favicon.svg`, `src/components/overrides/LogoMark.astro`): an initial state (a capsule
  with a heavy outline) holding a pulse one tick wide. The inline version follows the theme through the
  `--sc-*` tokens; the favicon switches with `prefers-color-scheme`; `public/apple-touch-icon.png` is the
  light version on paper. The social card `public/og.png` shows the mark, the headline and the landing
  chart; `node tools/og-image.mjs` re-renders it.
- **Sidebar:** Playground first (a state-shaped link), then *Start here*, *Learn*, *Going further*,
  *Patterns*, *Reference*. Learn chapters are numbered and joined by a line (they are read in order);
  the other groups are not numbered. The current page is a plum capsule.
- **Chapter ruler** (`src/components/overrides/PageTitle.astro`): above a Learn chapter's title, the
  twelve chapters as a timing diagram whose signal is high in the current chapter. Each tick links to
  its chapter; screen readers hear "Learn, chapter 4 of 12".
- **Lede:** the page's `description` frontmatter, under the title, in muted 20 px text. Write it as one
  plain sentence.
- **Pagination:** Previous / Next as bordered blocks. `start/welcome` has `prev: false` (the sidebar
  starts with the Playground link); `/playground` has neither.
- **Report a mistake** (`src/components/overrides/Footer.astro`): "Report a mistake on this page" above the
  footer, linking to `REPORT_URL` in `src/components/site.ts` with `{url}` and `{title}` filled in (the page's
  address and title, URL-encoded; a template without `{url}` gets `?page=<url>`). `REPORT_URL` is undefined by
  default, since the repository has issues turned off, and then nothing is rendered. To turn it on, set it, for
  example to `'https://github.com/<owner>/<repo>/issues/new?title=Mistake%20on%20%22{title}%22&body=Page:%20{url}'`
  or a `mailto:` address, and rebuild.

## Widget frame

Every interactive widget sits in the same frame, `src/components/frame/WidgetFrame.astro`. It owns the
look; the widget owns what goes inside.

```
figure.sc-frame.sc-frame--<kind>                     kind: chart | sim | compare | playground | predict | hero
├─ div.sc-frame__box   (border, radius, shadow; data-pagefind-ignore)
│  ├─ header.sc-frame__head
│  │    [glyph] Name  kind label      div.sc-frame__tools: [ Diagram | Code ]  Open in the playground
│  │     │      │     └ "Simulation", "Chart", …                                └ prop `playground` or slot "actions"
│  │     │      └ chart name, monospaced (it is an identifier); a long one wraps, never cut off
│  │     └ a small state; red-ringed (active) for widgets that run
│  ├─ div.sc-frame__stage        one section.sc-frame__panel per view (slot "view-<id>"), or the default slot
│  ├─ div.sc-frame__controls     slot "controls": reset, back, Step (an initial-state button), run, tick counter, inputs
│  ├─ div.sc-frame__trace        slot "trace": the timing diagram (scrolls sideways if it must)
│  └─ div.sc-frame__foot         slot "foot": what the last tick did and why, scenario notes, results
└─ figcaption.sc-frame__caption  prop `caption` (inline Markdown), outside the box
```

Props: `kind`, `name`, `label`, `views` (`[{ id, label }]`), `defaultView`, `caption`, `playground`
(URL), `stage` (`'tall'` reserves 14rem for a diagram). The head is one row when everything fits; the view
switch and the actions wrap together (the link never takes a row of its own), and a head narrower than 36rem
(a container query: phones, a tablet's column) with views and a link puts the name on the first row and the
tools on the second, the views at the start and the link at the end (below 30em only its icon). With JavaScript the views are ARIA tabs (arrow
keys, Home, End); without it every view is shown, one after the other, each with a small title. The frame
dispatches `sc-frame-view` (detail `{ view }`) when the view changes, so a widget can lay out a diagram
the moment it becomes visible.

Parts for the inside (all in `src/components/frame/`, styles in `src/styles/widgets.css` and
`wave.css`):

- `SourceView.astro`: an example's source, highlighted (`sctx`), with Expressive Code's copy button. A source
  taller than 32rem scrolls inside, its bottom fades out until the end is in view, and a bar under it (a dashed
  rule, then a quiet button) says *Show all 46 lines* / *Show fewer lines* (`aria-expanded`); the script measures
  whether the code is cut off, also when a hidden view is shown. Without JavaScript the code scrolls; in print it
  is shown in full.
- `DiagramView.astro`: a pre-rendered diagram on the graticule, with zoom, hover / focus linking with the
  Code view and keyboard access (see "Keyboard and screen readers").
- `SimControls.astro`: a disabled control bar for server rendering (the playground shows it until its
  island hydrates). Keep its class names: `.sc-simctl`, `.sc-simctl__buttons`, `.sc-simctl__tick`,
  `.sc-input--bool` (a switch whose knob sits low or high, like a waveform level), `.sc-input--value`.
- `examples.ts`: `loadExample(id, usedBy)` bundles every `src/examples/**/*.sctx` (and
  `.scenario.json`) at build time; a missing file throws `<Sim example="x/y">: no example file at
  src/examples/x/y.sctx …`, which fails the build. Also `interfaceOf` (regex-level, for placeholders
  only), `chartNameOf`, `playgroundHref`.
- `wave.ts`, `inline-md.ts`, `icons.ts`, `ids.ts` (deterministic ids).

Buttons (`.sc-btn` in `theme.css`) are states: a capsule with the state gradient. `.sc-btn--initial`
(heavy outline) is the one primary action in a group (Step, Start learning, Check answer, Open the
starter). `.sc-btn--quiet` for the rest, `.sc-btn--sm` in frames, `.sc-btn--icon` for icon-only buttons
(always with `aria-label`).

### The MDX components (`src/components/guide.ts`)

| Component | State | Notes |
| --- | --- | --- |
| `Chart` | done | views Diagram / Code / Both (`code={false}` hides Code and Both). The diagram is laid out and rendered at build time. Hover links diagram and code (`is-focus` on both; the Both view shows them together). `highlight` (ids or unique state names) pins `is-focus` and marks the lines; `view` picks the first view; `references="expanded"` draws reference states with the referenced chart inside (ids `<reference state>/<inner id>`). A chart KIELER rejects (its recording says so) is drawn with `is-error` marks and its messages in the foot: the errors that make it fail first (message, KIELER's exact words, hint), then its warnings; an accepted chart's warnings sit in a closed `details`; a `kieler-divergence` / `kieler-nondeterministic` notice is an open caution box |
| `Sim` | done | Diagram / Code / Both, then the SimPanel island (`client:engage`: hydrates when the reader first points at, touches or tabs into the widget): controls, inputs, trace, foot. Props `scenario`, `show` (also `deltaT`, `sleepT` and other variables the compiler adds, inner locals as `Outer.count` and members as `pt.x`, from the engine's `trace`), `caption`, `regions` (default true: a trace lane per region), `view`, `references`. A rejected chart shows its messages instead of the controls; a chart KIELER accepts that the engine cannot run shows a caution note instead (never "rejected"); KIELER's warnings are listed under the panel (closed `details`), notices open. In the tour the input switches show the inputs of the tick shown (legend "Inputs of tick n of the guided tour"). Timed charts: *Advance by sleepT* after the `deltaT` field |
| `Compare` | done | two panes (side by side from a 40rem stage), one control bar for both, the union of the inputs; one trace with the inputs once and each chart's lanes under its name, each chart's termination triangle in its caption row; outputs both charts have are marked (dashed red) in the ticks where they differ, and the difference line also says which chart terminated ("`OnceBool` terminated in tick 2; `Once` did not."). `show` as for `Sim` (each chart traces the names it declares; locals both have are compared). `scenario` (`'a'` default when a has one, `'b'`, another scenario id, `{false}`): a guided tour on both charts, as in `Sim` (note, the tick's differences, Previous / Next / Take over, *Restart the guided tour*; without JavaScript the tour's inputs and notes as a list). Warnings per chart under the panel, labelled with the chart's name |
| `Playground` | frame final, internals by the playground workstream | editor and diagram (side by side from a 56rem stage), controls, trace |
| `Predict` | done | Code / Diagram / Both (`view`: the one shown first, default Code; hover links diagram and code), the caption first in the foot (it sets the question up), inputs per tick (held values in grey), the questions as form fields; *Run and check* plays the scenario on the diagram (switching to it unless the view shown has it), then marks each answer right (green, tick) or wrong (red, dashed, cross, with the real value) and shows the trace: the scenario's ticks only, no empty columns, with the legend for suspended spans. `state` takes an id or a unique state name; a pure signal's `value` asks for presence, a valued signal's for its value. Build error only when KIELER's recording rejects the chart; when the engine cannot run it, *Check* compares the `value` answers with KIELER's recorded run (a `state` answer is left unmarked, with a sentence why) |
| `Quiz` | done | `answer` is the **0-based** index. Radios in a fieldset; *Check answer* marks right (green, tick) or wrong (red, cross) and shows the right option (dashed green); the explanation is a `details` that opens on checking and is the whole fallback without JavaScript |
| `TryIt` | done | task (children), *Open the starter in the playground* (`/playground/?example=<id>`, plus `&solution=<id>` when the exercise has a solution), then three closed `details`: the starter's source, the `hint` (inline Markdown, optional) and the solution |
| `KeyIdeas` | done | the chapter summary, drawn as a final state (double outline) |
| `HowKielerReads` | done | imported on its own (`~components/HowKielerReads.astro`). A frame of kind `reads` ("How KIELER reads it"): a text field (monospaced), "Read it as" an expression or effect / a trigger after `if`, trap buttons (pressed when loaded); below, KIELER's grouping fully parenthesised (large, bold, code) and as a tree (a nested list joined by lines: operators in keyword plum with their name in words, atoms as code chips), a count delay in words, KIELER's warnings; or the syntax error (head with the error mark, the text with a caret under the column, the message, the hint, *About this message*). The reading is `src/components/reads/reading.ts` (the engine's `parseExpression`, `formatExpressionParenthesised`; the chart parser for triggers). A polite live region says the result 0.6 s after typing stops. `client:engage`; the first example is server-rendered |

The widgets' parts:

- `frame/DiagramView.astro`: a pre-rendered diagram on the graticule; fits the width, scrolls sideways
  below 60 % of its natural size, and offers *Actual size* when it is shown smaller than 85 %. Carries the
  chart's line map (`script[data-sc-map]`) for hover linking with `[data-sc-code]` in the same frame.
- `frame/prepare.ts` (build time only): compile (with the example's imported files), lay out (cached per
  source and references view), render, and decide what to say: `rejected` only when KIELER's recording says
  so (without one: the engine, or `"expect": "error"`); `cannotRun` when KIELER accepts what the engine cannot
  run; `errors` (the engine's, paired with KIELER's recorded wording by text or line, then KIELER-only
  messages), `warnings` (validation and compiler warnings, KIELER's notes; never internal noise such as
  "required feature" or "VariableStore"), `notices` (`kieler-divergence`, `kieler-nondeterministic`).
  Recorded LSP severities: 1 error, 2 warning.
- `frame/Diagnostics.astro`: notices (open caution box: `.sc-diag--notice`), the errors of a rejected chart
  (`.sc-diag--error`: line, the guide's message, *KIELER says:* its exact words, hint; a message only KIELER
  has is shown as KIELER's words alone), then warnings and notes in a closed `details` (`.sc-diag--warning`,
  "Also:" after errors). A *Warning* is KIELER's (or the C compiler's, "The C compiler says:"); a *Note* is the
  guide's: its explanations of KIELER's quirks and bugs and its own lints (`ternary-grouping`, `swallowed-line`;
  `diagnosticKind` in `frame/diagnostics.ts`), counted apart ("1 warning and 2 notes"), as `reference/about`
  promises. `name` labels them for `Compare`. Each error and warning that `reference/errors`
  explains ends with *About this message* (`a.sc-diag__about`, small, plum), except on that page itself. The
  head's mark (`.sc-diag__mark`) is an error state: a capsule with a solid `--sc-error` outline and the marker
  disc at its corner; `--caution` drops the disc.
- `frame/error-links.ts`: `errorLink(diagnostic | code | KIELER's words)` → `/reference/errors/#<anchor>` or
  undefined, from engine codes (`CODES`) and patterns of KIELER's messages (`MESSAGES`); syntax errors the page
  has no section for link to *Syntax errors*, other unresolved names to *Name errors*, a KIELER crash without a
  section of its own to *Internal errors*; a code that stands for several of KIELER's messages (`static-access`)
  goes by KIELER's words. `tests/widgets/error-links.test.ts` slugs the page's headings
  as Astro does (github-slugger) and fails when an anchor disappears, when a message heading is not reachable
  from its own words, or when an example the page opens does not link back to its section. SimPanel's and
  CompareSim's rejected views and the playground use it too.
- SimPanel's rejected view (the playground): messages and hints with inline code, *About this message*, and
  the `verdict` prop: `'recorded'` (KIELER's recording of this very chart rejects it: "KIELER rejects this
  chart", "KIELER says:") or `'engine'` (the default, a chart only the guide's checker has seen: "The guide's
  checker found a problem in this chart, so it cannot run", "KIELER rejects charts with this problem too.",
  "KIELER's wording:"; it never claims KIELER has seen the chart).
- Inline Markdown (`frame/inline-md.ts`, captions and notes): `code`, **bold**, *italic*, links, backslash
  escapes. Short code (12 characters or fewer, or 16 without spaces) gets `.sc-nobr` (no line break inside, so `->` never
  splits); the same rule marks inline code in MDX pages (a rehype plugin in `astro.config.mjs`). Straight quotes
  and apostrophes outside code become curly, as Astro's Markdown makes them on the pages. Compiler messages use
  `inlineCode` (code spans only, quotes as written).
- `src/components/sim/`: the simulation (SimPanel and its pure modules; see its README).
- The frame has a `panel` slot for a widget's own controls / trace / foot blocks (an island renders all
  three), and views may combine panels: `{ id: 'both', label: 'Both', show: ['diagram', 'code'] }`.

Simulation look (styles in `widgets.css`, `wave.css`, `diagram.css`):

- **Inputs.** A bool or pure signal is the level switch plus a pulse button (a one-tick pulse glyph):
  pressed, the input is high for the next tick only, and the chip's outline turns dashed. A valued input
  signal adds a `val(V)` number field. Inputs keep their value until changed, as in KIELER.
- **Controls.** Reset, Back (icons), Step (the initial-state button), Run / Pause and a speed select, the
  tick counter ("Tick 3 of 9" while showing an earlier tick). Keyboard while the frame has focus: Space,
  Enter or Right step, Backspace or Left back, R reset. After a run-time error (in the last tick computed, and
  shown) the simulation stays stopped, as KIELER's does: Step, Run, Next and the inputs are off, the foot's
  "What happened" keeps the tick the error happened in, and under it a note marked like a diagnostic line (a
  solid bar in `--sc-error`) offers *Restart* (an initial-state button); Back still goes back, and an input
  changed there runs a new tick from that point. In `Compare`, once a chart has stopped at an error and the other
  has stopped too (an error or termination).
- **Trace.** Inputs, outputs, then one lane per region with its active state (a mid-level dotted line while
  the region is not active; a new segment when a state is entered again). Valued signals: a bus filled
  while present, the held value muted while absent. Ticks after the one shown are dimmed; a click on a
  column shows that tick; the termination tick has a small green triangle in the header.
- **Diagram.** `is-active`, `is-entered`, `is-exited`, `is-taken` by data-id (see "Highlights never add
  dashes"); a one-shot pulse (`.sc-edge-pulse`) runs along each transition that fired, one after another for
  an immediate chain; for-region copies get count badges (`.sc-copy-badge`).
- **Code.** Line numbers in the gutter; the line of each active state gets a solid red bar, the lines of a
  transition that fired a double blue bar, the element under the pointer a dashed plum bar, a diagnostic a
  dotted bar (never colour alone).
- **Foot.** In the tour: the tick's note, Previous / Next / Take over. In free play: "What happened" (one
  line per fact, each marked with a small piece of notation) and *Explain this tick* (the engine's log in
  order); hovering a line marks its elements on the diagram.
- **Timed charts.** *Advance by sleepT (300)* (a quiet small button right after the `deltaT` field, the value
  muted and monospaced) sets `deltaT` to the `sleepT` of the tick shown and steps; disabled before tick 1.

### Keyboard and screen readers

Everything a pointer can do in a widget, the keyboard can (helpers in `src/components/sim/link.ts`, described in
`src/components/sim/README.md`):

- **Diagram.** One tab stop. The arrow keys move between states, named regions and transitions in the order
  they are written; Home and End go to the first and last. Focus links like hover (the element's dashed plum
  `is-focus`, its source lines) and a 2 px ring in `--c-accent-bright` is drawn around the element. Each element
  is named for screen readers ("initial state Off, active, entered in this tick", "transition Off to On: if
  button go to On, fired in this tick"); the SVG is a graphics document labelled with the chart's name. The ring
  (`svg .sc-focus-ring` in `widgets.css`) is not scoped to the widgets' DiagramView: the playground's stage uses
  the same rule.
- **Code.** One tab stop over the lines; Up and Down move, focus marks the element written there. A marked line
  carries its mark as hidden text ("(active state)", "(fired in this tick)", "(error)").
- **Controls.** Every control is labelled (icon buttons by `aria-label`, the inputs by their names, the
  inputs' group by "Inputs for tick n"); the tick counter is a status; each tick is announced in one sentence
  (a polite live region). A button that turns itself off keeps the keyboard's focus nearby (`keepFocus`): Back
  and Previous at tick 0 hand it to the next button, Step, Run and Next at a run-time error to *Restart*, and
  *Restart* (which goes with the error) to Step.
- **Trace.** One tab stop (it scrolls sideways): Left and Right go back and step, Home and End. Screen readers
  get a table instead of the drawing: a row per tick ("Tick 3, shown"), a column per lane.
- **Foot.** The "What happened" and *Explain this tick* lines that name elements are one tab stop per list
  (Up and Down); focus marks the elements, as hovering does (in `Compare`, on that chart's diagram).
- **Focus is always visible:** `--c-accent-bright` rings, 3:1 or better on every surface they appear on
  (checked by `tools/contrast.mjs`); mouse focus shows no ring (`:focus-visible`).

### Hydration and page weight

The islands of `Sim`, `Compare` and `Predict` hydrate with `client:engage` (`src/components/sim/engage.ts`):
when the reader first moves the pointer over, touches, focuses or types in the widget. Until then a guide page
loads about 16 kB of JavaScript (gzipped); everything visible is server-rendered, and the controls look ready.
A click made before the island is live is replayed once it is (so the first tap on Step is never lost), and
hydration reuses the server-rendered nodes (no layout shift). The first widget engaged loads the engine, which
every widget on the page shares (one chunk, about 114 kB), with Svelte and the panel: about 145 kB in all.
The landing chart keeps `client:visible`, since its opening replays when it comes into view.

### Print

Guide pages print in the light theme (a `beforeprint` script in `astro.config.mjs` switches the theme, since
diagram fills print even without background graphics). In widgets, every view prints, one after the other
with its title (Diagram, Code); the view switch, *Open in the playground*, the zoom button and the live
simulation (controls, trace, foot) do not. A guided tour prints as text: each tick's inputs and note
(`frame/TourText.astro`, the same list readers without JavaScript get). Wide diagrams shrink to the page
instead of being cut off, code prints in full, and a tall frame may break between its views. Predict prints
its questions, Quiz its question and options; their buttons do not.


## Code highlighting

Fenced blocks with the language `sctx` (alias `sct`) are highlighted with the SCCharts Lab extension's
TextMate grammar (a copy in `src/highlight/sctx.tmLanguage.json`, with one addition: `deep`, as in
`go to B deep deferred`, is a keyword like the other transition words; the extension's grammar lacks it),
registered in `ec.config.mjs`.
`ec.config.mjs` holds all Expressive Code settings so that the `<Code>` component in widgets renders
exactly like fences. Themes (`src/highlight/code-themes.mjs`): keywords in KIELER plum and bold (as KIELER's
editor does), strings blue, numbers and constants amber, comments green-grey, annotations grey. Lines
never wrap in `sctx` blocks (indentation is structure); they scroll.

## Rules for content writers

**Structure.** `##` for sections, `###` for subsections; `####` rarely. One idea per section. Every
chapter ends with Try it, Check your understanding and `<KeyIdeas>` (see CONTENT-PLAN.md, Page anatomy):
put the exercises under `## Try it` and give each `<TryIt>` a `title` (it becomes the box's heading);
put quizzes under `## Check your understanding`; `<KeyIdeas>` brings its own heading, so don't write one
before it.

**Asides.** Use them sparingly; a chapter with more than three or four is shouting.
- `note` (blue): context the reader can skip (history, a link to the full story, a simplification).
- `tip` (green): a better way to do something, a shortcut in the tools.
- `caution` (amber): a mistake beginners make. Quote the exact compiler message they will see in a code
  span, then show the fix. Give it a `title` that names the mistake ("A transition that never fires").
- `danger` (red): behaviour that silently does the wrong thing (no error, wrong result). Rare.
Never use an aside for the main point of a section; that belongs in the prose.

**Tick tables.** For behaviour over time use a table with one row per tick:

| Tick | `button` | State after | `light` after |
| ---: | --- | --- | --- |
| 1 | false | Off | false |

The first column is the tick number (right-aligned with `---:`). Inputs come next, then the state(s),
then outputs. Put variable names in code spans in the header. Mark an input that was not set in that tick
but kept its value as `false (held)`. Every row must come from an oracle run.

**Code.** Complete charts belong in `src/examples/` and appear through a widget. A fence (` ```sctx `) is
for fragments that are not complete charts; give a fence a `title` only when it is a file the reader
would create. Mark the lines you talk about with `{3-4}`. Inline code for every identifier, keyword and
value: `go to`, `A`, `true`, `pre(S)`.

**Captions.** One sentence, saying what to look at ("Watch `light` in tick 3: it keeps its value."). Inline
Markdown works.

**Steps** (`<Steps>`) for procedures (install, set up), drawn as a chain of states. **Tabs** for the
same thing in different tools (VS Code / KIELER), not for alternative explanations. **Badges** for
status labels next to a heading ("Extended SCCharts", "Not simulated"), at most one per heading.

**Words and emphasis.** Bold for the one term being defined, at its definition. Italics for emphasis,
rarely. No emoji, no exclamation marks, no colour or inline styles in MDX, no raw HTML for layout. British
spelling in prose, KIELER's spelling in code.

**Don't fight the measure.** Prose stays at 68 characters even though the column is wider; widgets use
the full column. Don't put prose inside widgets.

**Conventions the whole guide follows** (from the consistency pass):
- **Predict, then explain.** Every `<Predict>` is followed by a closed `<details><summary>Explanation</summary>`
  box; inside a chapter's text, a cue line before the widget says to predict and check first.
- **Next chapter.** Every Learn, Going further and Patterns chapter ends, after `<KeyIdeas>`, with a line
  "Next, [chapter]: …"; the last of Going further and of Patterns end with "That is the end of …" and where to go
  from there.
- **Compiler messages.** Short ones (under about 50 characters) in inline code; longer ones in a
  ` ```text wrap ` block, so they wrap instead of breaking into chips on a phone.
- **Identifiers in code font everywhere**, also in tour notes and captions (`` `Off` ``, `` `button` ``), never
  bold. A note never relies on colour ("the active state", not "the red one").
- **Example code style.** A simple state's transitions are indented two spaces under it; a superstate's
  transitions sit at the indentation of its closing brace, as in the KIELER wiki.
- **Held inputs** in tick tables are written `false (held)`, and in a column that lists the inputs that are on,
  `` `name` (held) ``; minus signs in prose and tables are `−`.
- **Short inline code never breaks**: spans of up to 12 characters, spaces or not (`go to`, `x += 1`,
  `if d != 0`), and of up to 16 without spaces (`Speed.HIGH`), get `sc-nobr` automatically (astro.config.mjs,
  inline-md.ts), in prose, captions and table cells alike; a longer one may break at its spaces (in a table cell
  only there), so no phone scrolls sideways.

## Files

| Path | What |
| --- | --- |
| `src/styles/tokens.css` | all tokens (site, Starlight mapping, `--sc-*`) |
| `src/styles/theme.css` | Starlight styling, prose, tables, asides, tabs, steps, buttons, landing headings |
| `src/styles/widgets.css`, `src/styles/wave.css` | parts inside widget frames; timing diagrams |
| `src/components/overrides/` | `SiteTitle`, `PageTitle` (chapter ruler, lede), `Hero` (landing), `LogoMark`, `Footer` (the report link), `theme-middleware.ts` (no `data-theme` in the HTML) |
| `src/components/site.ts` | site-wide settings: `REPORT_URL` |
| `src/components/reads/` | `HowKielerReads.svelte` and `reading.ts` (the `<HowKielerReads>` island) |
| `src/styles/no-js-theme.mjs` | the PostCSS plugin behind the theme without JavaScript |
| `src/components/frame/` | the widget frame and its parts (see above) |
| `src/components/landing/` | `HeroChart` (the compact SimPanel on `landing/toggle`), `LearnPath`, `EntryPoints` (*Ways in*: *Start learning* across the full width, then *Short on time?* (an immediate transition, dashed, as its glyph), Playground, Cheat sheet, SCCharts Lab two by two, then *Stuck?* across the full width (a state with the error mark as its glyph) with its two links, *Look up a compiler message* and *It compiles but misbehaves*, in the same two columns), `Credits` |
| `src/components/guide.ts` and `*.astro` | the MDX components |
| `src/pages/playground.astro` | `/playground` |
| `src/content/docs/design/specimen.mdx`, `widgets-test.mdx` | `/design/specimen/` (every element in the guide's styles) and `/design/widgets-test/` (every widget and its edge cases): drafts, so only the dev server has them (not in production builds, the sitemap or the search index) |
| `src/content/docs/404.mdx` | the 404 page's content, rendered by Starlight's own `/404` route; `draft: true` keeps it out of `[...slug]` in production (which would render `/404` twice). From 64rem its content (the small teaching chart, then a paragraph of links) sits beside the hero's copy (`overrides/Hero.astro`, the plain hero), below it on phones |
| `src/highlight/sctx.tmLanguage.json`, `src/highlight/code-themes.mjs`, `ec.config.mjs` | code highlighting (`ec.config.mjs` also names the scrolling code regions for screen readers) |
| `src/styles/display-font.css`, `src/styles/fonts/archivo-display-latin.woff2` | the display face, Archivo pinned to the one width and the weights the site uses (how to remake it: the CSS file) |
| `src/components/overrides/Head.astro` | Starlight's head plus preloads of the display face and the text face |
| `src/content/i18n/en.json` | Starlight's UI strings (none overridden yet; the collection silences a build warning) |
| `public/favicon.svg`, `public/apple-touch-icon.png` | icons |
| `public/og.png`, `tools/og-image.mjs` | the social card (`og:image`, 1200 x 630) and the script that renders it |
| `public/robots.txt`, `public/_headers` | crawling (allow all, the sitemap) and Cloudflare's headers (a year's cache for `/_astro/*`, security headers) |
| `tools/qa/` | the production checks (links, meta, every page in a browser with axe, search, phone tables, no-JS, keyboard, time to interactive): `docs-internal/QA.md` |
| `tools/screenshot.mjs` | screenshots for review |
| `tools/contrast.mjs` | WCAG contrast of the tokens, both themes (run by `tests/design/contrast.test.ts`) |
| `tests/design/` | the landing chart against KIELER (12 random runs), the frame helpers, the contrast pairs |

## Checking your work

```sh
pnpm build
node tools/screenshot.mjs / /learn/ticks/ /playground/     # light + dark, 390 + 1280 (design/* only on the dev server: --url)
node tools/screenshot.mjs --viewport --widths 390 /                           # first screen only
node tools/screenshot.mjs --url http://127.0.0.1:4321 --engage /learn/pre/      # widgets hydrated first
pnpm exec vitest run tests/design
```

Screenshots land in `tests/screenshots/` (git-ignored). The tool starts its own `astro preview` (with
`--ignore-lock`, so it never reuses or leaves behind a background server) and uses the newest Chromium
headless shell in `~/.cache/ms-playwright`. It sets reduced motion by default so pictures are stable;
pass `--motion` to see the landing chart's opening.

Look at both themes and 390 px before you call a change done.

Authoring note for `.astro` components: Astro drops the whitespace between a line of text and an element
on the next line, so write `the{' '}` before a link that starts a new line.
