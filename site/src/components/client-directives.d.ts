// The guide's custom client directive, `client:engage` (src/components/sim/engage.ts, registered in
// astro.config.mjs): an island hydrates when the reader first engages with its widget.
import 'astro'

declare module 'astro' {
    interface AstroClientDirectives {
        'client:engage'?: boolean
    }
}
