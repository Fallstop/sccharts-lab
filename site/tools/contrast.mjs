#!/usr/bin/env node
// WCAG 2.x contrast of the guide's colour tokens, read from src/styles/tokens.css, in both themes.
//
//   node tools/contrast.mjs          prints every pair; exit code 1 if one fails
//
// Text needs 4.5:1, graphics and control borders 3:1 (WCAG 1.4.3 and 1.4.11). Pairs list foreground,
// background, minimum and a label. A colour is a token ('--c-ink', which may reference other tokens with
// var()), a literal ('#7a1452'), or layers painted bottom to top: ['--c-sheet', ['--sc-error', 0.12]] is a
// 12 % tint of --sc-error over --c-sheet (CSS `color-mix(in srgb, var(--sc-error) 12%, transparent)` on a
// sheet). A token whose value is `rgb(r g b / a)` brings its own alpha. A foreground with an alpha
// (['--c-muted', 0.75]) is blended over its background, as `opacity` does. Code colours come from the
// highlighting themes (src/highlight/code-themes.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { codePalettes } from '../src/highlight/code-themes.mjs'

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const PAIRS = [
    // Text
    ['--c-text', '--c-paper', 4.5, 'body text'],
    ['--c-ink', '--c-paper', 4.5, 'headings'],
    ['--c-muted', '--c-paper', 4.5, 'muted text on paper'],
    ['--c-muted', '--c-rail', 4.5, 'muted text on rail'],
    ['--c-muted', '--c-sheet', 4.5, 'muted text on sheet'],
    ['--c-muted', '--c-inset', 4.5, 'muted text on the stage'],
    ['--c-accent', '--c-paper', 4.5, 'links'],
    ['--c-accent', '--c-rail', 4.5, 'links on rail'],
    ['--c-accent', '--c-accent-soft', 4.5, 'current page'],
    ['--c-ink', '--sl-color-bg-inline-code', 4.5, 'inline code'],
    ['--c-go', '--c-sheet', 4.5, 'correct'],
    ['--c-signal', '--c-sheet', 4.5, 'wrong'],
    ['--c-note-ink', '--c-note-bg', 4.5, 'note aside'],
    ['--c-tip-ink', '--c-tip-bg', 4.5, 'tip aside'],
    ['--c-caution-ink', '--c-caution-bg', 4.5, 'caution aside'],
    ['--c-danger-ink', '--c-danger-bg', 4.5, 'danger aside'],
    ['--c-paper', '--c-ink', 4.5, 'selected view tab'],
    // Controls
    ['--c-control', '--c-paper', 3, 'control border on paper'],
    ['--c-control', '--c-sheet', 3, 'control border on sheet'],
    ['--c-accent-bright', '--c-paper', 3, 'focus ring'],
    // Diagram
    ['--sc-state-text', '--sc-state-fill', 4.5, 'state name, gradient top'],
    ['--sc-state-text', '--sc-state-fill-end', 4.5, 'state name, gradient bottom'],
    ['--sc-keyword', '--sc-root-fill', 4.5, 'keywords on the root'],
    ['--sc-keyword', '--sc-superstate-fill-end', 4.5, 'keywords on a superstate'],
    ['--sc-decl-text', '--sc-superstate-fill-end', 4.5, 'declarations'],
    ['--sc-edge-label', '--sc-region-fill', 4.5, 'transition labels'],
    ['--sc-region-label', '--sc-region-fill', 4.5, 'region labels'],
    ['--sc-state-stroke', '--sc-region-fill', 3, 'initial / final outline'],
    ['--sc-state-outline', '--sc-region-fill', 3, 'simple state outline'],
    ['--sc-edge', '--sc-region-fill', 3, 'transitions'],
    ['--sc-strong-abort', '--sc-region-fill', 3, 'strong-abort dot'],
    ['--sc-termination', '--sc-region-fill', 3, 'termination triangle'],
    ['--sc-active-stroke', '--sc-region-fill', 3, 'active state outline'],
    ['--sc-taken', '--sc-region-fill', 3, 'taken transition'],
    ['--sc-error', '--sc-region-fill', 3, 'error highlight'],
    ['--sc-region-fill', '--sc-error', 3, 'error marker: its "!" on the disc'],
    ['--sc-error', '--sc-region-fill', 3, 'error marker disc'],
    ['--sc-region-fill', '--sc-active-stroke', 4.5, 'for-region copy badge: its count'],
    // A state just left: its outline on the region, its name on the tint (16 %, 36 % at the start of the fade).
    ['--sc-entered', '--sc-region-fill', 3, 'outline of a state just left'],
    ['--sc-state-text', ['--sc-state-fill', ['--sc-entered', 0.16]], 4.5, 'state name on a state just left'],
    ['--sc-state-text', ['--sc-state-fill', ['--sc-entered', 0.36]], 4.5, 'state name on a state just left, start of the fade'],
    ['--sc-state-text', ['--sc-superstate-fill', ['--sc-entered', 0.08]], 4.5, 'superstate name, just left'],
    ['--sc-comment-text', '--sc-comment-fill', 4.5, 'comment text'],
    ['--sc-wave-line', '--c-sheet', 3, 'waveform line'],
    ['--sc-wave-value', '--c-sheet', 4.5, 'waveform values'],
    // Timing diagrams: values on a state lane, on a present valued signal (in the shown column, and where a
    // Compare marks a difference), held values; the difference mark.
    ['--sc-wave-value', ['--c-sheet', ['--sc-state-fill-end', 0.55]], 4.5, 'waveform state names'],
    ['--sc-wave-value', ['--c-sheet', '--sc-wave-cursor', '--sc-wave-fill'], 4.5, 'waveform value, present, shown tick'],
    ['--sc-wave-value', ['--c-sheet', ['--sc-error', 0.16], '--sc-wave-fill'], 4.5, 'waveform value, present, Compare difference'],
    ['--c-muted', '--c-sheet', 4.5, 'waveform value held (absent signal)'],
    ['--sc-error', '--c-sheet', 3, 'Compare difference mark'],
    ['--sc-error', ['--c-sheet', ['--sc-error', 0.16]], 3, 'Compare difference mark on its tint'],
    // Focus rings wherever they can appear (2.4.7, 1.4.11).
    ['--c-accent-bright', '--c-sheet', 3, 'focus ring on sheet'],
    ['--c-accent-bright', '--c-rail', 3, 'focus ring on rail'],
    ['--c-accent-bright', '--c-inset', 3, 'focus ring on the stage'],
    ['--c-accent-bright', '--sc-region-fill', 3, 'focus ring in a diagram'],
    ['--c-accent-bright', '--sc-root-fill', 3, 'focus ring on the root state'],
    ['--c-accent-bright', ['--c-sheet', ['--sc-keyword', 0.1]], 3, 'focus ring on a focused code line'],
    // Hover and keyboard focus of "What happened" lines.
    ['--c-text', '--c-accent-soft', 4.5, 'text on a hovered line'],
    ['--c-ink', '--c-accent-soft', 4.5, 'bold text on a hovered line'],
    // Diagnostics: warnings (closed box), the notice box, the marks.
    ['--c-caution-ink', '--c-sheet', 4.5, 'warnings summary'],
    ['--c-ink', '--c-caution-bg', 4.5, 'notice message'],
    ['--c-text', '--c-caution-bg', 4.5, 'notice hint'],
    ['--c-muted', '--c-caution-bg', 4.5, 'notice: KIELER says'],
    ['--c-caution-rule', '--c-sheet', 3, 'caution mark'],
    ['--c-caution-rule', '--c-caution-bg', 3, 'notice border'],
    ['--sc-error', '--c-sheet', 3, 'error mark'],
    ['--c-go', '--c-go-soft', 4.5, 'Predict: right answer'],
    ['--c-ink', '--c-go-soft', 4.5, 'Predict: text of a right answer'],
    ['--c-ink', '--c-danger-bg', 4.5, 'Predict: text of a wrong answer'],
    ['--c-signal', '--c-danger-bg', 3, 'Predict: wrong-answer border'],
    // Source lines: line numbers (at 90 % opacity, widgets.css), and marked lines' numbers.
    [['--c-muted', 0.9], '--c-sheet', 4.5, 'line numbers'],
    ...[['--sc-active-stroke', 0.11, 'active state'], ['--sc-taken', 0.11, 'fired transition'], ['--sc-error', 0.12, 'error'], ['--sc-keyword', 0.1, 'focus']].flatMap(([tint, a, what]) => [
        ['--c-ink', ['--c-sheet', [tint, a]], 4.5, `line number on a ${what} line`],
        [tint, ['--c-sheet', [tint, a]], 3, `${what} line mark (left border)`],
    ]),
]

