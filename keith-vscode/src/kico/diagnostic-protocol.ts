import type { NotificationType } from 'vscode-messenger-common'

export interface SourceLocation {
    uri: string
    offset: number
    length: number
    label: string
    line?: number
    column?: number
    generatedLine?: string
    traceUris?: string[]
}

export interface DependencyEdge {
    from: string
    to: string
    reason: string
    fromLabel?: string
    toLabel?: string
    locations: SourceLocation[]
}

export interface CompilerIssue {
    code: string
    message: string
    severity: 'error' | 'warning' | 'info'
    hint?: string
    details?: string
    locations: SourceLocation[]
    cycle: DependencyEdge[]
}

export interface BuildIssue extends CompilerIssue {
    id: string
    stage: string
    snapshotIndex: number
}

export interface BuildReport {
    id: number
    uri: string
    version: number
    status: 'compiling' | 'failed' | 'succeeded' | 'stale' | 'cancelled'
    issues: BuildIssue[]
    rawCount: number
}

export const diagnosticState: NotificationType<{ modelUri?: string; report?: BuildReport; showWarnings?: boolean }> = {
    method: 'keith/diagnostics/state',
}

export type DiagnosticCommand =
    | { kind: 'request' }
    | { kind: 'problems'; build: number }
    | { kind: 'copy'; build: number }
    | { kind: 'showWarnings'; enabled: boolean }
    | { kind: 'source' | 'stage' | 'details' | 'highlight'; build: number; issue: string; location?: number }

export const diagnosticCommand: NotificationType<DiagnosticCommand> = { method: 'keith/diagnostics/command' }

export const diagnosticHighlight: NotificationType<{ traceUris: string[][] }> = {
    method: 'keith/diagnostics/highlight',
}
