/* global document, HTMLElement, window */
import { HOST_EXTENSION } from 'vscode-messenger-common'
import { Messenger } from 'vscode-messenger-webview'
import {
    BuildIssue,
    BuildReport,
    DiagnosticCommand,
    diagnosticCommand,
    diagnosticState,
} from '../../../src/kico/diagnostic-protocol'
import { h, replaceChildren } from '../simulation/dom'

export class DiagnosticView {
    readonly el = h('section.kd-panel', { hidden: true, 'aria-label': 'Compiler diagnostics' })

    private key = ''

    private readonly highlightStatus = h('p.kd-muted', { role: 'status', hidden: true })

    showHighlightStatus(message: string): void {
        this.highlightStatus.textContent = message
        this.highlightStatus.hidden = !message
    }

    constructor(private readonly messenger: Messenger) {
        const toolbar = document.querySelector('.kv-toolbar')
        toolbar?.after(this.el)
        messenger.onNotification(diagnosticState, ({ report, showWarnings }) =>
            this.render(report, showWarnings ?? true)
        )
    }

    connect(): void {
        this.send({ kind: 'request' })
    }

    private send(command: DiagnosticCommand): void {
        this.messenger.sendNotification(diagnosticCommand, HOST_EXTENSION, command)
    }

    render(report?: BuildReport, showWarnings = true): void {
        const key = JSON.stringify([report, showWarnings])
        if (key === this.key) return
        this.key = key
        this.showHighlightStatus('')
        this.el.hidden = !report || (report.status === 'succeeded' && report.issues.length === 0)
        if (!report || this.el.hidden) {
            replaceChildren(this.el)
            return
        }
        const errors = report.issues.filter((issue) => issue.severity === 'error')
        const warnings = report.issues.filter((issue) => issue.severity === 'warning')
        const notes = report.issues.filter((issue) => issue.severity === 'info')
        const stale = report.status === 'stale'
        const heading = stale
            ? 'Source changed. Compile again to refresh diagnostics.'
            : report.status === 'compiling'
              ? 'Compiling model…'
              : report.status === 'cancelled'
                ? 'Compilation cancelled'
                : errors.length
                  ? `${errors.length === 1 ? 'Compilation failed' : `${errors.length} compilation issues`} · ${
                        errors[0].stage
                    }`
                  : !warnings.length
                    ? `Compiled with ${notes.length} note${notes.length === 1 ? '' : 's'}`
                    : showWarnings
                      ? `Compiled with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
                      : `Compiled, ${warnings.length} warning${warnings.length === 1 ? '' : 's'} hidden`
        this.el.classList.toggle('kd-stale', stale)
        // The warnings are hidden and shown from here as well as from the editor; it is one setting.
        const warningToggle =
            warnings.length > 0 &&
            this.button(showWarnings ? 'Hide warnings' : 'Show warnings', () =>
                this.send({ kind: 'showWarnings', enabled: !showWarnings })
            )
        const title = h(
            'div.kd-heading',
            {},
            h('strong', { role: errors.length && !stale ? 'alert' : 'status' }, heading),
            h(
                'div.kd-actions',
                {},
                warningToggle,
                this.button('Problems', () => this.send({ kind: 'problems', build: report.id })),
                this.button('Copy diagnostics', () => this.send({ kind: 'copy', build: report.id }))
            )
        )
        const warningList =
            warnings.length > 0 &&
            showWarnings &&
            h(
                'details.kd-warnings',
                {},
                h('summary', {}, `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`),
                ...warnings.map((issue) => this.issue(report, issue))
            )
        replaceChildren(
            this.el,
            title,
            ...errors.map((issue) => this.issue(report, issue)),
            ...notes.map((issue) => this.issue(report, issue)),
            this.highlightStatus,
            warningList
        )
        window.dispatchEvent(new Event('resize'))
    }

    private issue(report: BuildReport, issue: BuildIssue): HTMLElement {
        const usable = report.status === 'failed' || report.status === 'succeeded'
        const send = (kind: 'details' | 'stage' | 'highlight') => this.send({ kind, build: report.id, issue: issue.id })
        const locations = issue.locations.filter((location) => location.uri === report.uri)
        const trace =
            issue.cycle.length > 0 &&
            h(
                'details.kd-explanation',
                {},
                h('summary', {}, 'Explain this conflict'),
                h('p.kd-muted', {}, 'These operations require a circular order within one tick:'),
                h(
                    'ol.kd-cycle',
                    {},
                    ...issue.cycle.map((edge) =>
                        h(
                            'li',
                            {},
                            h(
                                'div.kd-order',
                                {},
                                h('code', {}, edge.fromLabel ?? edge.from),
                                h('span.kd-before', {}, 'must run before'),
                                h('code', {}, edge.toLabel ?? edge.to)
                            ),
                            h('p.kd-muted', {}, edge.reason)
                        )
                    )
                ),
                h('p.kd-loop', {}, '↳ The last dependency returns to the first operation.'),
                issue.hint && h('p.kd-hint', {}, issue.hint)
            )
        const sources = h(
            'div.kd-sources',
            {},
            ...issue.locations.map((location, index) =>
                this.button(
                    location.uri === report.uri ? location.label : `${sourceKind(location.uri)}: ${location.label}`,
                    () => this.send({ kind: 'source', build: report.id, issue: issue.id, location: index }),
                    !usable
                )
            )
        )
        return h(
            'article.kd-issue',
            {},
            h('p.kd-message', {}, issue.message),
            sources,
            trace,
            !trace && issue.hint && h('p.kd-hint', {}, issue.hint),
            h(
                'div.kd-actions',
                {},
                locations.some((location) => location.traceUris?.length) &&
                    this.button('Highlight in diagram', () => send('highlight'), !usable),
                issue.snapshotIndex >= 0 &&
                    this.button(
                        issue.code === 'scheduling-cycle' ? 'View scheduler graph' : 'View compiler stage',
                        () => send('stage'),
                        !usable
                    ),
                this.button('Technical details', () => send('details'))
            )
        )
    }

    private button(label: string, onclick: () => void, disabled = false): HTMLElement {
        return h('button.kd-button', { type: 'button', onclick, disabled }, label)
    }
}

function sourceKind(uri: string): string {
    const extension = uri
        .split(/[?#]/)[0]
        .match(/\.(\w+)$/)?.[1]
        ?.toLowerCase()
    if (extension === 'sctx') return 'Related SCChart'
    if (extension === 'scl') return 'Related SCL'
    if (extension === 'kico') return 'Related compilation system'
    if (extension === 'java') return 'Generated Java'
    if (extension === 'c' || extension === 'h') return 'Generated C'
    return 'Related source'
}
