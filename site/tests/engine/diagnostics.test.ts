// What the simulator says when KIELER rejects a chart (or warns about one): the code, a message that names the
// variable and the accesses, a hint, the related element ids for the diagram, and KIELER's own words.
import { describe, expect, it } from 'vitest'
import { compile, createSimulation } from '../../src/engine/index'
import type { Diagnostic } from '../../src/engine/types'

function errors(source: string): Diagnostic[] {
    return compile(source).diagnostics.filter(d => d.severity === 'error')
}

describe('causality', () => {
    it('two regions writing different values: names the variable and both writers', () => {
        const [d] = errors(`scchart W {
  input bool a
  output int x
  region R1 {
    initial state A
    if a do x = 1 go to A
  }
  region R2 {
    initial state A
    if !a do x = 2 go to A
  }
}`)
        expect(d.code).toBe('write-conflict')
        expect(d.message).toBe('Two concurrent regions assign different values to `x`')
        expect(d.kieler).toBe('The SCG is NOT asc-schedulable!')
        expect(d.related).toEqual(expect.arrayContaining(['W:R1.A->1', 'W:R2.A->1']))
        expect(d.span?.line).toBe(6)
        expect(d.hint).toContain('x +=')
    })

    it('accepts confluent writes and commuting updates', () => {
        expect(errors(`scchart C {
  input bool a
  output int x, y
  region { initial state A if a do x = 3; y += 1 go to A }
  region { initial state B if a do x = 3; y += 2 go to B }
}`)).toEqual([])
    })

    it('a read/write cycle: says which accesses wait for each other', () => {
        const [d] = errors(`scchart RW {
  output bool x, y
  region R1 {
    initial state A
    immediate if !y do x = true go to B
    state B
  }
  region R2 {
    initial state A
    immediate if !x do y = true go to B
    state B
  }
}`)
        expect(d.code).toBe('causality-cycle')
        expect(d.message).toContain('`x` and `y` depend on each other')
        expect(d.hint).toMatch(/`x` is set on line \d+ and read on line \d+/)
        expect(d.hint).toContain('pre(')
    })

    it('val(V) feeding an emission of V', () => {
        const [d] = errors(`scchart V {
  output signal int V
  initial state X
  do V(val(V) + 1) go to X
}`)
        expect(d.code).toBe('val-cycle')
        expect(d.message).toContain('val(V)')
        expect(d.hint).toContain('pre(val(V))')
    })
})

describe('instantaneous loops', () => {
    it('names the loop and asks for a delayed transition', () => {
        const [d] = errors(`scchart L {
  input bool I
  initial state A
  immediate if I go to B
  state B
  immediate if !I go to A
}`)
        expect(d.code).toBe('instantaneous-loop')
        expect(d.message).toContain('`A` → `B` → `A`')
        expect(d.related).toEqual(expect.arrayContaining(['L.A->1', 'L.B->1']))
        expect(d.hint).toContain('delayed')
    })

    it('accepts a loop with one delayed transition', () => {
        expect(errors(`scchart L {
  initial state A
  immediate go to B
  state B
  go to A
}`)).toEqual([])
    })
})

describe('what gcc rejects in KIELER\'s C code', () => {
    it.each([
        ['>>>', 'output int u\n  initial state S\n  do u = 8 >>> 2 go to S', 'unsigned-shift', 'expected expression before ‘>’ token'],
        ['string +', 'output string t = "a"\n  initial state S\n  do t = t + "b" go to S', 'string-arithmetic', 'invalid operands to binary +'],
        ['array copy', 'output int a[2], b[2]\n  initial state S\n  do b = a go to S', 'array-assignment', 'assignment to expression with array type'],
        ['C keyword', 'output int default\n  initial state S\n  do default++ go to S', 'c-keyword', 'expected identifier or ‘(’ before ‘default’'],
        ['duplicate', 'output int x\n  int x\n  initial state S', 'duplicate-declaration', 'duplicate member ‘x’'],
    ])('%s', (_, body, code, kieler) => {
        const list = errors(`scchart G {\n  ${body}\n}`)
        expect(list.map(d => d.code)).toContain(code)
        expect(list.find(d => d.code === code)?.kieler).toContain(kieler)
    })
})

