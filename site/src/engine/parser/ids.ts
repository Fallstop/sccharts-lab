// Element ids, exactly as specified in ../types.ts:
//
//   root state  <ChartName>                      region      <parentStateId>:<regionName | index>
//   state       <parentStateId>.<stateName>      (<regionId>.<stateName> when two regions of the parent hold a
//                                                state of that name)
//   transition  <sourceStateId>-><priority>      action      <stateId>!<kind><index among that kind>
//   declaration <scopeId>$<valuedObjectName>
//
// Collisions the convention does not cover get a suffix: a second region with the same name uses its index, a
// second state or valued object with the same name in the same scope gets #2, #3, ... The implicit state that
// holds the inner regions of `region R { region A: ... }` is <regionId>._ . Members of a class, struct or enum are
// <scopeId>$<Type>.<member>; declarations inside methods and code blocks are <ownerId>$<name> where the owner is
// the method's id or <transitionOrActionId>~<n> for the n-th code block.

import type { Declaration, Effect, LocalAction, Program, Region, SclStatement, State } from '../types'

export function assignIds(program: Program) {
    const charts = new Map<string, number>()
    for (const chart of program.charts) {
        const n = (charts.get(chart.name) ?? 0) + 1
        charts.set(chart.name, n)
        assignState(chart, n === 1 ? chart.name : `${chart.name}#${n}`)
    }
}

function unique(base: string, used: Map<string, number>): string {
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    return n === 1 ? base : `${base}#${n}`
}

function assignDeclarations(declarations: Declaration[], scopeId: string, used: Map<string, number>) {
    for (const d of declarations) {
        for (const vo of d.valuedObjects) vo.id = unique(`${scopeId}$${vo.name}`, used)
        if (d.members) {
            const typeName = d.className ?? d.valuedObjects[0]?.name ?? '?'
            const memberScope = `${scopeId}$${typeName}`
            const memberUsed = new Map<string, number>()
            for (const m of d.members) {
                for (const vo of m.valuedObjects) vo.id = unique(`${memberScope}.${vo.name}`, memberUsed)
                if (m.declKind === 'method') assignMethod(m)
                if (m.members) assignDeclarations(m.members, `${memberScope}.${m.className ?? m.valuedObjects[0]?.name ?? '?'}`, new Map())
            }
        }
        if (d.declKind === 'method') assignMethod(d)
        for (const p of d.policies ?? []) assignPolicy(p, `${scopeId}$${d.className ?? '?'}:policy.${p.name ?? ''}`)
    }
}

/** Policy regions: <ownerId>:policy.<name>, their states <regionId>.<state>. */
function assignPolicy(region: Region, regionId: string) {
    region.id = regionId
    assignDeclarations(region.declarations, regionId, new Map())
    const used = new Map<string, number>()
    for (const s of region.states) {
        s.id = unique(`${regionId}.${s.name}`, used)
        s.transitions.forEach((t, i) => {
            t.priority = i + 1
            t.source = s.id
            t.id = `${s.id}->${t.priority}`
        })
    }
}

function assignMethod(d: Declaration) {
    const methodId = d.valuedObjects[0]?.id ?? '?'
    const used = new Map<string, number>()
    if (d.parameters) assignDeclarations(d.parameters, methodId, used)
    if (d.body) {
        assignDeclarations(d.body.declarations, methodId, used)
        assignStatements(d.body.statements, methodId, used, { n: 0 })
    }
}

function assignStatements(statements: SclStatement[], ownerId: string, used: Map<string, number>, counter: { n: number }) {
    for (const s of statements) {
        if (s.kind === 'block' || s.kind === 'while') {
            assignDeclarations(s.declarations, ownerId, used)
            assignStatements(s.statements, ownerId, used, counter)
        } else if (s.kind === 'if') {
            assignDeclarations(s.declarations, ownerId, used)
            assignStatements(s.statements, ownerId, used, counter)
            if (s.else) {
                assignDeclarations(s.else.declarations, ownerId, used)
                assignStatements(s.else.statements, ownerId, used, counter)
            }
        } else if (s.kind === 'for') {
            if (s.init && s.init.kind === 'declaration') assignDeclarations([s.init], ownerId, used)
            assignDeclarations(s.declarations, ownerId, used)
            assignStatements(s.statements, ownerId, used, counter)
        }
    }
}

function assignEffects(effects: Effect[], ownerId: string) {
    let n = 0
    for (const e of effects) {
        if (e.kind !== 'code') continue
        const blockId = `${ownerId}~${n++}`
        const used = new Map<string, number>()
        if (e.declarations) assignDeclarations(e.declarations, blockId, used)
        if (e.statements) assignStatements(e.statements, blockId, used, { n: 0 })
    }
}

function assignActions(actions: LocalAction[], ownerId: string) {
    const counts = new Map<string, number>()
    for (const a of actions) {
        const n = counts.get(a.kind) ?? 0
        counts.set(a.kind, n + 1)
        a.id = `${ownerId}!${a.kind}${n}`
        assignEffects(a.effects, a.id)
    }
}

function assignState(state: State, id: string) {
    state.id = id
    const declUsed = new Map<string, number>()
    assignDeclarations(state.declarations, id, declUsed)
    assignActions(state.actions, id)

    // Region ids: the name, or the index (also for a repeated name).
    const regionNames = new Set<string>()
    const regionIds = state.regions.map((r, i) => {
        if (r.name !== undefined && r.name !== '' && !regionNames.has(r.name)) {
            regionNames.add(r.name)
            return `${id}:${r.name}`
        }
        return `${id}:${i}`
    })
    // A state name that occurs in more than one region of this parent is qualified by its region.
    const regionsOfName = new Map<string, Set<number>>()
    state.regions.forEach((r, i) => {
        for (const s of r.states) {
            const set = regionsOfName.get(s.name) ?? new Set<number>()
            set.add(i)
            regionsOfName.set(s.name, set)
        }
    })
    state.regions.forEach((r, i) => assignRegion(r, regionIds[i], id, regionsOfName))

    state.transitions.forEach((t, i) => {
        t.priority = i + 1
        t.source = id
        t.id = `${id}->${t.priority}`
        assignEffects(t.effects, t.id)
    })
    for (const p of state.policies ?? []) assignPolicy(p, `${id}:policy.${p.name ?? ''}`)
}

function assignRegion(region: Region, regionId: string, parentId: string, regionsOfName: Map<string, Set<number>>) {
    region.id = regionId
    const used = new Map<string, number>()
    if (region.forLoop) used.set(`${regionId}$${region.forLoop.variable}`, 1)
    assignDeclarations(region.declarations, regionId, used)
    assignActions(region.actions, regionId)
    const stateUsed = new Map<string, number>()
    for (const s of region.states) {
        if (s.name === '') {
            assignState(s, unique(`${regionId}._`, stateUsed))
            continue
        }
        const base = (regionsOfName.get(s.name)?.size ?? 0) > 1 ? `${regionId}.${s.name}` : `${parentId}.${s.name}`
        assignState(s, unique(base, stateUsed))
    }
}

/** Id of a region's for-loop counter variable. */
export function counterId(region: Region): string {
    return `${region.id}$${region.forLoop?.variable ?? ''}`
}