/** Code text on the source view's line tints, per theme (the highlighting palettes; code in a frame sits on --c-sheet). */
const LINE_TINTS = [
    [undefined, 0, 'plain line'],
    ['--sc-active-stroke', 0.11, 'active-state line'],
    ['--sc-taken', 0.11, 'fired-transition line'],
    ['--sc-error', 0.12, 'error line'],
    ['--sc-keyword', 0.1, 'focused line'],
]
const CODE_ROLES = ['fg', 'comment', 'keyword', 'operator', 'string', 'number', 'annotation', 'func', 'type']

export function codePairs(theme) {
    const palette = codePalettes[theme]
    const pairs = []
    for (const role of CODE_ROLES) {
        pairs.push([palette[role], '--c-code-bg', 4.5, `code ${role} on a code block`])
        for (const [tint, a, what] of LINE_TINTS) pairs.push([palette[role], tint ? ['--c-sheet', [tint, a]] : '--c-sheet', 4.5, `code ${role} on a ${what}`])
    }
    return pairs
}

/** Parses the dark (:root) and light (:root[data-theme='light']) token blocks. */
export function readThemes(file = path.join(site, 'src/styles/tokens.css')) {
    const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const block = (selector) => {
        const i = css.indexOf(selector)
        if (i < 0) throw new Error(`no ${selector} block in ${file}`)
        const start = css.indexOf('{', i)
        let depth = 0
        for (let j = start; j < css.length; j++) {
            if (css[j] === '{') depth++
            else if (css[j] === '}' && --depth === 0) return css.slice(start + 1, j)
        }
        throw new Error(`unclosed ${selector}`)
    }
    const decls = (text) => Object.fromEntries([...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
    const dark = decls(block(':root {'))
    const light = { ...dark, ...decls(block(":root[data-theme='light'] {")) }
    return { light, dark }
}

function resolve(vars, value, depth = 0) {
    if (depth > 10) return undefined
    const m = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(value)
    if (!m) return value
    return vars[m[1]] !== undefined ? resolve(vars, vars[m[1]], depth + 1) : m[2]
}

/** [r, g, b, a] (0..1) of '#rrggbb', '#rgb' or 'rgb(r g b / a)' / 'rgb(r, g, b)'; undefined for anything else. */
function rgba(value) {
    const hex = /^#([0-9a-f]{6})$/i.exec(value)
    if (hex) return [...[0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255), 1]
    const short = /^#([0-9a-f]{3})$/i.exec(value)
    if (short) return [...[0, 1, 2].map((i) => parseInt(short[1][i] + short[1][i], 16) / 255), 1]
    const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?))?\s*\)$/i.exec(value)
    if (fn) {
        const a = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4])
        return [Number(fn[1]) / 255, Number(fn[2]) / 255, Number(fn[3]) / 255, a]
    }
    return undefined
}

