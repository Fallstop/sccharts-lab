// Build-time highlighting of SCTX with the editor's own tokenizer and classes, for what the playground shows
// before CodeMirror has loaded (and without JavaScript). Pure string building.

import { TOKEN_CLASS, tokenizeLines } from './sctx-tokens'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** One HTML string per source line: `<span class="sc-tok-kw">state</span> A`. */
export function highlightLines(source: string): string[] {
    return tokenizeLines(source.replace(/\s+$/, '')).map(tokens =>
        tokens.map(tk => (tk.type && tk.type !== 'identifier' ? `<span class="${TOKEN_CLASS[tk.type]}">${esc(tk.text)}</span>` : esc(tk.text))).join(''),
    )
}
