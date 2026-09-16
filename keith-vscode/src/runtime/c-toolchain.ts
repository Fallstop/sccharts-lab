/*
 * SCCharts Lab: the native toolchain the C simulation compiles with.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import { spawn, spawnSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as https from 'https'
import * as path from 'path'

/** A `which`/`xcode-select` that has not answered by then is not going to. */
const PROBE_TIMEOUT_MS = 5000

export type CCompilerSource = 'setting' | 'downloaded' | 'PATH'

export interface CCompiler {
    /** Absolute path, or a bare program name when it came from PATH. */
    command: string
    source: CCompilerSource
}

export interface CCompilerLookupOptions {
    /** Value of the `keith-vscode.cCompilerPath` setting. */
    settingPath?: string
    /** `gcc.exe` of a toolchain this extension downloaded, when installed. */
    downloadedGcc?: string
    platform?: NodeJS.Platform
    /** Resolves a program name through PATH (`which`/`where`); undefined when absent. */
    which?: (program: string) => string | undefined
    /** macOS only: whether the Xcode Command Line Tools are installed. `/usr/bin/gcc` exists without them. */
    commandLineToolsInstalled?: () => boolean
    fileSystem?: Pick<typeof fs, 'existsSync'>
}

export function whichProgram(program: string, platform: NodeJS.Platform = process.platform): string | undefined {
    // These run on the UI path (the compiler is looked up before every build), and spawnSync blocks the
    // whole extension host: a `which` that hangs on a dead network mount must not take the window with it.
    const result = spawnSync(platform === 'win32' ? 'where' : 'which', [program], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: PROBE_TIMEOUT_MS,
    })
    if (result.status !== 0) return undefined
    const first = result.stdout.split(/\r?\n/).find((line) => line.trim())
    return first?.trim()
}

export function xcodeCommandLineToolsInstalled(): boolean {
    return spawnSync('xcode-select', ['-p'], { windowsHide: true, timeout: PROBE_TIMEOUT_MS }).status === 0
}

/** Picks the C compiler in this order: explicit setting, downloaded toolchain, `gcc` on PATH. */
export function findCCompiler(options: CCompilerLookupOptions = {}): CCompiler | undefined {
    const platform = options.platform ?? process.platform
    const fileSystem = options.fileSystem ?? fs
    const which = options.which ?? ((program: string) => whichProgram(program, platform))
    const setting = options.settingPath?.trim()
    if (setting) {
        if (path.isAbsolute(setting) || setting.includes('/') || setting.includes('\\')) {
            if (fileSystem.existsSync(setting)) return { command: setting, source: 'setting' }
        } else if (which(setting)) {
            return { command: setting, source: 'setting' }
        }
        // A misconfigured setting must not be silently replaced by another compiler.
        return undefined
    }
    if (options.downloadedGcc && fileSystem.existsSync(options.downloadedGcc)) {
        return { command: options.downloadedGcc, source: 'downloaded' }
    }
    const onPath = which('gcc')
    if (!onPath) return undefined
    if (platform === 'darwin') {
        const installed = options.commandLineToolsInstalled ?? xcodeCommandLineToolsInstalled
        if (!installed()) return undefined
    }
    return { command: 'gcc', source: 'PATH' }
}

/** What to tell someone who has no C compiler, per operating system. */
export function installHint(platform: NodeJS.Platform = process.platform): string {
    switch (platform) {
        case 'win32':
            return 'SCCharts Lab can download w64devkit (a portable GCC, about 61 MB) for you, or set keith-vscode.cCompilerPath to an existing gcc.exe.'
        case 'darwin':
            return 'Install the Xcode Command Line Tools with `xcode-select --install` in a terminal, then try again.'
        default:
            return 'Install gcc with your package manager (Debian/Ubuntu: `sudo apt install build-essential`, Fedora: `sudo dnf install gcc`, Arch: `sudo pacman -S gcc`), then try again.'
    }
}

export interface W64DevkitManifest {
    version: string
    url: string
    sha256: string
    size: number
    /** Path of gcc.exe inside the extracted archive, e.g. `w64devkit/bin/gcc.exe`. */
    gcc: string
}

export interface InstallProgress {
    report(value: { message?: string; increment?: number }): void
}

export interface CancellationSignal {
    isCancellationRequested: boolean
    onCancellationRequested(listener: () => void): { dispose(): void }
}

/**
 * Downloads and unpacks w64devkit into the extension's global storage. The archive is a 7-Zip
 * self-extractor, so no extra tool is needed: running it with `-o<dir> -y` unpacks it. The directory is
 * versioned and stamped, and removed again whenever an installation fails halfway.
 */
export class W64DevkitInstaller {
    readonly directory: string

