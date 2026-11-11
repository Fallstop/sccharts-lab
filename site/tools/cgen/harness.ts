// The test environment for generated C code: a main.c that does what KIELER's simulation does around the
// generated functions (simulation/processor/CSimulationTemplateGenerator.xtend): one zeroed global TickData, reset()
// once, then per tick: write the inputs the scenario gives (the struct keeps the others: inputs persist), call
// tick(), report the data pool as JSON. Like KIELER's environment, string inputs are fresh pointers every tick.
// Output: for tick n, `@@BEGIN n` and `@@END n <json>` lines around what the chart printed (printf, no newline).

import type { CVariable, GeneratedC, PoolValue } from '@sccharts-lab/engine'
import type { Value } from '@sccharts-lab/engine/types'

const INT_MAX = 2147483647
const INT_MIN = -2147483648

const cString = (s: string) => JSON.stringify(s).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => `\\x${h}""`)

/** cJSON's valueint: saturating. */
function jsonInt(n: number): number {
    if (n >= INT_MAX) return INT_MAX
    if (n <= INT_MIN) return INT_MIN
    return Math.trunc(n) | 0
}

const toChar = (x: number) => (x << 24) >> 24

function floatText(v: number): string {
    if (!Number.isFinite(v)) return Number.isNaN(v) ? '(0.0/0.0)' : v > 0 ? '(1.0/0.0)' : '(-1.0/0.0)'
    const s = String(v)
    return /[.eE]/.test(s) ? s : `${s}.0`
}

/** The C value an input gets from a JSON value (sim/exec.ts fromInput: KIELER's cJSON conversions). */
function inputValue(value: Value, v: CVariable): string | undefined {
    switch (v.type) {
        case 'string': return typeof value === 'string' ? `sdup(${cString(value)})` : 'NULL'
        case 'float': return floatText(typeof value === 'number' ? value : value === true ? 1 : 0)
        case 'bool': return String(typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? toChar(jsonInt(value)) : 0)
        case 'int': return String(typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? jsonInt(value) : 0)
        default: return undefined
    }
}

/** Assignments of one input value (element-wise for arrays, as exec.ts applies them). */
function assign(target: string, value: Value, v: CVariable, dims: number[], out: string[]) {
    if (Array.isArray(value)) {
        if (!dims.length) return
        value.forEach((x, i) => { if (i < dims[0]) assign(`${target}[${i}]`, x as Value, v, dims.slice(1), out) })
        return
    }
    if (dims.length) return
    const c = inputValue(value, v)
    if (c !== undefined) out.push(`${target} = ${c};`)
}

/** The statements that apply one tick's inputs (sim/exec.ts applyInputs). */
export function inputCode(gen: GeneratedC, given: Record<string, Value>): string[] {
    const out: string[] = []
    for (const v of gen.variables) {
        if (!v.input || v.pool === undefined) continue
        const member = `d.${v.member}`
        let value: Value | undefined = given[v.name]
        if (v.signal === 'value') {
            const signal = v.name.replace(/_val$/, '')
            const raw = given[signal]
            value = given[v.name] ?? (raw !== undefined && typeof raw !== 'boolean' ? raw : undefined)
        } else if (v.signal === 'presence') {
            const g = given[v.name]
            value = typeof g === 'boolean' ? g : g === undefined || g === null ? undefined : true
        }
        if (value !== undefined) assign(member, value, v, v.dims, out)
        else if (v.type === 'string') out.push(...refresh(member, v.dims))
    }
    return out
}

/** A string input the environment does not change still arrives as a new pointer (KIELER parses it again). */
function refresh(target: string, dims: number[]): string[] {
    if (!dims.length) return [`if (${target}) ${target} = sdup(${target});`]
    const loops = dims.map((n, k) => `for (int i${k} = 0; i${k} < ${n}; i${k}++) `).join('')
    const element = target + dims.map((_, k) => `[i${k}]`).join('')
    return [`${loops}if (${element}) ${element} = sdup(${element});`]
}

/** The C code that prints one pool value as JSON. */
function printValue(access: string, v: CVariable, dims: number[], k: number): string[] {
    if (dims.length) {
        const i = `i${k}`
        return [`putchar('['); for (int ${i} = 0; ${i} < ${dims[0]}; ${i}++) { if (${i}) putchar(',');`,
            ...printValue(`${access}[${i}]`, v, dims.slice(1), k + 1), `} putchar(']');`]
    }
    switch (v.type) {
        case 'bool': return [`fputs(${access} ? "true" : "false", stdout);`]
        case 'int': return [`printf("%d", ${access});`]
        case 'float': return [`pdouble(${access});`]
        // An array element that is NULL is reported as "" (KIELER's cJSON_CreateString of an empty string).
        case 'string': return [k ? `pstring(${access} ? ${access} : "");` : `pstring(${access});`]
        default: return ['fputs("null", stdout);']
    }
}

