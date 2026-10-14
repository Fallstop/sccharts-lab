// KIELER's Enum processor (de.cau.cs.kieler.sccharts.processors.enum): a `ref E x` of an enum E becomes an int
// variable and every value `E.V` the int of its position in E. Done while lowering (lower.ts enumOf, enumValue), since
// it is a plain substitution. A host enum (`host enum`) keeps C's type and values: such charts need C code and are not
// simulated.

import type { Pass, PassContext } from './context'
import type { ModelIndex } from '../../parser/resolve'
import { declsOf } from './detect'

export const enumPass: Pass = {
    id: 'de.cau.cs.kieler.sccharts.processors.enum',
    name: 'Enum',
    owner: 'structure',
    run(ctx: PassContext) {
        const index = ctx.shared.index as ModelIndex | undefined
        const host = declsOf(ctx.root).filter(v => v.declKind === 'enum' && v.decl && index?.vos.get(v.decl)?.decl?.host)
        if (!host.length) return
        ctx.report({
            severity: 'info', code: 'unsupported', span: host[0].span, related: host.flatMap(v => (v.decl ? [v.decl] : [])),
            message: `This chart uses the host enum \`${host[0].name}\`, which cannot run in the browser`,
            hint: 'A host enum takes its values from the C code generated next to the chart, so it needs a C compiler. The official KIELER tools run this chart.',
        })
    },
}
