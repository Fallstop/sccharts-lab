// The names KIELER gives the classes it makes while compiling, in one place (structure.md S-65a).
//
// kicool keeps one cache of names per compilation (annotations/extensions/UniqueNameCache.xtend), filled with every
// name of the compiled file (UniqueNameCachePopulation: states, regions, variables, classes, annotations) and with
// every name it hands out. `uniqueName` on a name that is taken appends the next free number, counting on per name.
// Two processors name classes with it:
// - Reference (handleSCChartsDatatype): the class of a `ref C g` declaration starts as `C`, which the chart `C` has
//   taken, so it is `C1`, the next declaration's `C2`; a class or variable of the file called `C1` moves both on.
//   Instances declared together are one class.
// - the class of an inner state moves to the root under a unique name: `C` becomes `C1`, a chart instance's class
//   `Cell1` becomes `Cell11`.
// The Reference pass names its classes as it expands (CVar.className); typeNames gives the final names once the
// passes have run, which @sccharts-lab/trace lists as KIELER's `#interface` does.

import { allScopes, type CState, type CVar } from '../model'

export class UniqueNames {
    private readonly taken = new Set<string>()
    private readonly highest = new Map<string, number>()

    add(name: string) {
        this.taken.add(name)
    }

    /** KIELER's getNewUniqueName. */
    unique(base: string): string {
        if (!this.taken.has(base)) {
            this.taken.add(base)
            return base
        }
        let n = (this.highest.get(base) ?? 0) + 1
        while (this.taken.has(`${base}${n}`)) n++
        this.highest.set(base, n)
        this.taken.add(`${base}${n}`)
        return `${base}${n}`
    }
}

/** The cache as a compilation starts: every name written in the file (`source`: its syntax tree). */
export function fileNames(source: unknown): UniqueNames {
    const names = new UniqueNames()
    const collect = (value: unknown) => {
        if (Array.isArray(value)) { value.forEach(collect); return }
        if (!value || typeof value !== 'object') return
        for (const [k, v] of Object.entries(value)) {
            if ((k === 'name' || k === 'className') && typeof v === 'string') names.add(v)
            else if (k !== 'span' && v && typeof v === 'object') collect(v)
        }
    }
    collect(source)
    return names
}

/** The key of typeNames: an instance and the scope its members are declared in. */
export function typeKey(instance: CVar, scope: { uid: number }): string {
    return `${instance.uid}|${scope.uid}`
}

/**
 * The type of every class object that has members, by typeKey: a class of the chart keeps its name, a chart instance
 * has the class the Reference pass named, and one declared in an inner state has the name KIELER gives it when it
 * moves it to the root (instances of one declaration, and chart instances declared together, share it; every copy
 * of a for-region's state has its own). `declared`: the source declaration and class name of a class or struct
 * instance.
 */
export function typeNames(core: CState, names: UniqueNames, declared: (v: CVar) => { declaration: object; className?: string } | undefined): Map<string, string> {
    const out = new Map<string, string>()
    const risen = new Map<string, string>()
    const ids = new Map<object, number>()
    const idOf = (d: object) => ids.get(d) ?? ids.set(d, ids.size).get(d)!
    for (const scope of allScopes(core)) {
        for (const v of scope.decls) {
            if (!v.member || v.const || v.tags.has('#const-member')) continue
            // (A method or schedule of a class is no member KIELER lists: it names nothing.)
            if (v.declKind && v.declKind !== 'class' && v.declKind !== 'struct') continue
            let root = v.member.of
            while (root.member) root = root.member.of
            if (out.has(typeKey(root, scope))) continue
            const reference = root.declKind === 'reference' && !!root.instance
            const source = reference ? undefined : declared(root)
            const name = reference ? root.className : source?.className
            if (!name) continue
            if (scope === core) {
                out.set(typeKey(root, scope), name)
                continue
            }
            const key = `${reference ? `ref ${root.classKey ?? root.uid}` : `class ${idOf(source!.declaration)}`}|${scope.uid}`
            if (!risen.has(key)) risen.set(key, names.unique(name))
            out.set(typeKey(root, scope), risen.get(key)!)
        }
    }
    return out
}
