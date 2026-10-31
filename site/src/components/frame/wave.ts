// Timing diagrams ("waveforms") in the guide's style: one lane per variable, one column per tick, like a
// logic analyser. Booleans and pure signals are drawn as a line that is high while true / present, with
// the area under it filled; other values as a bus whose segments carry the value; a valued signal as a bus
// whose segments are filled in the ticks it is present (its value stays when it is absent). `null` in a bus
// lane means "no value" (a region that is not active, a string never set) and is drawn as a mid-level line,
// a logic analyser's high impedance. The latest tick's column is shaded (the cursor).
//
// This is plain string building with no DOM access, so it renders at build time (the page works without
// JavaScript) and in the browser (after each step). Styles: src/styles/wave.css (--sc-wave-* tokens); see
// docs-internal/DESIGN.md, "Timing diagrams".

export type WaveValue = boolean | number | string | null | undefined

/** A valued signal in one tick: present or not, and its value. */
export interface SignalSample {
    present: boolean
    value: WaveValue
}

export interface WaveRow {
    name: string
    /** 'bool' for booleans and pure signals (high = true / present), 'value' for anything else, 'signal' for
     *  valued signals (values are SignalSample). */
    kind: 'bool' | 'value' | 'signal'
    /** Lanes are grouped by role; a hairline separates the groups. */
    role?: 'input' | 'output' | 'local' | 'state'
    /** One value per tick column; undefined = tick not run yet. */
    values: (WaveValue | SignalSample)[]
    /** A caption drawn above the first lane of a group of lanes (Compare: the chart's name). */
    group?: string
    /** On the first row of a group: markers drawn in the group's caption row, by column ('term': that chart
     *  terminated in this tick, 'error': a run-time error), as the tick header has them for a single chart. */
    groupMarks?: Record<number, 'term' | 'error'>
    /** Columns to emphasise in this lane (Compare: the charts disagree here). */
    marks?: boolean[]
    /** Per column, a model element the lane's value stands for (the active state), as data-ref. */
    refs?: (string | undefined)[]
    /** Columns where a new segment starts even if the value is unchanged (a state entered again). */
    breaks?: boolean[]
    /** Columns where the lane is suspended (a state lane frozen by a `suspend`): drawn hatched. */
    hatch?: boolean[]
    /** Tooltip / accessible text of the lane name (default: the name). */
    title?: string
    /** A 'bool' lane that stands for presence (a pure signal): the table says present / absent, not true / false. */
    presence?: boolean
}

export interface WaveOptions {
    /** Number of tick columns to draw (at least the longest row). */
    columns: number
    /** Tick number of the first column (default 1). */
    firstTick?: number
    /** Column index (0-based) of the cursor; default: the last column that has a value. */
    cursor?: number
    labelWidth?: number
    columnWidth?: number
    /** Accessible description of the whole diagram. */
    title?: string
    /** Columns from this index on are ticks after the cursor (computed, but not the one shown): dimmed. */
    future?: number
    /** Clickable columns: a transparent hit area per tick that has run, with data-tick. */
    hit?: boolean
    /** Markers in the tick header, by column: 'term' (the chart terminated), 'error' (a run-time error). */
    marks?: Record<number, 'term' | 'error'>
    /** Draw the lane names as a separate SVG before the lanes (`div.sc-wave-wrap`), so CSS can keep them in
     *  view while a long trace scrolls sideways. */
    stickyLabels?: boolean
    /** Add the values as a visually hidden table (one row per tick, one column per lane) for screen readers;
     *  the drawing is then hidden from them. */
    table?: boolean
}

const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A value as the diagram writes it (numbers rounded to three decimals). */
export const waveText = (v: WaveValue): string => fmt(v)

const fmt = (v: WaveValue): string => {
    if (v === undefined || v === null) return ''
    if (typeof v === 'boolean') return v ? 'true' : 'false'
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
    return v
}

const isSample = (v: unknown): v is SignalSample => typeof v === 'object' && v !== null && 'present' in v

const r2 = (n: number) => Math.round(n * 100) / 100

/** Diagonal hatching (45°, every `step` px) inside a rectangle, as one path. */
export function hatchPath(x0: number, y0: number, w: number, h: number, step = 5): string {
    let d = ''
    for (let k = -h + step / 2; k < w; k += step) {
        let xa = x0 + k
        let ya = y0 + h
        let xb = x0 + k + h
        let yb = y0
        if (xa < x0) {
            ya -= x0 - xa
            xa = x0
        }
        if (xb > x0 + w) {
            yb += xb - (x0 + w)
            xb = x0 + w
        }
        if (xb - xa < 0.5) continue
        d += `M${r2(xa)} ${r2(ya)}L${r2(xb)} ${r2(yb)}`
    }
    return d
}

