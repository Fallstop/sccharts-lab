// The editor's syntax colours, straight from the guide's code theme (src/highlight/code-themes.mjs), as CSS
// custom properties for both site themes (Starlight: :root is dark, [data-theme='light'] light). Rendered into the
// page at build time so the editor and the code blocks can never drift apart.

import { codePalettes } from '../../highlight/code-themes.mjs'

type Palette = (typeof codePalettes)['light']

/** A wavy underline as a data URL (lint squiggles). */
const squiggle = (colour: string) =>
    `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='m0 3 l2 -2 l1 0 l2 2 l1 0' stroke='${encodeURIComponent(colour)}' fill='none' stroke-width='1.2'/%3E%3C/svg%3E")`

const vars = (p: Palette, dark: boolean) =>
    [
        `--pg-squiggle-error:${squiggle(dark ? '#ff8a65' : '#c4361c')}`,
        `--pg-squiggle-warning:${squiggle(dark ? '#e8b04a' : '#a8730c')}`,
        `--pg-squiggle-info:${squiggle(dark ? '#7fb0f0' : '#3a76c4')}`,
        `--pg-code-fg:${p.fg}`,
        `--pg-tok-kw:${p.keyword}`,
        `--pg-tok-str:${p.string}`,
        `--pg-tok-num:${p.number}`,
        `--pg-tok-com:${p.comment}`,
        `--pg-tok-ann:${p.annotation}`,
        `--pg-tok-op:${p.fg}`,
        `--pg-tok-bad:${p.deleted}`,
        `--pg-selection:${dark ? '#3A4B6B' : '#CFDDF3'}`,
    ].join(';')

export function codeColourCss(): string {
    // Without JavaScript <html> has no data-theme and follows the system's scheme (src/styles/no-js-theme.mjs does
    // this for the stylesheets; this <style> is written into the page, so it does it itself).
    const light = vars(codePalettes.light, false)
    return `:root{${vars(codePalettes.dark, true)}}:root[data-theme='light']{${light}}@media (prefers-color-scheme: light){:root:not([data-theme]){${light}}}`
}