describe('KIELER quirks are explained, not hidden', () => {
    it('a chart with signals never reports termination (K-2)', () => {
        const r = compile(`scchart Q {
  output signal S
  initial state A
  do S go to B
  final state B
}`)
        expect(r.ok).toBe(true)
        expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: 'info', code: 'kieler-quirk' }))
        const s = createSimulation(r)
        for (let i = 0; i < 4; i++) expect(s.step({}).terminatedNow).toBe(false)
    })

    it('the instantaneous-loop warning KIELER gives for weak-abort self-loops is info only', () => {
        const r = compile(`scchart Reset {
  input bool r
  output int n
  initial state S {
    initial state A
    do n++ go to A
  }
  if r go to S
}`)
        expect(r.ok).toBe(true)
        const d = r.diagnostics.find(x => x.code === 'kieler-loop-warning')
        expect(d?.severity).toBe('info')
        expect(d?.kieler).toBe('Instantaneous loop detected!')
        // It points at the superstate that is left and entered again.
        expect(d?.related).toEqual(['Reset.S'])
        expect(d?.span?.line).toBe(4)
    })

    it('a chart KIELER accepts in some runs and rejects in others is rejected, with the reason', () => {
        // Two superstates in an instantaneous loop both need KIELER's schizophrenia cure; KIELER cures them in the
        // order of a hash map, and only curing B first works (measured: 7 of 10 runs accept).
        const r = compile(`scchart Chance {
  input int n
  output int x = 0
  output signal S, T
  output signal int V combine *
  region R0 {
    initial state P {
      region {
        initial state A {
          region {
            initial state A0
          }
        }
          if n > 1 do x += 1; T go to B
          do S join to A
        state B {
          region {
            initial state B0
          }
        }
          abort to B
          immediate if n > 1 do V(1); V(n) go to C
        state C
      }
    }
  }
}`)
        expect(r.ok).toBe(false)
        const d = r.diagnostics.find(x => x.code === 'kieler-nondeterministic')
        expect(d?.severity).toBe('error')
        expect(d?.message).toBe('KIELER\'s compiler accepts this chart in some runs and rejects it in others')
        expect(d?.related).toEqual(expect.arrayContaining(['Chance.P.A', 'Chance.P.B']))
        expect(d?.hint).toContain('`A` and `B`')
        expect(d?.span).toBeDefined()
    })

    it('the choice that decides can come late in KIELER\'s chain of cures', () => {
        // Six superstates are cured one after the other; the order of the later ones decides (measured: KIELER accepts
        // in 9 of 12 runs, the guide's default order is one that fails).
        const r = compile(`scchart F9 {
  input bool a, b, c, d
  input int n
  output int x = 0, y = 0, z = 0
  output signal S
  region R0 {
    initial state R0s0
      if 2 d go to R0s0
      do y += 1 go to R0s3
    state R0s1
    state R0s2
    state R0s3 {
      region {
        initial state R0s3r0s0 {
          immediate weak suspend if a
        }
          if c abort to R0s3r0s1
        final state R0s3r0s1
          immediate if b go to R0s3r0s0
      }
      region {
        initial state R0s3r1s0 {
          region {
            initial state R0s3r1s0r0s0
              immediate if pre(a) go to R0s3r1s0r0s2 deferred
              go to R0s3r1s0r0s0
            state R0s3r1s0r0s1
              if 3 !a go to R0s3r1s0r0s1
            state R0s3r1s0r0s2 {
              exit do S; x += 1
            }
              if d go to R0s3r1s0r0s0 deferred
              if pre(a) go to R0s3r1s0r0s1
          }
          region {
            initial state R0s3r1s0r1s0
              if 2 a && !b go to R0s3r1s0r1s0
          }
        }
          if n > 1 abort to R0s3r1s0
        final state R0s3r1s2
      }
    }
      immediate if a && !b do y += 1 join to R0s2
      immediate if 3 c do S go to R0s3
  }
}`)
        expect(r.ok).toBe(false)
        expect(r.diagnostics.find(x => x.code === 'kieler-nondeterministic')?.severity).toBe('error')
    })

    it('a chart whose behaviour (not its verdict) depends on KIELER\'s order of cures gets an info', () => {
        // KIELER, four runs: the immediate transition fires in tick 2 in two of them; in the other two the region
        // stops for good.
        const r = compile(`scchart CureLostAfterReentry {
  input bool c
  output int z = 0
  region R0 {
    initial state A {
      during do z += 0
    }
    go to B
    state B {
      during do z += 0
    }
    immediate if c go to A
    go to A
  }
}`)
        expect(r.ok).toBe(true)
        const d = r.diagnostics.find(x => x.code === 'kieler-quirk' && /differently from one compilation to the next/.test(x.message))
        expect(d?.severity).toBe('info')
        expect(d?.related).toEqual(['CureLostAfterReentry.A', 'CureLostAfterReentry.B'])
        expect(d?.span).toBeDefined()
    })

    it('randomize() without random(): gcc fails in KIELER (no <stdlib.h>)', () => {
        const chart = (pragma: string, extra: string) => `${pragma}
scchart R {
  input bool A
  output float r = 0
  initial state S
  if A do randomize()${extra} go to T
  state T
}`
        const d = compile(chart('', '')).diagnostics.find(x => x.code === 'randomize-stdlib')
        expect(d?.severity).toBe('error')
        expect(d?.kieler).toMatch(/^implicit declaration of function ‘srand’/)
        expect(d?.span?.line).toBe(6)
        expect(compile(chart('', '; r = random()')).ok).toBe(true)
        expect(compile(chart('#hostcode "#include <stdlib.h>"', '')).ok).toBe(true)
    })

    it('a state with abort regions in an instantaneous loop is rejected (sequential forks must not be schizophrenic)', () => {
        const r = compile(`scchart L {
  input bool a
  output int x = 0
  initial state M {
    region {
      initial state I
      immediate if a go to F
      final state F
    }
    abort region W {
      initial state V
      if a go to G
      final state G
    }
  }
  join to M
}`)
        expect(r.ok).toBe(false)
        const d = r.diagnostics.find(x => x.code === 'abort-region-loop')
        expect(d?.kieler).toBe('Sequential forks must not be schizophrenic!')
        expect(d?.related).toEqual(['L.M'])
    })

    it('pre(...) as the whole trigger of a state action: compiled, with a warning that KIELER fails on it', () => {
        const r = compile(`scchart PreTrigger {
  input bool a
  output int x = 0
  initial state A {
    entry if pre(a) do x = 1
    initial state I
  }
}`)
        expect(r.ok).toBe(true)
        const d = r.diagnostics.find(x => x.code === 'kieler-divergence')
        expect(d?.severity).toBe('warning')
        expect(d?.message).toBe('The official KIELER compiler fails on `pre(a)` used directly as the trigger of an entry action')
        expect(d?.hint).toContain('if pre(a) == true')
        expect(d?.span?.line).toBe(5)
    })

    it('pre(...) where KIELER cannot replace it is rejected, located', () => {
        const r = compile(`scchart PrePrint {
  input int n
  initial state A
    do print(pre(n)) go to A
}`)
        expect(r.ok).toBe(false)
        const d = r.diagnostics.find(x => x.code === 'pre-placement')
        expect(d?.message).toBe('`pre(n)` cannot be passed directly as an argument of print(...)')
        expect(d?.kieler).toBe('Pre expressions are only supported in assignments, triggers and other pre expressions')
        expect(d?.span?.line).toBe(4)
    })

    it('a referenced chart\'s region that starts in a state without code: KIELER\'s dependency analysis stops there', () => {
        const ref = `scchart C {
  input bool p
  output int o = 0
  initial state Wait
  go to Busy
  state Busy {
    region {
      initial state Spin
      immediate go to Spin
    }
  }
  go to Wait
}`
        const r = compile(`scchart Stop {
  input bool a, b
  output int y = 0, z = 0
  output signal S
  region Read {
    initial state Count
    if S do y += 1 go to Count
  }
  region Write {
    initial state Emit
    if a do S go to Emit
  }
  region Ref {
    initial state I is C(b, z)
  }
}
${ref}`)
        expect(r.ok).toBe(true)
        const d = r.diagnostics.find(x => x.message.includes('dependency analysis stops'))
        expect(d?.code).toBe('kieler-quirk')
        expect(d?.severity).toBe('warning')
        expect(d?.message).toBe('KIELER\'s dependency analysis stops at the referenced chart\'s state `Spin`, so its compiled code leaves the accesses to `S` in concurrent regions unordered: a read may come before a write in another region and see the value from before it')
        // As KIELER: Count tests S before Write emits it, so it never counts.
        const sim = createSimulation(r)
        sim.step({ a: false, b: false })
        expect(sim.step({ a: true, b: false }).pool.y).toBe(0)
        expect(sim.step({ a: true, b: false }).pool.y).toBe(0)
        // With the referenced chart's region first, the analysis reaches everything before it stops.
        const first = compile(`scchart First {
  input bool a, b
  output int y = 0, z = 0
  output signal S
  region Ref {
    initial state I is C(b, z)
  }
  region Write {
    initial state Emit
    if a do S go to Emit
  }
  region Read {
    initial state Count
    if S do y += 1 go to Count
  }
}
${ref}`)
        expect(first.diagnostics.some(x => x.message.includes('dependency analysis stops'))).toBe(false)
    })

    it('a transition into a referenced chart\'s state without code: KIELER\'s dependency analysis crashes', () => {
        const r = compile(`scchart Crash {
  input bool b
  output int z = 0
  region Ref {
    initial state I is C(b, z)
  }
}
scchart C {
  input bool p
  output int o = 0
  initial state Wait
  go to Spin
  state Spin
  immediate go to Spin
}`)
        expect(r.ok).toBe(false)
        const d = r.diagnostics.find(x => x.code === 'kieler-crash')
        expect(d?.message).toBe('KIELER\'s compiler crashes on this chart: a transition leads into the referenced chart\'s state `Spin`, which has no code')
        expect(d?.kieler).toContain('NullPointerException')
        expect(d?.span).toBeDefined()
    })

    it('every simulator diagnostic has a place in the source', () => {
        const r = compile(`scchart Crash {
  input bool a
  output bool done
  initial state S {
    initial state W
      if a go to X
    state X
  }
  join to D
  state D {
    entry do done = true
  }
}`)
        const d = r.diagnostics.find(x => x.code === 'kieler-crash')
        expect(d?.span?.line).toBe(4)
    })
})

