// Deterministic ids for SVG gradients and ARIA relationships. A counter per build (module state), so
// two renders of the same page produce the same markup.
let counter = 0

export function nextId(prefix = ''): string {
    counter += 1
    return `${prefix}${counter.toString(36)}`
}