    constructor(
        storageRoot: string,
        readonly manifest: W64DevkitManifest
    ) {
        this.directory = path.join(storageRoot, 'w64devkit', manifest.version)
    }

    get gcc(): string {
        return path.join(this.directory, this.manifest.gcc)
    }

    get bin(): string {
        return path.dirname(this.gcc)
    }

    get stamp(): string {
        return path.join(this.directory, 'installed.json')
    }

    isInstalled(): boolean {
        return fs.existsSync(this.stamp) && fs.existsSync(this.gcc)
    }

    remove(): void {
        fs.rmSync(path.dirname(this.directory), { recursive: true, force: true })
    }

    async install(progress: InstallProgress, token: CancellationSignal): Promise<void> {
        fs.rmSync(this.directory, { recursive: true, force: true })
        fs.mkdirSync(this.directory, { recursive: true })
        const archive = path.join(this.directory, 'w64devkit.7z.exe')
        try {
            await this.download(archive, progress, token)
            progress.report({ message: 'Unpacking w64devkit...' })
            await this.extract(archive, token)
            if (!fs.existsSync(this.gcc)) {
                throw new Error(`The archive did not contain ${this.manifest.gcc}`)
            }
            fs.writeFileSync(
                this.stamp,
                `${JSON.stringify(
                    {
                        version: this.manifest.version,
                        sha256: this.manifest.sha256,
                        installed: new Date().toISOString(),
                    },
                    null,
                    2
                )}\n`
            )
        } catch (error) {
            fs.rmSync(this.directory, { recursive: true, force: true })
            throw error
        } finally {
            fs.rmSync(archive, { force: true })
        }
    }

    private download(target: string, progress: InstallProgress, token: CancellationSignal): Promise<void> {
        const { url, sha256, size } = this.manifest
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256')
            let received = 0
            let reportedPercent = 0
            const request = (location: string, redirects: number) => {
                const client = https.get(location, { headers: { 'user-agent': 'sccharts-lab' } }, (response) => {
                    const status = response.statusCode ?? 0
                    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects > 0) {
                        response.resume()
                        request(new URL(response.headers.location, location).href, redirects - 1)
                        return
                    }
                    if (status !== 200) {
                        response.resume()
                        reject(new Error(`Download failed: HTTP ${status} from ${location}`))
                        return
                    }
                    const file = fs.createWriteStream(target)
                    const cancel = token.onCancellationRequested(() => {
                        response.destroy(new Error('Download cancelled'))
                    })
                    response.on('data', (chunk: Uint8Array) => {
                        hash.update(chunk)
                        received += chunk.length
                        const percent = Math.floor((received / size) * 100)
                        if (percent > reportedPercent) {
                            progress.report({
                                message: `Downloading w64devkit ${(received / 1e6).toFixed(0)} of ${(
                                    size / 1e6
                                ).toFixed(0)} MB`,
                                increment: percent - reportedPercent,
                            })
                            reportedPercent = percent
                        }
                    })
                    response.on('error', (error) => {
                        cancel.dispose()
                        file.destroy()
                        reject(error)
                    })
                    response.pipe(file)
                    file.on('finish', () => {
                        cancel.dispose()
                        const digest = hash.digest('hex')
                        if (digest !== sha256) {
                            reject(new Error(`Checksum mismatch: expected ${sha256}, downloaded ${digest}`))
                            return
                        }
                        resolve()
                    })
                    file.on('error', reject)
                })
                client.on('error', reject)
            }
            request(url, 5)
        })
    }

    private extract(archive: string, token: CancellationSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            // 7-Zip SFX switches: -o<dir> output directory, -y assume yes.
            const child = spawn(archive, [`-o${this.directory}`, '-y'], { windowsHide: true, stdio: 'ignore' })
            const cancel = token.onCancellationRequested(() => child.kill())
            child.on('error', (error) => {
                cancel.dispose()
                reject(error)
            })
            child.on('exit', (code) => {
                cancel.dispose()
                if (token.isCancellationRequested) reject(new Error('Installation cancelled'))
                else if (code === 0) resolve()
                else reject(new Error(`The w64devkit self-extractor exited with code ${code}`))
            })
        })
    }
}

/** Environment additions for the server process so it and its child processes find the compiler. */
export function serverEnvironment(
    base: NodeJS.ProcessEnv,
    extraPathEntries: string[],
    platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
    const entries = extraPathEntries.filter((entry) => entry)
    if (entries.length === 0) return { ...base }
    // Windows environments are case-insensitive, and the variable is not always spelled PATH.
    const key = Object.keys(base).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
    const separator = platform === 'win32' ? ';' : ':'
    const existing = base[key] ? [base[key] as string] : []
    return { ...base, [key]: [...entries, ...existing].join(separator) }
}