describe('constructs the simulator cannot run', () => {
    it('reports them as info and refuses to simulate', () => {
        const r = compile(`scchart H {
  output int x = 0
  initial state S
  do \`d->x = 42;\` go to S
}`)
        expect(r.ok).toBe(true)
        const d = r.diagnostics.find(x => x.code === 'unsupported')
        expect(d?.severity).toBe('info')
        expect(d?.message).toContain('cannot run in the browser')
        const t = createSimulation(r).step({ a: false })
        expect(t.error?.code).toBe('unsupported')
    })
})

describe('syntax hints', () => {
    it('a float literal without a decimal point before its exponent (1e3)', () => {
        const [d] = errors('scchart F {\n  output float x = 1e3\n  initial state A\n}')
        expect(d.message).toBe('1e3 is not a number in SCTX')
        expect(d.hint).toBe('A float exponent needs a decimal point: write `1.0e3`, not `1e3`.')
        expect(d.kieler).toBe("no viable alternative at input 'e3'")
    })
    it('a region-level declaration keeps the name the reader wrote in messages', () => {
        const ds = errors(`scchart Shared {
  input bool a
  output int y
  initial state S {
    region for i : 0 to 1 {
      int k = 0
      initial state W
      if a do k = i go to W
    }
  }
}`)
        expect(ds.some(d => /\bk\b/.test(d.message) && /for-region/.test(d.message))).toBe(true)
        expect(ds.every(d => !d.message.includes('_region'))).toBe(true)
    })
})

