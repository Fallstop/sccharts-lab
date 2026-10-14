// The playground's CodeMirror 6 editor: SCTX highlighting and indentation, bracket matching and closing,
// comment toggling, search, folding, lint diagnostics with squiggles and gutter markers, completion and hover
// cards, and line marks for the simulation (active states, fired transitions) and for the element under the
// pointer in the diagram.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language'
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic as LintDiagnostic } from '@codemirror/lint'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { ChangeSet, EditorSelection, EditorState, MapMode, Prec, StateEffect, StateField, type Extension, type Text } from '@codemirror/state'
import {
    Decoration,
    EditorView,
    crosshairCursor,
    drawSelection,
    dropCursor,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    hoverTooltip,
    keymap,
    lineNumbers,
    rectangularSelection,
    type DecorationSet,
    type KeyBinding,
    type ViewUpdate,
} from '@codemirror/view'
import { completionSource, definitionAt, hoverSource, type AnalysisView } from './editor-features'
import { sctx } from './sctx-language'

// ----- Offsets between a snapshot of the text and the current text ------------------------------------------------

/** Follows the edits made since a snapshot of the document, to map offsets between the two. */
export class DocTracker {
    changes: ChangeSet
    constructor(public doc: Text) {
        this.changes = ChangeSet.empty(doc.length)
    }
    reset(doc: Text) {
        this.doc = doc
        this.changes = ChangeSet.empty(doc.length)
    }
    add(changes: ChangeSet) {
        this.changes = this.changes.compose(changes)
    }
    get changed() {
        return !this.changes.empty
    }
    /** Current offset -> snapshot offset. `exact`: null when the text at `pos` was typed after the snapshot. */
    toSnapshot(pos: number, exact = false): number | null {
        if (this.changes.empty) return pos
        const inv = this.changes.invertedDesc
        return exact ? inv.mapPos(pos, 1, MapMode.TrackDel) : inv.mapPos(pos, -1)
    }
    fromSnapshot(pos: number): number {
        if (this.changes.empty) return Math.min(pos, this.changes.length)
        return this.changes.mapPos(Math.min(pos, this.changes.length), 1)
    }
}

// ----- Line marks (simulation and diagram focus) -------------------------------------------------------------------

export interface Marks {
    /** Offsets of line starts in the current text. */
    active?: number[]
    taken?: number[]
    /** A range linked with the element under the pointer in the diagram. */
    focus?: { from: number; to: number }
}

const setMarksEffect = StateEffect.define<Marks>()

const lineMark = (cls: string) => Decoration.line({ class: cls })
const focusMark = Decoration.mark({ class: 'sc-pg-cm-focus' })

const marksField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        deco = deco.map(tr.changes)
        for (const e of tr.effects) {
            if (!e.is(setMarksEffect)) continue
            const m = e.value
            const ranges = []
            const len = tr.state.doc.length
            const lines = new Map<number, string[]>()
            const addLine = (pos: number, cls: string) => {
                if (pos < 0 || pos > len) return
                const from = tr.state.doc.lineAt(pos).from
                const list = lines.get(from) ?? []
                if (!list.includes(cls)) list.push(cls)
                lines.set(from, list)
            }
            m.active?.forEach(p => addLine(p, 'sc-pg-cm-active'))
            m.taken?.forEach(p => addLine(p, 'sc-pg-cm-taken'))
            for (const [from, classes] of [...lines].sort((a, b) => a[0] - b[0])) ranges.push(lineMark(classes.join(' ')).range(from))
            if (m.focus && m.focus.to > m.focus.from && m.focus.to <= len) ranges.push(focusMark.range(m.focus.from, m.focus.to))
            deco = Decoration.set(ranges, true)
        }
        return deco
    },
    provide: f => EditorView.decorations.from(f),
})

// ----- Theme -------------------------------------------------------------------------------------------------------

