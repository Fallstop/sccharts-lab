// Short explanations of SCTX keywords for the editor's hover cards. Each states KIELER's behaviour as
// docs-internal/semantics/*.md records it (basics B-8/9/11/16/33, preemption P-2/3/6/7/11/12/14/15/28/37-39/47/48/53/
// 57/61/62, concurrency T-3/4, structure S-51). `code` in backticks.

export interface KeywordDoc {
    /** The construct as one writes it, e.g. `go to Target`. */
    syntax: string
    text: string
}

export const KEYWORD_DOCS: Record<string, KeywordDoc> = {
    scchart: { syntax: 'scchart Name { ... }', text: 'A chart: its interface and its states. A file may hold several charts; the simulator runs the first one.' },
    state: { syntax: 'state Name', text: 'A state. With braces it can hold declarations, actions and regions, and becomes a superstate.' },
    initial: { syntax: 'initial state Name', text: 'The state a region starts in each time the region is entered.' },
    final: { syntax: 'final state Name', text: 'A final state. When every region of a superstate is in a final state, the superstate has terminated and its `join to` transition can fire. `final region` instead marks a region that never holds up its parent\'s termination.' },
    connector: { syntax: 'connector state Name', text: 'A junction, not a place to wait: control passes through it in the same tick, and its outgoing transitions are immediate whether or not they say so.' },
    region: { syntax: 'region Name:', text: 'A concurrent region. All regions of a state react in the same tick; they communicate through shared variables and signals.' },
    go: { syntax: 'go to Target', text: 'A weak abort. When it fires from a superstate, the inner regions first finish their reaction for this tick, then the state is left.' },
    abort: { syntax: 'abort to Target', text: 'A strong abort. It is checked before the state\'s inner behaviour; when it fires, nothing inside the state runs in that tick. Strong aborts must come before weak aborts and terminations in priority.' },
    join: { syntax: 'join to Target', text: 'A termination: taken when every region of the superstate is in a final state. Without a trigger it is immediate; with `if` it is delayed.' },
    to: { syntax: 'go to | abort to | join to', text: 'Names the target state of a transition. The target must be in the same region as the source.' },
    if: { syntax: 'if trigger', text: 'The trigger: the transition or action happens only in a tick in which this condition holds. `if 3 A` fires on the third tick in which `A` holds since the state was entered (a count delay).' },
    do: { syntax: 'do effect; effect', text: 'The effects: assignments, `++`/`--` and emissions, separated by `;`, run left to right when the transition fires or the action runs. Each sees the writes before it.' },
    immediate: { syntax: 'immediate if trigger go to Target', text: 'Also checked in the tick the state is entered. Without `immediate` a transition is delayed: it can fire at the earliest in the tick after the state was entered.' },
    delayed: { syntax: 'delayed go to Target', text: 'The default for transitions: not checked in the tick the state is entered.' },
    entry: { syntax: 'entry do effects', text: 'Runs every time the state is entered, before its immediate transitions are checked.' },
    during: { syntax: 'during do effects', text: 'Runs in every tick the state is active except the tick it is entered, including the tick it is left by `go to`. `immediate during` also runs in the entry tick.' },
    exit: { syntax: 'exit do effects', text: 'Runs every time the state is left, by any transition, abort or termination, and when an ancestor is left.' },
    suspend: { syntax: 'suspend if trigger', text: 'In a tick in which the trigger holds, the state is frozen: nothing inside runs, not even its own outgoing transitions. Not in the entry tick unless `immediate suspend`.' },
    signal: { syntax: 'signal S  /  signal int V', text: 'A signal is present in a tick in which something emits it (`do S`) and absent otherwise; presence does not carry over to the next tick. A valued signal also carries a value: `V(3)` emits it, `val(V)` reads it.' },
    input: { syntax: 'input bool x', text: 'Set by the environment before each tick. In KIELER\'s simulator an input keeps its value until the environment changes it.' },
    output: { syntax: 'output int y', text: 'Part of the chart\'s interface: the environment reads it after each tick.' },
    const: { syntax: 'const int N = 3', text: 'A compile-time constant: every use is replaced by its value. It needs an initial value and cannot be assigned.' },
    static: { syntax: 'static int visits = 0', text: 'A local that is initialised once and keeps its value when its state is left and entered again; a plain local is re-initialised on every entry.' },
    bool: { syntax: 'bool b = false', text: 'A boolean: `true` or `false` (default `false`).' },
    int: { syntax: 'int n = 0', text: 'A 32-bit integer with C\'s arithmetic (default 0).' },
    float: { syntax: 'float f = 0.5', text: 'A floating-point number (default 0).' },
    string: { syntax: 'string s = "text"', text: 'A string.' },
    pure: { syntax: 'signal pure S', text: 'A signal without a value, the same as plain `signal S`.' },
    pre: { syntax: 'pre(x)', text: 'The value `x` had at the end of the previous tick; for a signal, whether it was present in the previous tick.' },
    val: { syntax: 'val(V)', text: 'The value of the valued signal `V`. It keeps the last emitted value in ticks in which `V` is absent.' },
    combine: { syntax: 'output signal int V combine +', text: 'How several emissions of a valued signal in one tick are merged: `+`, `*`, `max`, `min`, `|` or `&`.' },
    history: { syntax: 'go to S history', text: 'Re-enters `S` in the states it was in when it was left, at every level (deep history), instead of starting at its initial states.' },
    'shallow history': { syntax: 'go to S shallow history', text: 'Resumes only the top level of `S`; its inner superstates start at their initial states again.' },
    reset: { syntax: 'go to S reset', text: 'The default: `S` is entered afresh, at its initial states (no history).' },
    deferred: { syntax: 'go to S deferred', text: 'Enters `S` quietly: none of its immediate behaviour (entry actions, immediate during actions and transitions) happens in that tick.' },
    label: { syntax: 'label "text"', text: 'A label for the diagram, shown instead of the trigger and effects.' },
    print: { syntax: 'print("x = ", x)', text: 'Prints text in the simulator.' },
    dataflow: { syntax: 'dataflow { O = A && B }', text: 'A dataflow region: equations that are evaluated in every tick.' },
    is: { syntax: 'state S is Other(a, b)', text: 'Makes `S` an instance of the chart `Other`, with its interface bound to the arguments.' },
    for: { syntax: 'region R for i : 0 to 3', text: 'One copy of the region for each value of the counter.' },
    weak: { syntax: 'weak suspend / weak entry / weak exit', text: 'A weaker form of the action: `weak exit` runs only when the state terminates normally; `weak entry` is skipped when the state is strongly aborted in its entry tick.' },
}

/** The doc for the keyword at a position, given the word there and the text just around it. */
export function keywordDoc(word: string, before: string, after: string): KeywordDoc | undefined {
    if (word === 'to') {
        const m = before.match(/\b(go|abort|join)\s+$/)
        return m ? KEYWORD_DOCS[m[1]] : KEYWORD_DOCS.to
    }
    if (word === 'shallow' || (word === 'history' && /\bshallow\s+$/.test(before))) return KEYWORD_DOCS['shallow history']
    if (word === 'deep' && /^\s*deferred\b/.test(after)) return KEYWORD_DOCS.deferred
    if (word === 'final' && /^\s*region\b/.test(after)) return { syntax: 'final region R:', text: 'A region that never holds up its parent\'s termination: when the other regions finish, the parent terminates.' }
    if (word === 'abort' && /^\s*region\b/.test(after)) return { syntax: 'abort region R:', text: 'A region whose final state terminates its parent at once (the parent finishes when any abort region finishes); the other regions still react in that tick.' }
    return Object.hasOwn(KEYWORD_DOCS, word) ? KEYWORD_DOCS[word] : undefined
}