describe('scheduling cycles from preemption, periods and for-regions', () => {
    it('an abort whose trigger is written inside the state (with a count delay there: KIELER rejects it)', () => {
        const ds = errors(`scchart W {
  input bool beat
  output signal expired
  initial state Running {
    region { initial state Watching if 3 true do expired go to Done final state Done }
    region { initial state Idle if beat go to Idle }
  }
  if expired abort to Safe
  state Safe
}`)
        const d = ds.find(x => x.severity === 'error')!
        expect(d.code).toBe('abort-trigger-cycle')
        expect(d.message).toBe('The strong abort from `Running` to `Safe` reads `expired`, which is emitted inside `Running` in the same tick, and KIELER cannot put the two in an order')
        expect(d.hint).toContain('`pre(expired)`')
        expect(d.kieler).toBe('The SCG is NOT asc-schedulable!')
        // The quirk about strong aborts that KIELER accepts does not apply to a rejected chart.
        expect(ds.some(x => x.code === 'kieler-quirk' && /strong abort reads/.test(x.message))).toBe(false)
    })

    it('a strong abort out of a state with its own suspend', () => {
        const [d] = errors(`scchart C {
  input bool doorOpen, cancel
  output int remaining = 5
  initial state Cooking {
    suspend if doorOpen
    initial state Heating
      if remaining > 0 do remaining-- go to Heating
  }
  if cancel abort to Idle
  state Idle
}`).filter(x => x.severity === 'error')
        expect(d.code).toBe('suspend-abort-cycle')
        expect(d.message).toBe("The strong abort out of `Cooking` and `Cooking`'s own suspend depend on each other within the tick")
        expect(d.hint).toContain('Move the abort to a state around `Cooking`')
        expect(d.message + d.hint).not.toMatch(/_enabled|is not suspended/)
    })

    it('a weak abort out of a state with a period', () => {
        const [d] = errors(`scchart P {
  input bool stop
  output int samples = 0
  initial state Run {
    period 500
    initial state Measure
      do samples++ go to Measure
  }
  if stop go to Stopped
  state Stopped
}`).filter(x => x.severity === 'error')
        expect(d.code).toBe('period-abort-cycle')
        expect(d.message).toBe("`Run`'s period and the transitions out of `Run` depend on each other within the tick")
        expect(d.span?.line).toBe(5)
    })

    it('copies of a for-region writing its declaration', () => {
        const [d] = errors(`scchart F {
  output int sum = 0
  region for i : 1 to 3 {
    int k = 0
    initial state W
      immediate do k = i; sum += k go to D
    final state D
  }
}`).filter(x => x.severity === 'error')
        expect(d.code).toBe('write-conflict')
        expect(d.message).toBe('The copies of the for-region assign different values to `k`, which they share')
        expect(d.message + d.hint).not.toMatch(/_region|null_/)
    })
})