/** main.c: reset, then per tick the inputs, tick(), the pool. `taken`: print the cumulative counters too. */
export function harness(gen: GeneratedC, ticks: Record<string, Value>[]): string {
    const S = gen.names.struct
    const lines: string[] = [
        '#include <stdio.h>', '#include <stdlib.h>', '#include <string.h>', `#include "${gen.header}"`, '',
        `static ${S} d;`, '',
        '/* A fresh copy of a string (C99 has no strdup). */',
        'static char* sdup(const char* s) {',
        '  char* p = malloc(strlen(s) + 1);',
        '  strcpy(p, s);',
        '  return p;',
        '}', '',
        'static void pstring(const char* s) {',
        '  if (!s) { fputs("null", stdout); return; }',
        '  putchar(\'"\');',
        '  for (const unsigned char* p = (const unsigned char*) s; *p; p++) {',
        '    if (*p == \'"\' || *p == \'\\\\\') { putchar(\'\\\\\'); putchar(*p); }',
        '    else if (*p < 0x20) printf("\\\\u%04x", *p);',
        '    else putchar(*p);',
        '  }',
        '  putchar(\'"\');',
        '}', '',
        'static void pdouble(double x) {',
        '  if (x != x) fputs("\\"NaN\\"", stdout);',
        '  else if (x > 1.7976931348623157e308) fputs("\\"Infinity\\"", stdout);',
        '  else if (x < -1.7976931348623157e308) fputs("\\"-Infinity\\"", stdout);',
        '  else printf("%.17g", x);',
        '}', '',
        'static void pool(void) {',
        '  int first = 1;',
        '  putchar(\'{\');',
    ]
    // Instances: one object each, with their members.
    const objects = new Map<string, CVariable[]>()
    for (const v of gen.variables) {
        if (v.pool === undefined || v.type === 'host') continue
        if (v.poolObject) {
            const list = objects.get(v.poolObject) ?? []
            list.push(v)
            objects.set(v.poolObject, list)
            continue
        }
        const access = `d.${v.member}`
        const body = printValue(access, v, v.dims, 0)
        // A NULL string is not in KIELER's data pool.
        const skip = v.type === 'string' && !v.dims.length ? `if (${access}) ` : ''
        lines.push(`  ${skip}{ if (!first) putchar(','); first = 0; fputs(${cString(JSON.stringify(v.pool) + ':')}, stdout); ${body.join(' ')} }`)
    }
    for (const [name, members] of objects) {
        lines.push(`  { if (!first) putchar(','); first = 0; fputs(${cString(JSON.stringify(name) + ':{')}, stdout);`)
        members.forEach((m, i) => lines.push(`    ${i ? 'putchar(\',\'); ' : ''}fputs(${cString(JSON.stringify(m.pool) + ':')}, stdout); ${printValue(`d.${m.member}`, m, m.dims, 0).join(' ')}`))
        lines.push('    putchar(\'}\'); }')
    }
    if (gen.takenTransitions) {
        const n = Math.max(1, gen.takenTransitions.length)
        lines.push(`  if (!first) { putchar(','); } first = 0; fputs("\\"#taken\\":[", stdout); for (int i = 0; i < ${n}; i++) { printf(i ? ",%d" : "%d", d._taken_transitions[i]); } putchar(']');`)
    }
    lines.push('  if (!first) { putchar(\',\'); } printf("\\"#term\\":%d", d._TERM ? 1 : 0);', '  putchar(\'}\');', '}', '')
    lines.push('int main(void) {', '  setvbuf(stdout, NULL, _IONBF, 0);', `  ${gen.names.reset}(&d);`)
    ticks.forEach((given, i) => {
        lines.push(`  /* tick ${i + 1} */`)
        for (const s of inputCode(gen, given)) lines.push(`  ${s}`)
        lines.push(`  printf("\\n@@BEGIN ${i + 1}\\n");`, `  ${gen.names.tick}(&d);`, `  printf("\\n@@END ${i + 1} ");`, '  pool();', '  putchar(\'\\n\');')
    })
    lines.push('  return 0;', '}', '')
    return lines.join('\n')
}

export interface HarnessTick {
    tick: number
    printed: string
    pool: Record<string, PoolValue>
    taken?: number[]
    terminated: boolean
}

/** Reads the harness's output: the ticks that finished, and whether the program died in the tick after them. */
export function parseOutput(stdout: string): { ticks: HarnessTick[]; diedIn?: number } {
    const ticks: HarnessTick[] = []
    const re = /\n@@BEGIN (\d+)\n([\s\S]*?)\n@@END \1 (.*)\n/g
    let m: RegExpExecArray | null
    let last = 0
    let previous: number[] | undefined
    while ((m = re.exec(stdout))) {
        const json = JSON.parse(m[3]) as Record<string, PoolValue>
        const total = json['#taken'] as number[] | undefined
        delete json['#taken']
        const term = json['#term'] === 1
        delete json['#term']
        ticks.push({ tick: Number(m[1]), printed: m[2], pool: json, terminated: term, taken: total?.map((t, i) => t - (previous?.[i] ?? 0)) })
        previous = total
        last = re.lastIndex
    }
    const rest = stdout.slice(last)
    const begun = /\n@@BEGIN (\d+)\n/.exec(rest)
    return { ticks, diedIn: begun ? Number(begun[1]) : undefined }
}
