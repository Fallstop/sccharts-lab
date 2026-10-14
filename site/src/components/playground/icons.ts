// Stroke icons for the playground's toolbar and diagram controls (16 x 16, currentColor), in the style of
// src/components/frame/icons.ts.
const svg = (d: string) =>
    `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`

export const pgIcons = {
    examples: svg('<rect x="2" y="2.5" width="5" height="4.5" rx="2.25"/><rect x="9" y="2.5" width="5" height="4.5" rx="2.25"/><rect x="2" y="9" width="5" height="4.5" rx="2.25"/><rect x="9" y="9" width="5" height="4.5" rx="2.25"/>'),
    chevron: svg('<path d="m4.5 6 3.5 3.5L11.5 6"/>'),
    new: svg('<path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z"/><path d="M9 2v4h4M8 8.5v3.5M6.25 10.25h3.5"/>'),
    open: svg('<path d="M2 12.5v-8A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v6.5A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5z"/><path d="M8 11.5v-4M6.25 9.25 8 7.5l1.75 1.75"/>'),
    download: svg('<path d="M8 2.5v8M4.75 7.5 8 10.75l3.25-3.25M3 13.5h10"/>'),
    link: svg('<path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2-2a2.76 2.76 0 0 0-3.9-3.9l-.6.6"/><path d="M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2 2a2.76 2.76 0 0 0 3.9 3.9l.6-.6"/>'),
    keyboard: svg('<rect x="1.75" y="4" width="12.5" height="8" rx="1.5"/><path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5.5 9.5h5"/>'),
    zoomIn: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3M5 7h4M7 5v4"/>'),
    zoomOut: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3M5 7h4"/>'),
    fit: svg('<path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10"/>'),
    rebuild: svg('<path d="M13 4.5A5.5 5.5 0 0 0 3.1 6M3 11.5A5.5 5.5 0 0 0 12.9 10"/><path d="M13.25 1.75v3h-3M2.75 14.25v-3h3"/>'),
    close: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
    search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>'),
    undo: svg('<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7"/>'),
    problems: svg('<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.75h.01"/>'),
    ok: svg('<path d="m3 8.5 3.25 3.25L13 4.75"/>'),
    // Two traces side by side: the reader's and the model solution's.
    compare: svg('<path d="M2 5.5h2.5v-3h3v3H10M2 12h4.5V9h3v3H14"/><path d="m12 3.5 2 2-2 2"/>'),
    // A nested list.
    outline: svg('<path d="M2.5 3.5h.01M5.5 3.5h8M4.5 8h.01M7.5 8h6M4.5 12.5h.01M7.5 12.5h6"/>'),
    // Three lanes of a timing diagram.
    variables: svg('<path d="M2 4h4V2.5h3V4h5M2 8.5h2V7h5v1.5h5M2 13h7v-1.5h3V13h2"/>'),
    // A question mark in a circle.
    help: svg('<circle cx="8" cy="8" r="6"/><path d="M6.25 6.4a1.85 1.85 0 0 1 3.6.6c0 1.25-1.85 1.6-1.85 2.75M8 11.6h.01"/>'),
    // An i in a circle.
    info: svg('<circle cx="8" cy="8" r="6"/><path d="M8 7.25v4M8 4.9h.01"/>'),
    image: svg('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="m2.5 11.5 3.5-3.5 2.5 2.5 2-2 3 3"/><circle cx="10.75" cy="5.75" r="1"/>'),
}
