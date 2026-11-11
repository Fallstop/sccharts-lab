// The C code tab's files (no DOM): the generated `<Chart>.h` and `<Chart>.c` (generateC of @sccharts-lab/engine) with
// a small `main.c` that resets the chart and ticks it in a loop, printing the outputs after each tick, and the one
// command that builds them (gcc as KIELER's simulation calls it). tests/playground/c-code.test.ts builds and runs
// them with gcc.

import type { CVariable, GeneratedC } from '@sccharts-lab/engine'

/** gcc as KIELER's simulation compiles C (kicool's CCompiler: -std=c99 -Wall, -lm). */
export function buildCommand(g: Pick<GeneratedC, 'chart' | 'source'>): string {
    const program = g.chart.replace(/[^\w.-]+/g, '') || 'chart'
    return `gcc -std=c99 -Wall -o ${program} main.c ${g.source} -lm && ./${program}`
}

/** How main.c prints a variable's value, or undefined when it does not (arrays, host types). */
function printf(v: CVariable): { format: string; value: string } | undefined {
    if (v.dims.length) return undefined
    const lvalue = `d.${v.member}`
    if (v.type === 'bool' || v.type === 'int') return { format: '%d', value: lvalue }
    if (v.type === 'float') return { format: '%g', value: lvalue }
    if (v.type === 'string') return { format: '\\"%s\\"', value: `${lvalue} ? ${lvalue} : ""` }
    return undefined
}

/** An input in main.c's comment: its member, and what it takes. */
function inputHint(v: CVariable): string {
    const what = v.dims.length ? `an array of ${v.ctype}` : v.type === 'bool' ? '0 or 1' : v.ctype
    return `d.${v.member}${v.dims.map(() => '[i]').join('')} (${what})`
}

/**
 * A main.c for the generated code: reset, then `ticks` ticks, the outputs printed after each; it stops when the chart
 * terminates. The inputs keep the values reset gives them (a declared initial value, else 0; a string, "") until
 * main.c sets them, as in KIELER's simulation.
 */
export function mainC(g: GeneratedC, ticks = 10): string {
    const { names } = g
    const inputs = g.variables.filter(v => v.input)
    const strings = inputs.filter(v => v.type === 'string' && !v.dims.length)
    const shown = g.variables
        .filter(v => v.output && v.signal !== 'curval')
        .map(v => ({ v, p: printf(v) }))
        .filter((x): x is { v: CVariable; p: { format: string; value: string } } => !!x.p)
    const terminates = /\b_TERM\b/.test(g.files[g.header] ?? '')
    const hints = inputs.map(inputHint)
    const setInputs = !hints.length
        ? []
        : hints.length === 1
          ? [`    /* Set the input of this tick here: ${hints[0]}. */`]
          : ['    /* Set the inputs of this tick here:', ...hints.map(h => `     *   ${h}`), '     */']
    return [
        '/*',
        ` * main.c: runs ${g.chart} for ${ticks} ticks and prints its outputs after each tick.`,
        ' * Build and run it next to the generated files:',
        ' *',
        ` *   ${buildCommand(g)}`,
        ' *',
        ` * The chart's variables are the members of ${names.struct} (${g.header}): set the inputs before a tick,`,
        ` * call ${names.tick}(), then read the outputs. What the chart prints with print(...) appears during the tick.`,
        ' */',
        '#include <stdio.h>',
        '',
        `#include "${g.header}"`,
        '',
        `static ${names.struct} d;`,
        '',
        'int main(void) {',
        ...strings.map(v => `  d.${v.member} = "";`),
        `  ${names.reset}(&d);`,
        `  for (int t = 1; t <= ${ticks}; t++) {`,
        ...setInputs,
        '    printf("tick %d: ", t);',
        `    ${names.tick}(&d);`,
        shown.length
            ? `    printf("\\n  ${shown.map(({ v, p }) => `${v.name} = ${p.format}`).join(', ')}\\n", ${shown.map(({ p }) => p.value).join(', ')});`
            : '    printf("\\n");',
        ...(terminates ? ['    if (d._TERM) {', '      printf("terminated\\n");', '      break;', '    }'] : []),
        '  }',
        '  return 0;',
        '}',
        '',
    ].join('\n')
}

/** What the .zip holds: the header, the C file and main.c. */
export function cProjectFiles(g: GeneratedC): Record<string, string> {
    return { [g.header]: g.files[g.header], [g.source]: g.files[g.source], 'main.c': mainC(g) }
}

/** The interface table's rows: each chart variable, its struct member, C type and direction. */
export function interfaceRows(g: Pick<GeneratedC, 'variables'>): { name: string; member: string; ctype: string; role: string }[] {
    return g.variables.map(v => ({
        name: v.name,
        member: `d->${v.member}`,
        ctype: `${v.ctype}${v.dims.map(n => `[${n}]`).join('')}`,
        role: v.input && v.output ? 'input and output' : v.input ? 'input' : v.output ? 'output' : 'local',
    }))
}
