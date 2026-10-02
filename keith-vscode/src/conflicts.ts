import * as vscode from 'vscode'

/**
 * Upstream extensions this fork cannot run beside. Both register the same `keith-vscode.*`
 * commands, language ids and views, and each starts its own language server for the same files.
 */
export const CONFLICTING_EXTENSIONS: ReadonlyArray<{ id: string; name: string }> = [
    { id: 'kieler.keith-vscode', name: 'KIELER VS Code' },
]

export function findConflictingExtensions(
    extensions: Pick<typeof vscode.extensions, 'getExtension'> = vscode.extensions
): Array<{ id: string; name: string }> {
    return CONFLICTING_EXTENSIONS.filter((extension) => extensions.getExtension(extension.id) !== undefined)
}

/** Reports installed conflicts and returns true when activation must be abandoned. */
export async function reportConflictingExtensions(
    conflicts = findConflictingExtensions(),
    window: Pick<typeof vscode.window, 'showErrorMessage'> = vscode.window,
    commands: Pick<typeof vscode.commands, 'executeCommand'> = vscode.commands
): Promise<boolean> {
    if (conflicts.length === 0) {
        return false
    }
    const names = conflicts.map((extension) => extension.name).join(', ')
    const uninstall = 'Uninstall and reload'
    const show = 'Show conflicting extension'
    const choice = await window.showErrorMessage(
        `SCCharts Lab cannot run beside ${names}. Uninstall it, then reload the window.`,
        uninstall,
        show
    )
    if (choice === uninstall) {
        try {
            for (const extension of conflicts) {
                // eslint-disable-next-line no-await-in-loop -- VS Code uninstalls one extension at a time.
                await commands.executeCommand('workbench.extensions.uninstallExtension', extension.id)
            }
            await commands.executeCommand('workbench.action.reloadWindow')
        } catch (error) {
            window.showErrorMessage(`Could not uninstall ${names}: ${error instanceof Error ? error.message : error}`)
            await commands.executeCommand('workbench.extensions.search', `@id:${conflicts[0].id}`)
        }
    } else if (choice === show) {
        await commands.executeCommand('workbench.extensions.search', `@id:${conflicts[0].id}`)
    }
    return true
}
