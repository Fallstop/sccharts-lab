// Small stroke icons for widget controls (16 x 16, currentColor). Inline SVG strings.
const svg = (d: string) =>
    `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`

export const icons = {
    reset: svg('<path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.77"/><path d="M2.5 2.5v3.25h3.25"/>'),
    back: svg('<path d="M3.5 3v10"/><path d="M12.5 3.5 6.5 8l6 4.5z" fill="currentColor"/>'),
    step: svg('<path d="M12.5 3v10"/><path d="M3.5 3.5 9.5 8l-6 4.5z" fill="currentColor"/>'),
    play: svg('<path d="M4.5 3 13 8l-8.5 5z" fill="currentColor"/>'),
    pause: svg('<path d="M5 3.5v9M11 3.5v9" stroke-width="2.25"/>'),
    check: svg('<path d="m3 8.5 3.25 3.25L13 4.75"/>'),
    cross: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
    open: svg('<path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M14 2 7.5 8.5"/>'),
}