const theme = EditorView.theme({
    '&': {
        height: '100%',
        color: 'var(--pg-code-fg)',
        backgroundColor: 'var(--c-code-bg)',
        fontSize: 'var(--pg-code-size, 0.875rem)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.6',
        overscrollBehavior: 'contain',
    },
    '.cm-content': { padding: '0.75rem 0', caretColor: 'var(--c-ink)' },
    '.cm-line': { padding: '0 1rem 0 0.75rem' },
    '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--c-ink)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--pg-selection) !important',
    },
    '.cm-activeLine': { backgroundColor: 'var(--pg-active-line)' },
    '.cm-gutters': {
        backgroundColor: 'var(--c-code-bg)',
        color: 'var(--pg-gutter-fg)',
        border: 'none',
        borderRight: '1px solid var(--c-rule)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.5rem 0 0.75rem', minWidth: '2.25rem', fontVariantNumeric: 'tabular-nums' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--pg-active-line)', color: 'var(--c-ink)' },
    '.cm-foldGutter .cm-gutterElement': { padding: '0 0.25rem', cursor: 'pointer', color: 'var(--c-muted)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'var(--pg-bracket-bg)',
        outline: '1px solid var(--pg-bracket-ring)',
        color: 'inherit',
    },
    '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', outline: '1px solid var(--sc-error)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--pg-match-bg)' },
    '.cm-searchMatch': { backgroundColor: 'var(--pg-search-bg)', outline: '1px solid var(--pg-search-ring)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--pg-search-sel)' },
    '.cm-foldPlaceholder': {
        backgroundColor: 'var(--c-accent-soft)',
        border: '1px solid var(--c-rule-strong)',
        color: 'var(--c-accent)',
        padding: '0 0.375rem',
        borderRadius: '999px',
    },
    '.cm-tooltip': {
        backgroundColor: 'var(--c-sheet)',
        color: 'var(--c-text)',
        border: '1px solid var(--c-rule-strong)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-pop)',
        fontFamily: 'var(--font-text)',
        fontSize: 'var(--text-xs)',
        maxWidth: 'min(28rem, calc(100vw - 2rem))',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '16rem' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '0.125rem 0.625rem 0.125rem 0.25rem', lineHeight: '1.5' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--c-accent-soft)', color: 'var(--c-ink)' },
    '.cm-completionDetail': { marginLeft: '0.75rem', fontStyle: 'normal', color: 'var(--c-muted)', fontFamily: 'var(--font-text)' },
    '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '800', color: 'var(--c-accent)' },
    '.cm-tooltip.cm-completionInfo': { padding: '0.5rem 0.75rem' },
    '.cm-tooltip-hover': { padding: '0.5rem 0.75rem' },
    '.cm-tooltip-lint': { padding: '0' },
    '.cm-diagnostic': { padding: '0.5rem 0.75rem', borderLeftWidth: '4px', marginLeft: '0' },
    '.cm-diagnostic-error': { borderLeftColor: 'var(--sc-error)' },
    '.cm-diagnostic-warning': { borderLeftColor: 'var(--c-caution-rule)' },
    '.cm-diagnostic-info': { borderLeftColor: 'var(--c-note-rule)' },
    '.cm-lintRange-error': { backgroundImage: 'var(--pg-squiggle-error)' },
    '.cm-lintRange-warning': { backgroundImage: 'var(--pg-squiggle-warning)' },
    '.cm-lintRange-info': { backgroundImage: 'var(--pg-squiggle-info)' },
    '.cm-panels': { backgroundColor: 'var(--c-rail)', color: 'var(--c-text)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--c-rule)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--c-rule)' },
    '.cm-search': { fontFamily: 'var(--font-text)', fontSize: 'var(--text-xs)', padding: '0.375rem 0.75rem' },
    '.cm-textfield': {
        border: '1.5px solid var(--c-control)',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: 'var(--c-sheet)',
        color: 'var(--c-ink)',
        fontFamily: 'var(--font-mono)',
        padding: '0.125rem 0.375rem',
    },
    '.cm-button': {
        backgroundImage: 'none',
        backgroundColor: 'var(--c-sheet)',
        border: '1.5px solid var(--c-control)',
        borderRadius: '999px',
        color: 'var(--c-ink)',
        padding: '0.125rem 0.625rem',
    },
    '.cm-panel.cm-search [name=close]': { color: 'var(--c-muted)', fontSize: '1.25rem', right: '0.5rem' },
    '.cm-panel.cm-search label': { color: 'var(--c-text)' },
})

// ----- The editor --------------------------------------------------------------------------------------------------

