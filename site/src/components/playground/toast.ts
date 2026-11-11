// The playground's toast: one message at a time (a polite status), with at most one action (Undo, Take over).

import { $, escapeHtml } from './app-types'

export interface ToastAction {
    label: string
    run: () => void
    icon?: string
}

export class Toast {
    private timer?: ReturnType<typeof setTimeout>

    constructor(private root: HTMLElement) {}

    show(message: string, action?: ToastAction) {
        const box = $(this.root, '[data-pg-toast]')
        if (!box) return
        clearTimeout(this.timer)
        box.replaceChildren(Object.assign(document.createElement('span'), { textContent: message }))
        if (action) {
            const b = document.createElement('button')
            b.type = 'button'
            b.className = 'sc-pg-toast__action'
            b.innerHTML = `${action.icon ?? ''}<span>${escapeHtml(action.label)}</span>`
            b.addEventListener('click', () => {
                action.run()
                box.hidden = true
            })
            box.append(b)
        }
        box.hidden = false
        this.timer = setTimeout(() => (box.hidden = true), action ? 7000 : 4000)
    }
}
