// KIELER's validation rules: same severity and KIELER message (in `kieler`) as the official validator, plus the
// engine's own message. Each case's KIELER verdict is also recorded in tests/corpus/probes (see corpus.test.ts).
import { describe, expect, it } from 'vitest'
import { compile } from '../index'
import type { Diagnostic } from '../types'

const c = (body: string, decls = '') => `scchart V {\n${decls ? decls.split('\n').map(l => '  ' + l).join('\n') + '\n' : ''}${body.split('\n').map(l => '  ' + l).join('\n')}\n}\n`
const D = 'input bool a, b\ninput int x\noutput int o\noutput bool z\nsignal S\nsignal int V'

function find(source: string, code: string): Diagnostic {
    const r = compile(source)
    const d = r.diagnostics.find(x => x.code === code)
    expect(d, `${code} in ${JSON.stringify(r.diagnostics.map(x => x.code))}`).toBeDefined()
    return d!
}

describe('validation rules', () => {
    const cases: [string, string, string, 'error' | 'warning' | 'info', string | RegExp][] = [
        ['no initial state', c('state S'), 'no-initial-state', 'error', 'Every region must have an initial state.'],
        ['two initial states', c('initial state S\ninitial state T'), 'multiple-initial-states', 'error', 'Every region must not have more than one initial state.'],
        ['unreachable state', c('initial state S\nstate T'), 'unreachable-state', 'warning', 'The state is not reachable.'],
        ['unreachable transition', c('initial state S\ngo to S\nif a go to S', D), 'unreachable-transition', 'warning', 'The transition is not reachable.'],
        ['termination on a simple state', c('initial state S\njoin to T\nstate T'), 'termination-without-inner-behaviour', 'error', 'A state with a termination transition must have inner behaviour.'],
        ['region without final state', c('initial state S {\n  initial state I\n}\njoin to T\nstate T'), 'missing-final-state', 'warning', 'Every region should have a final state whenever its parent state has a termination transition.'],
        ['regions that cannot terminate', c('region R1:\ninitial state A\ngo to F\nfinal state F\nregion R2:\ninitial state B'), 'regions-cannot-terminate', 'warning', 'All or none concurrent regions should have final states.'],
        ['strong abort after weak', c('initial state S {\n  initial state I\n}\nif a go to T\nif b abort to T\nstate T', D), 'strong-abort-priority', 'error', /^Causality problem!\nStrong abort transitions/],
        ['abort without trigger', c('initial state S {\n  initial state I\n}\ngo to T\nstate T'), 'abort-without-trigger', 'warning', 'Abort transitions should have a trigger.'],
        ['count delay 0', c('initial state S\nif 0 a go to S', D), 'count-delay-zero', 'error', 'A count delay of 0 is not allowed on a trigger.'],
        ['immediate loop', c('initial state S\nimmediate go to T\nstate T\nimmediate go to S'), 'immediate-loop', 'warning', /^There is an immediate loop/],
        ['connector not immediate', c('initial state S\nimmediate go to C\nconnector state C\ngo to S'), 'connector-not-immediate', 'warning', 'Outgoing transitions of connector states should be marked as immediate.'],
        ['connector without default', c('initial state S\nimmediate go to C\nconnector state C\nimmediate if a go to S', D), 'connector-no-default', 'warning', 'Connector states should have an outgoing transition without trigger.'],
        ['connector without transitions', c('initial state S\nimmediate go to C\nconnector state C'), 'connector-no-transition', 'error', 'Connector states must have an outgoing transition.'],
        ['duplicate variable', c('initial state S', 'input bool a\ninput int a'), 'duplicate-variable', 'warning', 'The variable is declared multiple times in this scope.'],
        ['duplicate region', c('region R:\ninitial state A\nregion R:\ninitial state B'), 'duplicate-region', 'warning', "There are multiple regions with the same name. 'R'"],
        ['assignment to a signal', c('initial state S\ndo S = true go to S', D), 'assignment-to-signal', 'error', 'Non-variables cannot be used in an assignment.'],
        ['assignment to a constant', c('initial state S\ndo N = 2 go to S', 'const int N = 1'), 'assignment-to-const', 'error', 'You cannot assign a value to a const object.'],
        ['const without value', c('initial state S', 'const int N'), 'const-without-value', 'error', 'A const declaration must have an initialization part!'],
        ['pure variable', c('initial state S', 'pure p'), 'pure-variable', 'error', 'Pure types are only allowed if used in combination with signals.'],
        ['private input', c('initial state S', 'private input bool p'), 'private-interface', 'error', 'A private declaration cannot be a public input output interface'],
        ['array size from a variable', c('initial state S', 'int n = 3\nint arr[n]'), 'array-size', 'error', 'Array cardinalities must be an int literal or a reference to a constant int object.'],
        ['array with a single initial value', c('initial state S', 'int arr[2] = 0'), 'array-initial-value', 'error', 'Initial value of an array can not be a single value.'],
        ['static without value', c('initial state S', 'static int s'), 'static-without-value', 'warning', 'Static variables should be initialized.'],
        ['min/max combine', c('initial state S', 'signal int s combine max'), 'minmax-combine', 'warning', 'Min or max combine operators are currently not supported.'],
        ['float as a trigger', c('initial state S\nif f go to S', 'input float f'), 'float-trigger', 'error', 'Float tests must have a comparison operator!'],
        ['method without parentheses', c('initial state S\ndo o = m go to S', 'output int o\nmethod int m() { return 1 }'), 'method-without-call', 'error', 'Methods must be used with call syntax using parenthesis.'],
        ['method arguments', c('initial state S\ndo o = m(1) go to S', 'output int o\nmethod int m() { return 1 }'), 'method-arguments', 'error', 'Number of arguments does not match required parameters in definition.'],
        ['duplicate method', c('initial state S', 'method int m() { return 1 }\nmethod int m() { return 2 }'), 'method-signature', 'error', /^Multiple definitions of methods with the same signature \(m#0\)/],
        ['return without type', c('initial state S', 'method m() { return 1 }'), 'return-without-type', 'error', 'Return statement is used but no return type is declared in method signature.'],
        ['return outside a method', c('initial state S\ndo { return 1 } go to S'), 'return-outside-method', 'error', 'Return statements can only be used in method bodies.'],
        ['state access outside a method', c('initial state S\nif state(S) go to S'), 'state-access', 'error', 'State access expressions are only permissible in methods bodies.'],
        ['emitting a variable (unreachable code)', c('initial state S\nstate T\ndo z go to S', D), 'non-signal-emission', 'warning', 'Non-signals should not be used in an emission.'],
        ['emitting a variable (reachable code)', c('initial state S\ndo z go to S', D), 'non-signal-emission', 'error', 'z is an output bool variable, not a signal, so it cannot be emitted.'],
        ['emitting a valued input signal', c('initial state S\ndo W(3) go to S', 'input signal int W'), 'valued-input-emission', 'warning', 'Valued input signals currently do not support emission (overwriting).'],
        ['relative write', c('initial state S\ndo o = o + 1 go to S', D), 'relative-write', 'warning', /^This assignment reads o, so the compiler treats it as an update of o .*\nWrite it as o \+= 1 to say so/s],
        ['extern without call', c('initial state S\ndo o = rnd go to S', 'output int o\nextern "rand" rnd'), 'extern-without-call', 'warning', 'You are using an external reference without call syntax. If you want to generate a call, you must add parentheses.'],
        ['print with a calculation', c('initial state S\ndo print(x + 1) go to S', D), 'print-calculation', 'warning', 'You do a calculation inside a print call effect. You should use printf syntax to be safe on different code generators.'],
        ['float modulo', c('initial state S\ndo f = f % 2.0 go to S', 'float f'), 'float-modulo', 'warning', /^You are using modulo with floats/],
        ['count delay before a unary minus', c('initial state S\nif 3 -x > 0 go to S', D), 'count-delay-unary', 'warning', /^A count delay was recognized in front of an unary operation/],
        ['count delay on during', c('initial state S {\n  during if 3 a\n}', D), 'during-count-delay', 'warning', /^Count Delays on During Actions are not supported yet/],
        ['label hides the trigger', c('initial state S {\n  entry if a label "x"\n}', D), 'label-hides-trigger', 'info', 'The trigger of this action is hidden by the label.'],
        ['layout annotation without option', c('@layout foo\ninitial state S'), 'layout-annotation', 'warning', "Layout annotations must have the format '@layout[id] value'"],
        ['broken import', 'import "nothere"\n' + c('initial state S'), 'broken-import', 'warning', 'Broken Import: There is no SCCharts model with the given name.'],
        ['duplicate chart', c('initial state S') + c('initial state S'), 'duplicate-chart', 'warning', "There are multiple root states with the same name. 'V'"],
        ['for region over a scalar', c('region R for i : N {\n  initial state S\n}', 'const int N = 3'), 'for-range', 'error', /not determinable/],
        ['for region ending at a constant', c('region R for i : 0 to N {\n  initial state S\n}', 'const int N = 3'), 'for-range', 'error', /ends at N, which is not an integer literal/],
        ['struct with a private member', c('initial state S', 'struct P {\n  private int x\n} p'), 'struct-member', 'error', 'All members of a struct must be publicly accessible.'],
        ['class without a variable', c('initial state S', 'class C {\n  int x\n}'), 'class-without-variable', 'warning', 'A class/struct should have at least one variable defined (Type definitions are not supported).'],
        ['whole class assigned', c('initial state S\ndo k = 1 go to S', 'class C {\n  int x\n} k'), 'assignment-to-class', 'error', 'Assignments to class/struct types are not supported. Please specify a member.'],
        ['enum assignment', c('initial state S\ndo e = 1 go to S', 'enum E { A, B }\nref E e = E.A'), 'enum-assignment', 'error', 'Cannot assign enum value of an incompatible type.'],
    ]
    for (const [name, source, code, severity, kieler] of cases) {
        it(name, () => {
            const d = find(source, code)
            expect(d.severity).toBe(severity)
            if (typeof kieler === 'string') expect(d.kieler).toBe(kieler)
            else expect(d.kieler).toMatch(kieler)
            expect(d.message.length).toBeGreaterThan(10)
            expect(d.span).toBeDefined()
        })
    }

    it('accepts what KIELER accepts', () => {
        for (const ok of [
            c('initial state S {\n  entry do o = 1\n  region:\n}', D), // actions with an empty unnamed region count as an initial state
            c('initial state S {\n  int x = 0\n  initial state I\n  do x++ go to I\n}\nif x > 3 go to T\nstate T'), // a transition reads its source state's local
            c('initial state S\nif m go to S', 'method bool m() { return true }'), // method observers in triggers
            c('violation state S\ninitial state T'), // violation states without a #director pragma
            c('region R {\n  region A:\n  initial state X\n  region B:\n  initial state Y\n}'),
        ]) {
            const r = compile(ok)
            expect(r.diagnostics.filter(d => d.severity === 'error'), ok).toEqual([])
        }
    })

    it('rejects a binding that cannot be made, with KIELER’s message', () => {
        const d = find('scchart Main {\n  input bool a\n  initial state R is Sub(a, a)\n}\nscchart Sub {\n  input bool i\n  initial state S\n}', 'binding-error')
        expect(d.kieler).toBe('The referencing binding is erroneous!\nA Valued Object is supposed to be bound, but there is no free Valued Object left in the referenced scope: a')
    })

    it('warns about the conditional grouping trap (engine only)', () => {
        const d = find(c('initial state S\ndo o = x > 0 ? 1 : 2 go to S', D), 'ternary-grouping')
        expect(d.severity).toBe('warning')
        expect(d.kieler).toBeUndefined()
        expect(d.message).toBe('KIELER reads this as `x > (0 ? 1 : 2)`')
    })

    it('marks the related elements', () => {
        const d = find(c('initial state S\ninitial state T'), 'multiple-initial-states')
        expect(d.related).toEqual(['V:0', 'V.S', 'V.T'])
    })
})