export interface EditorOptions {
    doc: string
    /** The last compile result, for completion and hover. */
    analysis: () => AnalysisView | undefined
    /** Values of the shown simulation tick, for hover cards. */
    values?: () => Record<string, unknown> | undefined
    onUpdate: (update: ViewUpdate) => void
    /** App shortcuts that also work while typing (Mod-Enter: step, ...). */
    keys?: KeyBinding[]
    label: string
    /** Fewer gutters (the inline playground). */
    compact?: boolean
}

export function createEditor(parent: HTMLElement, options: EditorOptions): EditorView {
    /** F12, Ctrl/Cmd+click: select the declaration of the name under the cursor or the pointer. */
    const gotoDefinition = (view: EditorView, pos: number) => {
        const def = definitionAt(options.analysis(), pos)
        if (!def) return false
        view.dispatch({ selection: EditorSelection.single(def.from, def.to), effects: EditorView.scrollIntoView(def.from, { y: 'center' }), userEvent: 'select.definition' })
        return true
    }
    const extensions: Extension[] = [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        options.compact ? [] : foldGutter({ markerDOM: open => foldMarker(open) }),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        EditorState.tabSize.of(4),
        indentUnit.of('  '),
        indentOnInput(),
        sctx(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ override: [completionSource(options.analysis)], icons: true, activateOnTypingDelay: 80 }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        lintGutter(),
        hoverTooltip(hoverSource(options.analysis, options.values), { hoverTime: 350 }),
        marksField,
        Prec.highest(keymap.of([...(options.keys ?? []), { key: 'F12', run: view => gotoDefinition(view, view.state.selection.main.head) }])),
        EditorView.domEventHandlers({
            mousedown(e, view) {
                if (!(e.ctrlKey || e.metaKey) || e.button !== 0 || e.altKey || e.shiftKey) return false
                const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
                if (pos === null || !gotoDefinition(view, pos)) return false
                e.preventDefault()
                return true
            },
        }),
        keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            ...lintKeymap,
            { key: 'Mod-/', run: toggleComment },
            indentWithTab,
        ]),
        theme,
        // The search panel's words, in the guide's sentence case.
        EditorState.phrases.of({
            next: 'Next',
            previous: 'Previous',
            all: 'All',
            'match case': 'Match case',
            regexp: 'Regular expression',
            'by word': 'Whole words',
            replace: 'Replace',
            'replace all': 'Replace all',
            close: 'Close',
        }),
        // tabindex 0 changes nothing for the browser (a contenteditable is focusable anyway), but tools such as axe
        // only count elements with tabindex as focusable: without it the scroller (tabindex -1) is reported as a
        // scrollable region that the keyboard cannot reach (scrollable-region-focusable).
        EditorView.contentAttributes.of({ 'aria-label': options.label, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', tabindex: '0' }),
        EditorView.updateListener.of(options.onUpdate),
    ]
    return new EditorView({ state: EditorState.create({ doc: options.doc, extensions }), parent })
}

function foldMarker(open: boolean): HTMLElement {
    const span = document.createElement('span')
    span.className = 'sc-pg-fold'
    span.setAttribute('aria-hidden', 'true')
    span.innerHTML = open
        ? '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M4.5 3 7.5 6 4.5 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    return span
}

export function showDiagnostics(view: EditorView, diagnostics: LintDiagnostic[]) {
    view.dispatch(setDiagnostics(view.state, diagnostics))
}

export function setMarks(view: EditorView, marks: Marks) {
    view.dispatch({ effects: setMarksEffect.of(marks) })
}

/** Selects a range and scrolls it into view (the start first, for long ranges). */
export function selectRange(view: EditorView, from: number, to: number, focus = false) {
    const len = view.state.doc.length
    from = Math.max(0, Math.min(from, len))
    to = Math.max(from, Math.min(to, len))
    view.dispatch({
        selection: EditorSelection.single(to, from),
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
        userEvent: 'select.diagram',
    })
    if (focus) view.focus()
}

/** Replaces the whole text as one undoable change. */
export function replaceText(view: EditorView, text: string, userEvent = 'input.load') {
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: EditorSelection.cursor(0),
        scrollIntoView: true,
        userEvent,
    })
}