/** Width of the label column for these lane names (monospaced, 12.5 px). */
export function labelWidthFor(names: string[], min = 48, max = 150): number {
    const longest = Math.max(0, ...names.map((n) => n.length))
    return Math.max(min, Math.min(max, Math.ceil(longest * 7.6 + 18)))
}

export function renderWave(rows: WaveRow[], options: WaveOptions): string {
    const labelW = options.labelWidth ?? 84
    const colW = options.columnWidth ?? 40
    const headH = 24
    const rowH = 30
    const gap = 6
    const groupH = 18
    const first = options.firstTick ?? 1
    const cols = Math.max(options.columns, ...rows.map((r) => r.values.length))
    const ran = Math.max(0, ...rows.map((r) => r.values.findLastIndex((v) => v !== undefined) + 1))
    const cursor = options.cursor ?? ran - 1

    // Lane positions, with a gap between role groups and a caption above each named group.
    const ys: number[] = []
    const captions: { y: number; text: string; marks?: Record<number, 'term' | 'error'> }[] = []
    let y = headH
    rows.forEach((r, i) => {
        const prev = rows[i - 1]
        if (r.group !== undefined && r.group !== prev?.group) {
            if (i > 0) y += gap
            captions.push({ y, text: r.group, marks: r.groupMarks })
            y += groupH
        } else if (i > 0 && (r.role ?? 'output') !== (prev.role ?? 'output')) y += gap
        ys.push(y)
        y += rowH
    })
    const height = y + 4
    const width = labelW + cols * colW + 1
    const x = (c: number) => labelW + c * colW
    const parts: string[] = []
    const sticky = !!options.stickyLabels
    // With sticky labels the names go into their own SVG; `names` is where they are collected.
    const names: string[] = sticky ? [] : parts

    // With a table, screen readers read the table and not the drawing.
    const a11y = options.table ? ' aria-hidden="true"' : ` role="img"${options.title ? ` aria-label="${esc(options.title)}"` : ''}`
    parts.push(
        sticky
            ? `<svg class="sc-wave sc-wave__lanes" xmlns="http://www.w3.org/2000/svg" viewBox="${labelW} 0 ${width - labelW} ${height}" width="${width - labelW}" height="${height}"${a11y}>`
            : `<svg class="sc-wave" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"${a11y}>`
    )

    // Cursor column and grid.
    if (cursor >= 0 && cursor < cols) {
        parts.push(`<rect class="wv-cursor" x="${x(cursor)}" y="0" width="${colW}" height="${height}"/>`)
    }
    for (let c = 0; c <= cols; c++) {
        parts.push(`<line class="wv-grid" x1="${x(c)}" x2="${x(c)}" y1="${headH - 6}" y2="${height}"/>`)
    }
    parts.push(`<line class="wv-axis" x1="${labelW}" x2="${width}" y1="${headH - 6}" y2="${headH - 6}"/>`)
    for (let c = 0; c < cols; c++) {
        const mark = options.marks?.[c]
        parts.push(
            `<text class="wv-tick${c === cursor ? ' is-cursor' : ''}${mark ? ` is-${mark}` : ''}" x="${x(c) + colW / 2}" y="${headH - 11}">${first + c}</text>`
        )
        if (mark === 'term') {
            // KIELER's termination triangle, small, at the right of the tick number.
            const tx = x(c) + colW - 9
            parts.push(`<path class="wv-term" d="M${tx} ${headH - 19}l6 4l-6 4z"><title>The chart terminated in this tick</title></path>`)
        } else if (mark === 'error') {
            parts.push(`<circle class="wv-error" cx="${x(c) + colW - 6}" cy="${headH - 15}" r="3"><title>A run-time error in this tick</title></circle>`)
        }
    }
    // Hit areas under the lanes (the lanes ignore the pointer, except state segments).
    if (options.hit) {
        for (let c = 0; c < Math.min(ran, cols); c++) {
            parts.push(`<rect class="wv-hit" data-tick="${first + c}" x="${x(c)}" y="0" width="${colW}" height="${height}"><title>Tick ${first + c}</title></rect>`)
        }
    }
    for (const cap of captions) {
        names.push(`<text class="wv-group" x="8" y="${cap.y + groupH / 2 + 1}">${esc(cap.text)}</text>`)
        // The group's own termination / error markers, in its caption row (Compare: one per chart).
        for (const [col, mark] of Object.entries(cap.marks ?? {})) {
            const c = Number(col)
            if (c >= cols) continue
            const cy = cap.y + groupH / 2 + 1
            parts.push(
                mark === 'term'
                    ? `<path class="wv-term" d="M${x(c) + colW / 2 - 3} ${cy - 4}l6 4l-6 4z"><title>${esc(cap.text)} terminated in this tick</title></path>`
                    : `<circle class="wv-error" cx="${x(c) + colW / 2}" cy="${cy}" r="3"><title>A run-time error in ${esc(cap.text)} in this tick</title></circle>`
            )
        }
    }

    rows.forEach((row, i) => {
        const top = ys[i]
        const hi = top + 6
        const lo = top + rowH - 6
        const mid = (hi + lo) / 2
        parts.push(`<g class="wv-row" data-role="${row.role ?? 'output'}" data-name="${esc(row.name)}">`)
        const label = `<text class="wv-label" x="${labelW - 10}" y="${mid}">${row.title && row.title !== row.name ? `<title>${esc(row.title)}</title>` : ''}${esc(row.name)}</text>`
        if (sticky) names.push(`<g class="wv-lrow" data-role="${row.role ?? 'output'}">${label}</g>`)
        else parts.push(label)
        parts.push(`<line class="wv-base" x1="${labelW}" x2="${width}" y1="${top + rowH}" y2="${top + rowH}"/>`)
        row.marks?.forEach((m, c) => {
            if (m && c < cols) parts.push(`<rect class="wv-diff" x="${x(c) + 1}" y="${top + 2}" width="${colW - 2}" height="${rowH - 4}" rx="3"/>`)
        })
        // Suspended spans: hatched over the value's shape, under its text (runs of columns as one block).
        const hatch: string[] = []
        if (row.hatch?.some(Boolean)) {
            let c = 0
            while (c < cols) {
                if (!row.hatch[c]) {
                    c++
                    continue
                }
                let e = c + 1
                while (e < cols && row.hatch[e]) e++
                hatch.push(`<path class="wv-hatch" d="${hatchPath(x(c), top + 2, (e - c) * colW, rowH - 4)}"/>`)
                c = e
            }
        }

        const n = row.values.findLastIndex((v) => v !== undefined) + 1
        if (n === 0) {
            parts.push(...hatch, '</g>')
            return
        }
        const texts: string[] = []
        const ref = (c: number) => (row.refs?.[c] ? ` data-ref="${esc(row.refs[c]!)}"` : '')
        if (row.kind === 'bool') {
            let d = ''
            let fill = ''
            for (let c = 0; c < n; c++) {
                const v = row.values[c]
                const yy = v ? hi : lo
                d += c === 0 ? `M${x(0)} ${yy}` : ` V${yy}`
                d += ` H${x(c + 1)}`
                if (v) fill += `<rect class="wv-fill" x="${x(c)}" y="${hi}" width="${colW}" height="${lo - hi}"/>`
            }
            parts.push(fill, `<path class="wv-line" d="${d}"/>`)
        } else {
            // A bus: one hexagon-ended segment per run of equal values. A valued signal starts a new segment in
            // every tick it is present (each emission is an event) and whenever its value changes.
            const sample = (c: number): SignalSample => {
                const v = row.values[c]
                return isSample(v) ? v : { present: false, value: v as WaveValue }
            }
            const same = (a: SignalSample, b: SignalSample) =>
                !a.present && !b.present && (a.value === null) === (b.value === null) && fmt(a.value) === fmt(b.value)
            let c = 0
            while (c < n) {
                const s = sample(c)
                let e = c + 1
                while (e < n && same(s, sample(e)) && row.refs?.[e] === row.refs?.[c] && !row.breaks?.[e]) e++
                const x1 = x(c)
                const x2 = x(e)
                if (s.value === null || s.value === undefined) {
                    parts.push(`<path class="wv-none" d="M${x1} ${mid} H${x2}"/>`)
                    c = e
                    continue
                }
                const k = 4
                const present = row.kind === 'signal' && s.present
                const cls = row.kind === 'signal' ? (present ? 'wv-bus is-present' : 'wv-bus is-absent') : 'wv-bus'
                parts.push(`<path class="${cls}"${ref(c)} d="M${x1} ${mid} L${x1 + k} ${hi} H${x2 - k} L${x2} ${mid} L${x2 - k} ${lo} H${x1 + k} Z"/>`)
                const label = fmt(s.value)
                const room = x2 - x1 - 2 * k - 4
                const shown = label.length * 7.2 > room ? label.slice(0, Math.max(1, Math.floor(room / 7.2) - 1)) + '…' : label
                const vcls = row.kind === 'signal' && !present ? 'wv-value is-held' : 'wv-value'
                const tip = row.kind === 'signal' ? `${label} (${present ? 'present' : 'absent'})` : label
                texts.push(`<text class="${vcls}" x="${(x1 + x2) / 2}" y="${mid}"><title>${esc(tip)}</title>${esc(shown)}</text>`)
                c = e
            }
        }
        parts.push(...hatch, ...texts, '</g>')
    })

    if (options.future !== undefined && options.future < cols) {
        const from = Math.max(0, options.future)
        const fw = Math.max(0, Math.min(ran, cols) - from) * colW
        if (fw > 0) parts.push(`<rect class="wv-future" x="${x(from)}" y="${headH - 6}" width="${fw}" height="${height - headH + 6}"/>`)
    }

    parts.push('</svg>')
    const table = options.table ? waveTable(rows, { ...options, firstTick: first, cursor, ran: Math.min(ran, cols) }) : ''
    if (!sticky) return parts.join('') + table
    const labels = `<svg class="sc-wave sc-wave__labels" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${labelW} ${height}" width="${labelW}" height="${height}" aria-hidden="true">${names.join('')}</svg>`
    return `<div class="sc-wave-wrap">${labels}${parts.join('')}</div>${table}`
}

