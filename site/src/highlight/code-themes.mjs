// Syntax highlighting themes for code blocks (Expressive Code / Shiki), in VS Code theme format.
//
// They follow the site palette (see docs-internal/DESIGN.md): keywords in KIELER's keyword plum (the
// colour SCCharts keywords have in KIELER's editor and diagrams), strings in blue, numbers and
// constants in amber, comments in a quiet green-grey, annotations in grey. SCTX keywords are set in a
// heavier weight, as KIELER's editor does, so `state`, `if`, `go to` stand out from names.
//
// Every foreground meets WCAG AA (4.5:1) against its background; Expressive Code additionally
// enforces a minimum contrast at build time.

const scopes = (palette) => [
    { scope: ['comment', 'punctuation.definition.comment', 'comment.line.double-slash.sctx', 'comment.block.sctx'], settings: { foreground: palette.comment } },
    { scope: ['punctuation.whitespace.comment.leading.sctx', 'punctuation.decorator.internaldeclaration.sctx'], settings: { foreground: palette.comment } },
    { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression', 'keyword.other'], settings: { foreground: palette.keyword } },
    { scope: ['keyword.control.sctx'], settings: { foreground: palette.keyword, fontStyle: 'bold' } },
    { scope: ['keyword.operator', 'punctuation'], settings: { foreground: palette.operator } },
    { scope: ['string', 'string.quoted', 'constant.character.escape.sctx', 'string.quoted.double.sctx'], settings: { foreground: palette.string } },
    { scope: ['constant.character.escape'], settings: { foreground: palette.number } },
    { scope: ['constant.numeric', 'constant.language', 'constant.language.sctx', 'constant.numeric.integer.sctx', 'constant.numeric.float.sctx', 'support.constant'], settings: { foreground: palette.number } },
    { scope: ['storage.type.annotation', 'storage.type.annotation.sctx', 'meta.decorator', 'entity.name.function.decorator', 'punctuation.decorator'], settings: { foreground: palette.annotation } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], settings: { foreground: palette.func } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class', 'storage.type.primitive'], settings: { foreground: palette.type } },
    { scope: ['variable.parameter', 'variable.other.constant', 'entity.name.tag'], settings: { foreground: palette.func } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: palette.number } },
    { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: palette.keyword, fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.inserted', 'meta.diff.header.to-file'], settings: { foreground: palette.inserted } },
    { scope: ['markup.deleted', 'meta.diff.header.from-file'], settings: { foreground: palette.deleted } },
    { scope: ['invalid'], settings: { foreground: palette.deleted } },
]

const light = {
    bg: '#F4F6FA',
    fg: '#1D2536',
    comment: '#4C6B57',
    keyword: '#7A1452',
    operator: '#3A4458',
    string: '#1B4C9E',
    number: '#7F4300',
    annotation: '#5B6070',
    func: '#1F4F86',
    type: '#155F55',
    inserted: '#17703A',
    deleted: '#A41E33',
}

const dark = {
    bg: '#172033',
    fg: '#D5DCE8',
    comment: '#93B39D',
    keyword: '#EBAADB',
    operator: '#B7C1D2',
    string: '#93C5FF',
    number: '#F2C383',
    annotation: '#AEB4C6',
    func: '#A6CEFF',
    type: '#86D8C8',
    inserted: '#7FD9A0',
    deleted: '#FF9AA8',
}

function theme(name, type, p) {
    return {
        name,
        type,
        colors: {
            'editor.background': p.bg,
            'editor.foreground': p.fg,
            'editor.selectionBackground': type === 'dark' ? '#3A4B6B' : '#CFDDF3',
            'editorLineNumber.foreground': type === 'dark' ? '#6F7C93' : '#8A94A6',
            'terminal.background': p.bg,
            'terminal.foreground': p.fg,
        },
        tokenColors: [{ settings: { foreground: p.fg, background: p.bg } }, ...scopes(p)],
    }
}

export const scchartsLight = theme('sccharts-light', 'light', light)
export const scchartsDark = theme('sccharts-dark', 'dark', dark)
export const codePalettes = { light, dark }
