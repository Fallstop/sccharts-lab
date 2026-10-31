// Launches Playwright's chromium. The playwright package may expect a newer browser build than the one
// installed in ~/.cache/ms-playwright, so this falls back to the newest installed build.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

function installedExecutable() {
    const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), '.cache/ms-playwright')
    if (!fs.existsSync(cache)) return undefined
    const candidates = []
    for (const dir of fs.readdirSync(cache)) {
        const m = /^(chromium_headless_shell|chromium)-(\d+)$/.exec(dir)
        if (!m) continue
        const exe = m[1] === 'chromium'
            ? path.join(cache, dir, 'chrome-linux64/chrome')
            : path.join(cache, dir, 'chrome-headless-shell-linux64/chrome-headless-shell')
        if (fs.existsSync(exe)) candidates.push({ exe, build: Number(m[2]), shell: m[1] !== 'chromium' })
    }
    candidates.sort((a, b) => b.build - a.build || Number(b.shell) - Number(a.shell))
    return candidates[0]?.exe
}

export async function launchChromium(options = {}) {
    try {
        return await chromium.launch(options)
    } catch (error) {
        const executablePath = installedExecutable()
        if (!executablePath) throw error
        return chromium.launch({ ...options, executablePath })
    }
}
