// The java launcher for the KIELER server (oracle, checker, diagram reference): SCCHARTS_JAVA, else the newest
// full JDK in the extension build's runtime cache next to this worktree (it has jdk.unsupported, which the
// server needs), else `java` on PATH.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projects = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

export function defaultJava() {
    if (process.env.SCCHARTS_JAVA) return process.env.SCCHARTS_JAVA
    for (const repo of ['sccharts-lab', 'sccharts-lab-site']) {
        const cache = path.join(projects, repo, 'keith-vscode/out/runtime-cache')
        let found = []
        try {
            found = fs.readdirSync(cache).filter(d => d.startsWith('jdk-linux-x64-')).flatMap(d =>
                fs.readdirSync(path.join(cache, d)).map(j => path.join(cache, d, j, 'bin/java')))
        } catch { continue }
        const java = found.filter(f => fs.existsSync(f)).sort().at(-1)
        if (java) return java
    }
    return 'java'
}