describe('this round: dedicated messages, places and names', () => {
    it('a count delay inside a state with a self-loop (preemption.md P-36a) gets its own code and the way out', () => {
        const [d] = errors(`scchart KnockAgain {
  input bool knock, restart
  output signal unlock
  initial state Door {
    initial state Shut
      if 3 knock do unlock go to Open
    state Open
  }
  if restart abort to Door
}`)
        expect(d.code).toBe('count-delay-reset')
        expect(d.message).toBe('KIELER cannot compile the count delay `if 3 knock` on `Shut`\'s transition to `Open`: `Door`, around it, has the self-loop `if restart abort to Door`')
        expect(d.kieler).toBe('The SCG is NOT asc-schedulable!')
        expect(d.hint).toContain('`during if knock do count++`')
        expect(d.related?.slice(0, 3)).toEqual(['KnockAgain.Door.Shut->1', 'KnockAgain.Door->1', 'KnockAgain.Door'])
        expect(d.span?.line).toBe(6)
    })

    it('a clock read by two regions is reported at the second region\'s timeout', () => {
        const r = compile(`scchart TwoClocks {
  output bool tea = false, egg = false
  clock t
  region {
    initial state Steeping
      if t >= 3000 do tea = true go to Ready
    state Ready
  }
  region {
    initial state Boiling
      if t >= 5000 do egg = true go to Ready
    state Ready
  }
}`)
        const d = r.diagnostics.find(x => x.code === 'shared-clock')!
        expect(d.span?.line).toBe(11)
        expect(d.related).toEqual(expect.arrayContaining(['TwoClocks.Steeping->1', 'TwoClocks.Boiling->1', 'TwoClocks$t']))
    })

    it('an unknown target names the state it leaves (related) and offers the near name (suggestion)', () => {
        const d = compile(`scchart Lamp2 {
  input bool press
  initial state Off
    if press go to On
  state On
    if press go to Of
}`).diagnostics.find(x => x.code === 'unknown-state')!
        expect(d.related).toEqual(['Lamp2.On', 'Lamp2.On->1'])
        expect(d.suggestion).toBe('Off')
        expect(d.message).toBe('There is no state `Of` here (did you mean `Off`?)')
        const v = compile('scchart U2 {\n  input bool press\n  initial state S\n    if pres go to S\n}').diagnostics.find(x => x.code === 'unknown-variable')!
        expect(v.suggestion).toBe('press')
    })

    it('names a gcc cannot take: a prime or a kept caret (probes rare/probe-prime-*, rare/probe-caret-*)', () => {
        const [p] = errors("scchart P1 {\n  input bool A\n  output int x' = 0\n  initial state S\n    if A do x' += 1 go to S\n}")
        expect(p.code).toBe('c-name')
        expect(p.kieler?.split('\n')[0]).toBe("missing terminating ' character")
        const [c] = errors('scchart C1 {\n  input bool A\n  output int ^max = 0\n  initial state S\n    if A do ^max++ go to S\n}')
        expect(c.code).toBe('c-name')
        expect(c.kieler?.split('\n')[0]).toBe('expected identifier or ‘(’ before ‘^’ token')
        expect(c.hint).not.toMatch(/`\^[a-z]/) // never suggests a ^name
        // States, regions and constants keep such names without harm.
        expect(compile("scchart C2 {\n  input bool A\n  const int N' = 2\n  output int o = 0\n  region ^go {\n    initial state ^state\n      if A do o = N' go to ^state\n  }\n}").ok).toBe(true)
    })

    it('C text KIELER writes as it is: line breaks and quotes in strings, % on floats, a `d` in a C function (S-72)', () => {
        const chart = (body: string, decls = 'input bool A\n  output string s') => `scchart X {\n  ${decls}\n  initial state S\n    ${body}\n  state T\n}`
        const [nl] = errors(chart('if A do s = "a\\nb" go to T'))
        expect([nl.code, nl.kieler?.split('\n')[0]]).toEqual(['c-string', 'missing terminating " character'])
        expect(errors(chart('if A do s = "a\\"b" go to T'))[0].code).toBe('c-string')
        // A balanced pair of quotes still splits the C literal; gcc's message then depends on what follows.
        const [q] = errors(chart('if A do s = "\\"x\\"" go to T'))
        expect([q.code, q.kieler]).toEqual(['c-string', 'Compiler did not return success (exit value != 0)'])
        expect(errors(chart('if A do print("a\\n") go to T'))[0].code).toBe('c-string')
        expect(compile(chart('if A do s = "a\\tb" go to T')).ok).toBe(true)
        const [m] = errors(chart('do r = F % 2 go to T', 'input float F\n  output int r'))
        expect([m.code, m.kieler?.split('\n')[0]]).toEqual(['c-float-modulo', 'invalid operands to binary % (have ‘double’ and ‘int’)'])
        expect(errors(chart('if A do r %= 2.0 go to S', 'input bool A\n  output float r = 7.5'))[0].code).toBe('c-float-modulo')
        expect(compile(chart('do r = I % 2 go to T', 'input int I\n  output int r')).ok).toBe(true)
        const method = (sig: string, body: string) => `scchart M {\n  output int r = 0\n  method int f(${sig}) {\n${body}\n  }\n  initial state S\n    do r = f(${sig ? '3' : ''}) go to S\n}`
        const [p] = errors(method('int d', '    int s = 0\n    for (int i = 0; i < 2; i++) {\n      s += d\n    }\n    return s'))
        expect([p.code, p.kieler?.split('\n')[0]]).toEqual(['c-name', 'conflicting types for ‘d’; have ‘int’'])
        // Inlined, the parameter gets a prefix; a loop counter `d` is scoped to its loop.
        expect(compile(method('int d', '    return d * 2')).ok).toBe(true)
        expect(compile(method('', '    int s = 0\n    for (int d = 0; d < 3; d++) {\n      s += 2\n    }\n    return s')).ok).toBe(true)
        const [l] = errors('scchart L {\n  output int r = 0\n  initial state S\n    do {\n      int d = 2\n      for (int i = 0; i < 2; i++) {\n        r += d\n      }\n    } go to S\n}')
        expect([l.code, l.kieler?.split('\n')[0]]).toEqual(['c-name', '‘d’ redeclared as different kind of symbol'])
        // An extern function named without a call, also in a chart with host code (probe rare/probe-extern-without-call).
        const ext = compile('#hostcode "#include <stdlib.h>"\nscchart E {\n  input int x\n  output int distance = 0\n  extern "abs" absolute\n  initial state Run\n    do distance = absolute go to Run\n}')
        expect(ext.ok).toBe(false)
        expect(ext.diagnostics.find(d => d.code === 'extern-not-called')?.kieler?.split('\n')[0]).toBe('‘absolute’ undeclared (first use in this function)')
        // gcc's first error for some C keywords as names (probes rare/probe-c-keyword-*).
        const kw = (name: string) => errors(`scchart K {\n  input bool A\n  output int ${name}\n  initial state S\n    if A do ${name} = 1 go to T\n  state T\n}`)[0].kieler?.split('\n')[0]
        expect([kw('volatile'), kw('char'), kw('union'), kw('default')]).toEqual([
            'expected identifier before ‘volatile’', 'two or more data types in declaration specifiers', 'expected ‘{’ before ‘;’ token', 'expected identifier or ‘(’ before ‘default’',
        ])
    })

    it('state(...) in a method body is accepted and simulated (KIELER\'s MethodSignaling); elsewhere it is rejected', () => {
        const r = compile(`scchart Busy2 {
  input bool start
  output int n = 0
  method bool busy() {
    return state(Control.Busy)
  }
  region Control {
    initial state Idle
      if start go to Busy
    state Busy
  }
  region Watch {
    initial state W
      if busy() do n++ go to W
  }
}`)
        expect(r.ok).toBe(true)
        const s = createSimulation(r)
        expect(([{ start: false }, { start: true }, {}] as Record<string, boolean>[]).map(i => s.step(i).values.n)).toEqual([0, 1, 2])
        const [d] = errors('scchart Busy3 {\n  initial state S\n    if state(S) go to S\n}')
        expect(d.code).toBe('state-access')
        expect(d.kieler).toBe('State access expressions are only permissible in methods bodies.')
    })

    it('scchart(C).K is the constant\'s value; what KIELER cannot copy is rejected with its words', () => {
        const r = compile('scchart M1 {\n  input bool A\n  output int o = 0\n  initial state S\n    if A do o = scchart(K1).MAX go to S\n}\nscchart K1 {\n  const int MAX = 3 * 2\n  initial state I\n}')
        expect(r.ok).toBe(true)
        const s = createSimulation(r)
        expect([{ A: false }, { A: true }].map(i => s.step(i).values.o)).toEqual([0, 6])
        const [d] = errors('scchart M2 {\n  input bool A\n  output int o = 0\n  initial state S\n    if A do o = scchart(K2).TWICE go to S\n}\nscchart K2 {\n  const int BASE = 2\n  const int TWICE = BASE * 2\n  initial state I\n}')
        expect(d.code).toBe('static-access')
        expect(d.kieler).toContain('The valued object reference points to a valued object (BASE) that is not contained in the model!')
    })
})
