// Exercises textDocument/completion for SCTX: documented keywords, snippets, and the variables and
// states in scope at the positions a modeller actually types in.
//
// Every case types into one of the blank lines of fixtures/completion.sctx and asks for completion at the
// end of what was typed. The document is edited in place rather than copied to a new file, so the index
// holds one chart called Counter and proposals are not doubled by a second file's qualified names.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node')

const Kind = { Field: 5, Class: 7, Value: 12, Keyword: 14, Snippet: 15, Variable: 18 }
const SNIPPET_FORMAT = 2

async function main() {
    const { java, serverArgs } = require('./server-launch.cjs')
    const workspace = fs.mkdtempSync(path.join(tmpdir(), 'kieler-completion-'))
    const server = spawn(java, serverArgs, { cwd: workspace })
    const closed = new Promise(resolve => server.once('close', resolve))
    let stderr = ''
    server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000) })
    const connection = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin))
    connection.onNotification(() => {})
    connection.onRequest('workspace/configuration', params => params.items.map(() => null))
    connection.onRequest('client/registerCapability', () => null)
    connection.listen()
    const watchdog = setTimeout(() => server.kill(), 180000)
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/completion.sctx'), 'utf8')
    const blank = fixture.split('\n').map((line, index) => [index + 1, line]).filter(([, line]) => line.trim() === '')
    // The lines the cases type into; naming them keeps the assertions readable and the fixture honest.
    const LINE = { rootBody: 8, stateBody: 13, transition: 18, topLevel: 24 }
    for (const [name, line] of Object.entries(LINE)) {
        assert.ok(blank.some(([number]) => number === line), `line ${line} (${name}) is blank in the fixture, blank lines are ${blank.map(([n]) => n)}`)
    }
    try {
        const init = await connection.sendRequest('initialize', {
            processId: process.pid,
            rootUri: pathToFileURL(workspace).href,
            capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } } } },
            workspaceFolders: null,
        })
        assert.ok(init.capabilities.completionProvider, 'server advertises completionProvider')
        await connection.sendNotification('initialized', {})
        const file = path.join(workspace, 'completion.sctx')
        fs.writeFileSync(file, fixture)
        const uri = pathToFileURL(file).href
        await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'sctx', version: 1, text: fixture } })

        let version = 1
        /** Types `typed` into the blank fixture line `line` and completes at the end of it. */
        const completeAt = async (line, typed) => {
            const lines = fixture.split('\n')
            assert.equal(lines[line - 1].trim(), '', `line ${line} is blank in the fixture`)
            lines[line - 1] = typed
            const text = lines.join('\n')
            await connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: ++version }, contentChanges: [{ text }] })
            const result = await connection.sendRequest('textDocument/completion', { textDocument: { uri }, position: { line: line - 1, character: typed.length } })
            const items = Array.isArray(result) ? result : result.items
            return {
                items,
                labels: items.map(item => item.label),
                find: label => items.find(item => item.label === label),
                inserted: item => (item.textEdit ? item.textEdit.newText : item.insertText),
            }
        }
        const markdown = item => {
            assert.ok(item.documentation, `${item.label} carries documentation`)
            assert.equal(item.documentation.kind, 'markdown', `${item.label} documentation is MarkupContent markdown`)
            return item.documentation.value
        }

        // --- A half-typed keyword inside a state body -------------------------------------------------
        // The content assist parser stops in the declaration loop here, so Xtext's own follow set offers
        // `enum` and nothing else; the local actions have to be added back.
        const typedEntry = await completeAt(LINE.stateBody, '    en')
        const entry = typedEntry.find('entry')
        assert.ok(entry, `en proposes entry, got ${JSON.stringify(typedEntry.labels)}`)
        assert.equal(entry.kind, Kind.Keyword)
        assert.equal(entry.detail, 'Action run when the state is entered.')
        assert.match(markdown(entry), /^\*\*`entry`\*\*: Action run when the state is entered\.\n\nDeclares an entry action/)
        assert.ok(typedEntry.find('enum'), 'the grammar keywords are still there')
        assert.ok(typedEntry.labels.indexOf('entry') < typedEntry.labels.indexOf('enum'), 'entry sorts above enum')
        const upperCase = await completeAt(LINE.stateBody, '    EN')
        assert.ok(upperCase.find('entry'), `prefix matching ignores case, got ${JSON.stringify(upperCase.labels)}`)
        console.log(`Keywords: en proposes entry with a Markdown card (${typedEntry.items.length} items), EN proposes it too.`)

        // --- The start of a state body ----------------------------------------------------------------
        const body = await completeAt(LINE.stateBody, '    ')
        for (const keyword of ['state', 'region', 'entry', 'during', 'exit', 'suspend', 'period', 'input', 'output', 'const', 'signal', 'clock', 'initial', 'final', 'bool', 'int', 'float', 'string', 'host', 'ref']) {
            assert.ok(body.find(keyword), `a state body proposes ${keyword}, got ${JSON.stringify(body.labels)}`)
        }
        for (const keyword of ['state', 'region', 'input', 'output', 'signal', 'clock', 'const', 'entry', 'during', 'exit', 'suspend', 'period', 'bool', 'int', 'ref']) {
            assert.ok(markdown(body.find(keyword)).length > 80, `${keyword} carries a documentation body`)
        }
        assert.equal(body.find('input').detail, 'Declaration read from the environment.')
        console.log(`State body: ${body.items.length} proposals, keywords documented as Markdown.`)

        // --- Snippets ----------------------------------------------------------------------------------
        const snippets = {
            'state Name { }': 'state ${1:Name} {',
            'initial state Name': 'initial state ${1:Name}',
            'region Name { initial state S }': 'region ${1:Name} {',
        }
        for (const [label, start] of Object.entries(snippets)) {
            const item = body.find(label)
            assert.ok(item, `the state body offers the ${label} snippet, got ${JSON.stringify(body.labels)}`)
            assert.equal(item.kind, Kind.Snippet, `${label} is a snippet item`)
            assert.equal(item.insertTextFormat, SNIPPET_FORMAT, `${label} is inserted as a snippet`)
            assert.ok(body.inserted(item).startsWith(start), `${label} inserts ${start}…, got ${JSON.stringify(body.inserted(item))}`)
        }
        const entrySnippet = typedEntry.find('entry do x = 0')
        assert.ok(entrySnippet && entrySnippet.kind === Kind.Snippet, 'en also offers the entry snippet')
        assert.equal(typedEntry.inserted(entrySnippet), 'entry do ${1:x} = ${2:0}$0')
        const root = await completeAt(LINE.rootBody, '')
        assert.ok(!root.find('scchart Name { }'), 'the chart snippet belongs outside a chart, not in its body')
        const topLevel = await completeAt(LINE.topLevel, '')
        assert.ok(topLevel.find('scchart Name { }'), `a file offers the chart snippet, got ${JSON.stringify(topLevel.labels)}`)
        assert.equal(topLevel.inserted(topLevel.find('scchart Name { }')), 'scchart ${1:Name} {\n\t$0\n}')
        console.log('Snippets: state, initial state, region, entry and scchart insert with tab stops.')

        // --- A trigger and an effect -------------------------------------------------------------------
        const trigger = await completeAt(LINE.transition, '      if co')
        const count = trigger.find('count')
        assert.ok(count, `if co proposes count, got ${JSON.stringify(trigger.labels)}`)
        assert.equal(count.detail, 'output int')
        assert.equal(count.kind, Kind.Field)
        assert.equal(markdown(count), 'How many pulses have been seen.', 'the comment above the declaration is the documentation')
        const effect = await completeAt(LINE.transition, '      if tick do co')
        assert.ok(effect.find('count'), `do co proposes count, got ${JSON.stringify(effect.labels)}`)
        assert.equal(effect.find('count').detail, 'output int')
        const scope = await completeAt(LINE.transition, '      if ')
        assert.deepEqual(['LIMIT', 'count', 'local', 'tick'].filter(name => scope.find(name)), ['LIMIT', 'count', 'local', 'tick'], `every variable in scope, got ${JSON.stringify(scope.labels)}`)
        assert.equal(scope.find('LIMIT').detail, 'const int')
        assert.equal(scope.find('tick').detail, 'input bool')
        assert.equal(scope.find('local').detail, 'int')
        assert.ok(scope.find('pre') && scope.find('val') && scope.find('true'), 'pre, val and the boolean literals are offered in an expression')
        console.log('Expressions: triggers and effects propose the variables in scope with their declaration kind.')

        // --- Transition targets ------------------------------------------------------------------------
        const targets = await completeAt(LINE.transition, '      go to ')
        assert.deepEqual(targets.labels.filter(label => ['Running', 'Done', 'Idle', 'Counting'].includes(label)).sort(), ['Done', 'Running'], `the states of the enclosing region, got ${JSON.stringify(targets.labels)}`)
        assert.equal(targets.find('Running').detail, 'initial state')
        assert.equal(targets.find('Done').detail, 'final state')
        assert.equal(targets.find('Running').kind, Kind.Class)
        const preemption = await completeAt(LINE.transition, '      if tick ')
        assert.match(markdown(preemption.find('go')), /^\*\*`go to`\*\*: Weak abort/, 'go is documented as the transition it starts')
        assert.match(markdown(preemption.find('abort')), /^\*\*`abort to`\*\*: Strong abort/)
        assert.match(markdown(preemption.find('join')), /^\*\*`join to`\*\*/)
        console.log('Targets: go to proposes the states of the enclosing region; go, abort and join read as transitions.')

        // --- No operator noise -------------------------------------------------------------------------
        // `if <reference>` used to answer with the 26 binary operators of the expression grammar.
        const operator = /^[^\p{L}]/u
        for (const [label, typed] of [['if tick', '      if tick'], ['if tick ', '      if tick '], ['effect', '      if tick do count = count '], ['body', '    ']]) {
            const answer = await completeAt(typed.trim() === '' ? LINE.stateBody : LINE.transition, typed)
            const operators = answer.labels.filter(item => operator.test(item))
            assert.deepEqual(operators, [], `no operator proposals after ${label}`)
            assert.ok(!answer.labels.includes('Pr='), `no Pr= after ${label}`)
            assert.ok(!answer.labels.includes('triggerDelay') && !answer.labels.includes('values'), `no grammar feature names after ${label}`)
        }
        console.log('Noise: no bare operators, no Pr=, no grammar feature names.')
        assert.ok(!/Exception/.test(stderr), stderr)
    } finally {
        clearTimeout(watchdog)
        connection.dispose()
        server.kill()
        await closed
    }
}

main().catch(error => { console.error(error); process.exit(1) })