/** One value as a screen reader should hear it. */
function sayValue(row: WaveRow, v: WaveValue | SignalSample): string {
    if (v === undefined) return ''
    if (row.kind === 'bool') return row.presence ? (v ? 'present' : 'absent') : v ? 'true' : 'false'
    if (isSample(v)) return `${v.present ? 'present' : 'absent'}${v.value === null || v.value === undefined ? '' : `, ${fmt(v.value)}`}`
    if (v === null) return row.role === 'state' ? 'not active' : 'no value'
    return fmt(v as WaveValue)
}

/**
 * The timing diagram as a table for screen readers (in a `div.sc-visually-hidden`): a row per tick that has run
 * ("Tick 3, shown"), a column per lane, headed by its title (Compare: prefixed with the chart's name).
 */
export function waveTable(rows: WaveRow[], o: WaveOptions & { firstTick: number; cursor: number; ran: number }): string {
    // The class that hides it is on a wrapper: a table is never narrower than its content, so a hidden table with
    // many columns would still widen the trace's scroll area.
    const out: string[] = ['<div class="sc-visually-hidden wv-table-wrap"><table class="wv-table">']
    if (o.title) out.push(`<caption>${esc(o.title)}</caption>`)
    const head = (r: WaveRow) => `${r.group ? `${r.group}: ` : ''}${r.title ?? r.name}`
    out.push(`<thead><tr><th scope="col">Tick</th>${rows.map((r) => `<th scope="col">${esc(head(r))}</th>`).join('')}</tr></thead><tbody>`)
    for (let c = 0; c < o.ran; c++) {
        const status = [
            c === o.cursor && 'shown',
            o.future !== undefined && c >= o.future && 'after the tick shown',
            o.marks?.[c] === 'term' && 'the chart terminated',
            o.marks?.[c] === 'error' && 'a run-time error',
            ...rows.filter((r) => r.groupMarks?.[c]).map((r) => (r.groupMarks![c] === 'term' ? `${r.group} terminated` : `a run-time error in ${r.group}`)),
        ].filter(Boolean)
        const cells = rows.map((r) => `<td>${esc(sayValue(r, r.values[c]))}${r.hatch?.[c] ? ', suspended' : ''}${r.marks?.[c] ? ', differs' : ''}</td>`).join('')
        out.push(`<tr${c === o.cursor ? ' aria-current="true"' : ''}><th scope="row">Tick ${o.firstTick + c}${status.length ? `, ${status.join(', ')}` : ''}</th>${cells}</tr>`)
    }
    out.push('</tbody></table></div>')
    return out.join('')
}
