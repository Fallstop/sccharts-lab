import * as vscode from 'vscode'

/** Generated files may receive findings from several models; clearing one model must preserve the others. */
export class OwnedDiagnostics implements vscode.Disposable {
    private readonly collection: vscode.DiagnosticCollection

    private readonly owners = new Map<string, Map<string, vscode.Diagnostic[]>>()

    constructor(name: string) {
        this.collection = vscode.languages.createDiagnosticCollection(name)
    }

    publish(owner: string, diagnostics: Map<string, vscode.Diagnostic[]>): void {
        const files = new Set([...(this.owners.get(owner)?.keys() ?? []), ...diagnostics.keys()])
        this.owners.set(owner, diagnostics)
        this.refresh(files)
    }

    remove(owner: string): void {
        const files = this.owners.get(owner)?.keys()
        this.owners.delete(owner)
        if (files) this.refresh(files)
    }

    clear(): void {
        this.owners.clear()
        this.collection.clear()
    }

    dispose(): void {
        this.owners.clear()
        this.collection.dispose()
    }

    private refresh(files: Iterable<string>): void {
        for (const file of files) {
            const diagnostics = [...this.owners.values()].flatMap((entries) => entries.get(file) ?? [])
            const uri = vscode.Uri.parse(file)
            if (diagnostics.length) this.collection.set(uri, diagnostics)
            else this.collection.delete(uri)
        }
    }
}
