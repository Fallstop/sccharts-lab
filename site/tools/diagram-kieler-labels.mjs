#!/usr/bin/env node
// Records the texts and decorations of KIELER's own diagrams, as the reference for the diagram tests
// (tests/diagram/kieler-labels.test.ts): for every chart in tests/diagram/{kieler,charts}/*.sctx (or the given files)
// it asks the KIELER language server for the diagram (tools/diagram-reference.mjs) and writes
// <name>.kieler-labels.json next to it with
//   states:  the rows of text in each state (name or title, declarations, actions), as KIELER splits them,
//   regions: each region's label,
//   states:  also each state's box (position relative to its region, size), for comparing the layout's shape,
//   regions: also the layout direction,
//   edges:   each transition's label (single line and KIELER's wrapped lines), whether it is dashed and
//            which decorators it has, and its doc comments (extra labels: text and wrapped lines),
//   comments: the text of each comment box (doc comments of the chart, states and regions).
// Elements are identified by their path of names (chart, region name or index, state, ...).
//
//   node tools/diagram-kieler-labels.mjs [chart.sctx ...]
//   node tools/diagram-kieler-labels.mjs --corpus
//   node tools/diagram-kieler-labels.mjs --corpus --corpus-filter '/\*\*'   (only corpus charts whose source matches)
//   node tools/diagram-kieler-labels.mjs chart.sctx ... --out-dir <dir>
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDiagramServer } from './diagram-reference.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const corpusMode = args.includes('--corpus')
const filterIdx = args.indexOf('--corpus-filter')
const corpusFilter = filterIdx >= 0 ? new RegExp(args[filterIdx + 1]) : undefined
const dirs = [path.join(root, 'tests/diagram/kieler'), path.join(root, 'tests/diagram/charts')]
// Each job: the chart file and where its reference goes. With --corpus: every chart of the parser corpus
// (tests/corpus, except the CS303 course files, which are never copied into the repository) that KIELER
// parses, recorded into tests/diagram/kieler-corpus/<corpus path with / as __>.kieler-labels.json.
// KIELER draws no diagram for a chart with syntax or linking errors (and a few others, remembered in
// _no-diagram.json so that later runs do not wait for them again).
let jobs
const noDiagramFile = path.join(root, 'tests/diagram/kieler-corpus/_no-diagram.json')
const noDiagram = new Set(fs.existsSync(noDiagramFile) ? JSON.parse(fs.readFileSync(noDiagramFile, 'utf8')) : [])
if (corpusMode) {
    const expectations = JSON.parse(fs.readFileSync(path.join(root, 'tests/corpus/expectations.json'), 'utf8'))
    const outDir = path.join(root, 'tests/diagram/kieler-corpus')
    fs.mkdirSync(outDir, { recursive: true })
    jobs = Object.entries(expectations)
        .filter(([key, e]) => !key.startsWith('cs303:') && e.syntax.length === 0 && e.linking.length === 0 && !noDiagram.has(key) && fs.existsSync(path.join(root, 'tests/corpus', key)))
        .map(([key]) => ({ file: path.join(root, 'tests/corpus', key), out: path.join(outDir, key.replace(/\.sctx$/, '').replace(/\//g, '__') + '.kieler-labels.json') }))
        .filter(job => !corpusFilter || corpusFilter.test(fs.readFileSync(job.file, 'utf8')))
} else {
    const named = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out-dir' && args[i - 1] !== '--corpus-filter')
    const files = named.length ? named.map(f => path.resolve(f))
        : dirs.flatMap(dir => fs.readdirSync(dir).filter(f => f.endsWith('.sctx')).sort().map(f => path.join(dir, f)))
    // --out-dir <dir>: write the references there instead of next to the charts.
    const outIdx = args.indexOf('--out-dir')
    const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : undefined
    if (outDir) fs.mkdirSync(outDir, { recursive: true })
    jobs = files.map(file => ({ file, out: path.join(outDir ?? path.dirname(file), `${path.basename(file, '.sctx')}.kieler-labels.json`) }))
}

/** KIELER node ids are `$root$N<chart>$N<region>$$N<index>...`: `$N<name>` for named nodes, `$$N<i>` for
 *  unnamed ones (by position). Returns the path of names/indices after `$root`. */
function idPath(id) {
    const out = []
    const re = /\$(\$?)N([^$]*)/g
    let m
    while ((m = re.exec(id))) out.push(m[1] ? Number(m[2]) : m[2])
    return out
}

function texts(r, out = []) {
    if (!r) return out
    if (r.type === 'KTextImpl' && r.text !== undefined) out.push(r.text)
    for (const c of r.children ?? []) texts(c, out)
    return out
}

/** Rows of text: every container whose direct children include texts. */
function rows(r, out = []) {
    if (!r) return out
    const direct = (r.children ?? []).filter(c => c.type === 'KTextImpl' && c.text !== undefined)
    if (direct.length) out.push(direct.map(c => c.text))
    for (const c of r.children ?? []) if (c.type !== 'KTextImpl') rows(c, out)
    return out
}

function visible(r) {
    return !(r.styles ?? []).some(s => s.type === 'KInvisibilityImpl' && s.invisible && !s.selection)
}

function decorators(spline) {
    const out = []
    for (const c of spline.children ?? []) {
        const bg = (c.styles ?? []).find(s => s.type === 'KBackgroundImpl' && !s.selection)?.color
        const hex = bg ? '#' + [bg.red, bg.green, bg.blue].map(x => x.toString(16).padStart(2, '0')).join('') : ''
        const b = c.properties?.['klighd.lsp.calculated.bounds']
        if (c.type === 'KPolygonImpl' && b?.width === 8) out.push('arrow')
        else if (c.type === 'KEllipseImpl' && b?.width === 16) out.push(texts(c).includes('*') ? 'history-deep' : 'history-shallow')
        else if (c.type === 'KEllipseImpl' && hex === '#ff0000') out.push(texts(c).includes('*') ? 'red-circle-deep' : 'red-circle')
        else if (c.type === 'KPolygonImpl' && b?.width === 11) out.push('termination')
        else out.push(c.type)
    }
    return out
}

function background(r) {
    const bg = (r?.styles ?? []).find(s => s.type === 'KBackgroundImpl' && !s.selection)?.color
    return bg ? '#' + [bg.red, bg.green, bg.blue].map(x => x.toString(16).padStart(2, '0')).join('') : ''
}

function extract(model) {
    const result = { states: [], regions: [], edges: [], comments: [] }
    const nodes = new Map()
    const walk = (e, parentKind) => {
        if (e.type === 'node' && e.id !== '$root') {
            const p = idPath(e.id)
            const data = (e.data ?? []).filter(Boolean)
            if (e.properties?.['org.eclipse.elk.commentBox']) {
                // CommentSynthesis: a comment box.
                result.comments.push({ path: p, text: texts(data[0]).join(' ') })
                return
            }
            // Alternating: state (chart), region, state, region, ...
            const kind = p.length % 2 === 1 ? 'state' : 'region'
            nodes.set(e.id, p)
            if (kind === 'state') {
                const box = e.position && e.size ? [e.position.x, e.position.y, e.size.width, e.size.height].map(n => Math.round(n * 10) / 10) : undefined
                result.states.push({ path: p, rows: data.flatMap(d => rows(d)), box })
            } else {
                const figure = data.find(d => d.properties?.['klighd.lsp.calculated.bounds'] && visible(d)) ?? data[0]
                const direct = figure?.children ?? []
                // The label: a text at the top left (16.5, 1), or a keyword label container there.
                const atLabel = c => c.properties?.['klighd.lsp.calculated.bounds']?.x === 16.5
                const label = direct.filter(c => c.type === 'KTextImpl' && c.text !== '-' && c.text !== '+').map(c => c.text)
                const keywordLabel = direct.filter(c => c.type === 'KRectangleImpl' && atLabel(c)).flatMap(c => rows(c)).flat()
                // Region declarations and actions (addStatesAndDeclarationsAndActionsArea).
                const regionRows = direct.filter(c => c.type === 'KRectangleImpl' && !atLabel(c)).flatMap(c => rows(c))
                // Dataflow regions hold wires (rounded polylines) instead of transitions.
                const dataflow = (e.children ?? []).some(c => c.type === 'edge' && (c.data ?? []).some(d => d?.type === 'KRoundedBendsPolylineImpl'))
                const dir = ['UNDEFINED', 'RIGHT', 'LEFT', 'DOWN', 'UP'][e.properties?.['org.eclipse.elk.direction'] ?? 0]
                const box = e.position && e.size ? [e.position.x, e.position.y, e.size.width, e.size.height].map(n => Math.round(n * 10) / 10) : undefined
                result.regions.push({ path: p, label: [...label, ...keywordLabel], rows: regionRows, direction: dir, box, ...(dataflow ? { dataflow: true } : {}) })
            }
        }
        if (e.type === 'edge') {
            const spline = (e.data ?? []).find(d => d?.type === 'KSplineImpl' || d?.type === 'KPolylineImpl')
            if (!spline) { for (const c of e.children ?? []) walk(c, e.type); return }
            const dashed = !!(spline?.styles ?? []).find(s => s.type === 'KLineStyleImpl' && !s.selection && (s.lineStyle === 5 || s.lineStyle === 1))
            // The main label (comment labels come first when the transition has a doc comment).
            const labels = (e.children ?? []).filter(c => c.type === 'label')
            const isMain = c => c.properties?.['de.cau.cs.kieler.klighd.syntheses.transition.main']
            const lines = c => c.properties?.['de.cau.cs.kieler.klighd.labels.textOverride']?.split('\n') ?? (c.text ? c.text.split('\n') : [])
            const label = labels.find(isMain)
            const comments = labels.filter(c => !isMain(c)).map(c => ({ text: c.text ?? '', lines: lines(c) }))
            result.edges.push({
                id: e.id, source: idPath(e.sourceId), target: idPath(e.targetId),
                text: label?.text ?? '', lines: label?.properties?.['de.cau.cs.kieler.klighd.labels.textOverride']?.split('\n') ?? (label ? [label.text] : []),
                dashed, decorators: spline ? decorators(spline) : [],
                ...(comments.length ? { comments } : {}),
            })
        }
        for (const c of e.children ?? []) walk(c, e.type)
    }
    walk(model)
    // Edges to comment boxes are not transitions.
    const commentPaths = new Set(result.comments.map(c => JSON.stringify(c.path)))
    result.edges = result.edges.filter(e => !commentPaths.has(JSON.stringify(e.target)) && !commentPaths.has(JSON.stringify(e.source)))
    return result
}

const server = await startDiagramServer()
try {
    for (const { file, out } of jobs) {
        const name = path.basename(file, '.sctx').replace(/[^\w-]/g, '_')
        try {
            const source = fs.readFileSync(file, 'utf8')
            const model = await server.diagram(source, name)
            // The source's hash, so the tests can tell a stale recording from a real difference.
            const sourceHash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16)
            fs.writeFileSync(out, JSON.stringify({ sourceHash, ...extract(model) }, null, 1) + '\n')
            console.log(`wrote ${path.relative(root, out)}`)
        } catch (error) {
            console.log(`no diagram for ${path.relative(root, file)}: ${String(error.message).split('\n')[0]}`)
            if (corpusMode) {
                noDiagram.add(path.relative(path.join(root, 'tests/corpus'), file))
                fs.writeFileSync(noDiagramFile, JSON.stringify([...noDiagram].sort(), null, 1) + '\n')
            }
        }
    }
} finally {
    await server.stop()
}