/** A token or literal as [r, g, b, a]. */
function colourOf(vars, spec) {
    if (spec.startsWith('#') || spec.startsWith('rgb')) return rgba(spec)
    return rgba(resolve(vars, vars[spec] ?? '') ?? '')
}

const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3]))

/** A colour spec (token, literal or layers, see the header) painted over `base` (opaque); undefined if unknown. */
function paint(vars, spec, base) {
    const layers = Array.isArray(spec) && (spec.length !== 2 || typeof spec[1] !== 'number') ? spec : [spec]
    let out = base
    for (const layer of layers) {
        const [name, alpha] = Array.isArray(layer) ? layer : [layer, undefined]
        const c = colourOf(vars, name)
        if (!c) return undefined
        const a = alpha === undefined ? c[3] : alpha * c[3]
        if (a < 1 && !out) return undefined // a translucent colour needs something underneath
        out = a >= 1 ? c.slice(0, 3) : over([c[0], c[1], c[2], a], out)
    }
    return out
}

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
export const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
    return (x + 0.05) / (y + 0.05)
}

const label = (spec) => (Array.isArray(spec) ? `[${spec.map(label).join(' + ')}]` : typeof spec === 'number' ? `${Math.round(spec * 100)}%` : spec)

export function checkContrast(themes = readThemes()) {
    const results = []
    for (const [theme, vars] of Object.entries(themes)) {
        for (const [fg, bg, min, what] of [...PAIRS, ...codePairs(theme)]) {
            const b = paint(vars, bg)
            const a = b && paint(vars, fg, b)
            if (!a || !b) {
                results.push({ theme, fg: label(fg), bg: label(bg), min, label: what, ratio: NaN, ok: false, note: 'a colour is not #rrggbb / rgb(), or translucent with nothing under it' })
                continue
            }
            const r = ratio(a, b)
            results.push({ theme, fg: label(fg), bg: label(bg), min, label: what, ratio: r, ok: r >= min })
        }
    }
    return results
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const results = checkContrast()
    for (const r of results) {
        const mark = r.ok ? 'ok  ' : 'FAIL'
        console.log(`${mark} ${r.theme.padEnd(5)} ${(Number.isNaN(r.ratio) ? '  -  ' : r.ratio.toFixed(2)).padStart(6)} (min ${r.min})  ${r.label}${r.note ? `: ${r.note}` : ''}`)
    }
    process.exitCode = results.every((r) => r.ok) ? 0 : 1
}
