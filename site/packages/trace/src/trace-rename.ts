/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2026 by
 * + Kiel University
 *   + Department of Computer Science
 *     + Real-Time and Embedded Systems Group
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */

import type { TraceRecord, TraceRole, TraceVariable } from './trace-record'

// Matching variables that two models, or a model and a file, name differently: NS_Green in one
// is nsGreen in the other, or an input was renamed since the sequence was saved.

/** Names of one side to the names they stand for on the other. */
export type Renames = Record<string, string>

/** Two names the user said are one variable, remembered for later matches. */
export type Alias = [string, string]

export interface NamedVariable {
    name: string
    role?: TraceRole
}

export interface RenameSuggestion {
    from: string
    to: string
    /** The user matched these two before, or they differ only in case and separators. */
    reason: 'remembered' | 'spelling'
}

/** Lower case without separators: NS_Green, nsGreen and ns-green are one name. */
export function nameKey(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Inputs pair with inputs and outputs with outputs; a side that does not know the role pairs with any. */
export function sameKind(a: NamedVariable, b: NamedVariable): boolean {
    const kind = (role?: TraceRole) => (role === 'input' ? 'input' : role && 'other')
    return !a.role || !b.role || kind(a.role) === kind(b.role)
}

/** The names on each side that the other side does not have. */
export function unmatched(from: NamedVariable[], to: NamedVariable[]): { from: NamedVariable[]; to: NamedVariable[] } {
    const fromNames = new Set(from.map(({ name }) => name))
    const toNames = new Set(to.map(({ name }) => name))
    return {
        from: from.filter(({ name }) => !toNames.has(name)),
        to: to.filter(({ name }) => !fromNames.has(name)),
    }
}

/** Whether any name left over on one side could stand for one left over on the other. */
export function couldMatch(from: NamedVariable[], to: NamedVariable[]): boolean {
    const left = unmatched(from, to)
    return left.from.some((a) => left.to.some((b) => sameKind(a, b)))
}

/**
 * Pairs the names `from` has and `to` lacks with the names `to` has and `from` lacks: first the
 * pairs in `aliases`, then names that are spelled the same apart from case and separators. A
 * name pairs only when exactly one name on the other side fits it.
 */
export function suggestRenames(from: NamedVariable[], to: NamedVariable[], aliases: Alias[] = []): RenameSuggestion[] {
    const left = unmatched(from, to)
    const suggestions: RenameSuggestion[] = []
    const taken = new Set<string>()
    const pair = (reason: RenameSuggestion['reason'], fits: (a: NamedVariable, b: NamedVariable) => boolean) => {
        left.from.forEach((a) => {
            if (suggestions.some((entry) => entry.from === a.name)) return
            const candidates = left.to.filter((b) => !taken.has(b.name) && sameKind(a, b) && fits(a, b))
            if (candidates.length !== 1) return
            // The other way round must be unique too: two names that both fit one are a guess.
            const rivals = left.from.filter(
                (other) =>
                    !suggestions.some((entry) => entry.from === other.name) &&
                    sameKind(other, candidates[0]) &&
                    fits(other, candidates[0])
            )
            if (rivals.length !== 1) return
            taken.add(candidates[0].name)
            suggestions.push({ from: a.name, to: candidates[0].name, reason })
        })
    }
    const aliased = (a: NamedVariable, b: NamedVariable) =>
        aliases.some(([x, y]) => (x === a.name && y === b.name) || (x === b.name && y === a.name))
    pair('remembered', aliased)
    pair('spelling', (a, b) => nameKey(a.name) === nameKey(b.name))
    return suggestions
}

/** The trace with its variables renamed; names not in `renames` stay. */
export function renameTrace(trace: TraceRecord, renames: Renames): TraceRecord {
    const pairs = Object.entries(renames).filter(([from, to]) => from !== to)
    if (pairs.length === 0) return trace
    const names = new Set(trace.variables.map(({ name }) => name))
    const targets = new Set<string>()
    pairs.forEach(([from, to]) => {
        if (!names.has(from)) throw new Error(`The trace has no variable ${from}.`)
        if (targets.has(to)) throw new Error(`Two variables cannot both become ${to}.`)
        // Into a name that is itself renamed away (a swap) is fine; one that stays (no rename, or to itself) is taken.
        const away = Object.hasOwn(renames, to) && renames[to] !== to
        if (names.has(to) && !away) throw new Error(`The trace has a variable ${to} already.`)
        targets.add(to)
    })
    const rename = (name: string) => (Object.hasOwn(renames, name) ? renames[name] : name)
    return {
        ...trace,
        variables: trace.variables.map((variable): TraceVariable => ({ ...variable, name: rename(variable.name) })),
        ticks: trace.ticks.map((tick) =>
            Object.fromEntries(Object.entries(tick).map(([name, value]) => [rename(name), value]))
        ),
    }
}

/** "`a` as `b`" for each rename, for a report or a note. */
export function describeRenames(renames: Renames): string {
    return Object.entries(renames)
        .map(([from, to]) => `\`${from}\` as \`${to}\``)
        .join(', ')
}

/** The remembered aliases with these pairs added, newest first, at most `limit`. */
export function rememberAliases(aliases: Alias[], renames: Renames, limit = 200): Alias[] {
    const added = Object.entries(renames).filter(([from, to]) => from !== to) as Alias[]
    const same = (a: Alias, b: Alias) => (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0])
    return [...added, ...aliases.filter((alias) => !added.some((entry) => same(entry, alias)))].slice(0, limit)
}

/** The remembered aliases without these pairs, which the user declined. */
export function forgetAliases(aliases: Alias[], declined: Renames): Alias[] {
    return aliases.filter(
        ([a, b]) => !Object.entries(declined).some(([from, to]) => (from === a && to === b) || (from === b && to === a))
    )
}
