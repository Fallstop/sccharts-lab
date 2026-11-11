// The C code tab's code view: CodeMirror, read only, with CodeMirror's C mode (@codemirror/legacy-modes, clike) in
// the playground's syntax colours (the classes of the guide's code theme, as SCTX), line numbers, folding of braces,
// search (Ctrl/⌘+F) and the editor's look.

import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { HighlightStyle, StreamLanguage, bracketMatching, foldGutter, syntaxHighlighting } from '@codemirror/language'
import { search, searchKeymap } from '@codemirror/search'
import { defaultKeymap } from '@codemirror/commands'
import { tags as t } from '@lezer/highlight'
import { c } from '@codemirror/legacy-modes/mode/clike'
import { editorTheme } from './editor'

const cHighlight = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.typeName, t.modifier, t.definitionKeyword], class: 'sc-tok-kw' },
    { tag: [t.string, t.character], class: 'sc-tok-str' },
    { tag: [t.number, t.bool, t.atom], class: 'sc-tok-num' },
    { tag: [t.comment, t.lineComment, t.blockComment], class: 'sc-tok-com' },
    { tag: [t.meta, t.processingInstruction], class: 'sc-tok-ann' },
])

const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    foldGutter(),
    drawSelection(),
    bracketMatching(),
    StreamLanguage.define(c),
    syntaxHighlighting(cHighlight),
    search({ top: true }),
    keymap.of([...searchKeymap, ...defaultKeymap]),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: '0' }),
    editorTheme,
]

export interface CView {
    show(text: string, label: string): void
    destroy(): void
}

/** A read-only C view in `parent`; `show` puts another file in it (from its top). */
export function createCView(parent: HTMLElement): CView {
    const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions }) })
    let shown = ''
    return {
        show(text, label) {
            view.contentDOM.setAttribute('aria-label', label)
            if (text === shown) return
            const same = view.state.doc.length > 0 && label === view.contentDOM.dataset.file
            view.contentDOM.dataset.file = label
            shown = text
            // The same file regenerated keeps its place; another file opens at its top.
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, ...(same ? {} : { selection: { anchor: 0 }, scrollIntoView: true }) })
            if (!same) view.scrollDOM.scrollTop = 0
        },
        destroy() {
            view.destroy()
        },
    }
}
