// What a reader sees when code loaded on demand does not arrive (the connection dropped; a deploy replaced the files
// meanwhile): a plain message and Retry in place of a widget that would otherwise stay silently dead. Retry loads it
// again; a browser that keeps the failed import (some do) gets the page reloaded instead.

/** Shows the message in `host` (`at: 'start'` puts it before what the host holds; 'replace' empties the host first).
 *  `retry` loads the code again and resolves once it works; the message goes then. Returns the message element. */
export function showLoadFailure(host: Element, what: string, retry: () => Promise<void>, at: 'start' | 'replace' = 'start'): HTMLElement {
    const box = document.createElement('p')
    box.className = 'sc-load-failure'
    box.setAttribute('role', 'alert')
    const text = document.createElement('span')
    text.textContent = `${what} could not load: the connection may have dropped.`
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'sc-btn sc-btn--sm'
    button.textContent = 'Retry'
    let tries = 0
    button.addEventListener('click', async () => {
        if (tries > 0) return location.reload()
        tries++
        button.disabled = true
        try {
            await retry()
            box.remove()
        } catch {
            text.textContent = `${what} still could not load. Reloading the page usually brings it back.`
            button.textContent = 'Reload the page'
            button.disabled = false
        }
    })
    box.append(text, ' ', button)
    if (at === 'replace') host.replaceChildren(box)
    else host.prepend(box)
    return box
}
