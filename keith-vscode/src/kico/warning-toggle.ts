/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2026 by
 * + Kiel University
 *   + Department of Computer Science
 *     + Real-Time and Embedded Systems Group
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import * as vscode from 'vscode'
import { Settings, settingsKey } from '../constants'
import { SettingsService } from '../settings'
import { CompilerDiagnostics } from './compiler-diagnostics'
import { LiveDiagnostics } from './live-diagnostics'

export const HIDE_WARNINGS = 'keith-vscode.hide-warnings'
export const SHOW_WARNINGS = 'keith-vscode.show-warnings'
/** True while `diagnostics.showWarnings` is off; the menus swap Hide for Show on it. */
export const WARNINGS_HIDDEN_CONTEXT = 'keith.vscode:warningsHidden'

const SETTING = 'diagnostics.showWarnings'

type Compiler = Pick<CompilerDiagnostics, 'get' | 'onDidChange'>
type Live = Pick<LiveDiagnostics, 'get' | 'onDidChange'>

/**
 * The ways to hide and show the compiler's warnings, all changing the one setting: Hide and Show
 * commands (palette and the SCChart editor menu), a quick fix on any warning squiggle, and a status
 * bar item that appears while warnings are hidden, counts them, and shows them again on click.
 */
export class WarningToggle implements vscode.Disposable {
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left)

    private readonly disposables: vscode.Disposable[]

    constructor(
        private readonly settings: Pick<SettingsService<Settings>, 'get' | 'set'>,
        private readonly compiler: Compiler,
        private readonly live: Live
    ) {
        this.status.name = 'KIELER warnings'
        this.status.command = SHOW_WARNINGS
        this.status.tooltip = 'KIELER compiler warnings are hidden from the editor. Click to show them.'
        this.disposables = [
            this.status,
            vscode.commands.registerCommand(HIDE_WARNINGS, () => this.settings.set(SETTING, false)),
            vscode.commands.registerCommand(SHOW_WARNINGS, () => this.settings.set(SETTING, true)),
            vscode.languages.registerCodeActionsProvider(
                'sctx',
                { provideCodeActions: (_document, _range, context) => this.actions(context) },
                { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
            ),
            vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
            vscode.workspace.onDidOpenTextDocument(() => this.refresh()),
            vscode.workspace.onDidCloseTextDocument(() => this.refresh()),
            vscode.workspace.onDidChangeTextDocument(() => this.refresh()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration(`${settingsKey}.${SETTING}`)) this.refresh()
            }),
            compiler.onDidChange(() => this.refresh()),
            live.onDidChange(() => this.refresh()),
        ]
        this.refresh()
    }

    dispose(): void {
        this.disposables.forEach((disposable) => disposable.dispose())
    }

    get hidden(): boolean {
        return this.settings.get(SETTING) === false
    }

    /** On a KIELER warning the lightbulb offers to hide them all. */
    private actions(context: vscode.CodeActionContext | undefined): vscode.CodeAction[] {
        const onWarning = (context?.diagnostics ?? []).some(
            (diagnostic) =>
                diagnostic.severity === vscode.DiagnosticSeverity.Warning && !!diagnostic.source?.startsWith('KIELER')
        )
        if (!onWarning || this.hidden) return []
        const action = new vscode.CodeAction('Hide KIELER warnings', vscode.CodeActionKind.QuickFix)
        action.command = { command: HIDE_WARNINGS, title: 'Hide KIELER warnings' }
        return [action]
    }

    /** The status bar item shows while warnings are hidden and an SCChart is open. */
    refresh(): void {
        const { hidden } = this
        vscode.commands.executeCommand('setContext', WARNINGS_HIDDEN_CONTEXT, hidden)
        if (!hidden || !vscode.workspace.textDocuments.some((document) => isModel(document))) {
            this.status.hide()
            return
        }
        const count = this.hiddenCount()
        this.status.text = count
            ? `$(eye-closed) ${count} warning${count === 1 ? '' : 's'} hidden`
            : '$(eye-closed) Warnings hidden'
        this.status.show()
    }

    /** Warnings the active SCChart would show: a current compile report's, otherwise the live analysis's. */
    private hiddenCount(): number {
        const document = vscode.window.activeTextEditor?.document
        if (!document || !isModel(document)) return 0
        const uri = document.uri.toString()
        const report = this.compiler.get(uri)
        const current =
            report &&
            report.version === document.version &&
            (report.status === 'succeeded' || report.status === 'failed')
        const live = this.live.get(uri)
        const issues = current ? report.issues : live?.version === document.version ? live.issues : []
        return issues.filter((issue) => issue.severity === 'warning').length
    }
}

function isModel(document: vscode.TextDocument): boolean {
    return document.uri.path.endsWith('.sctx')
}
