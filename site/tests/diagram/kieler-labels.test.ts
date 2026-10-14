// The diagram shows exactly the texts KIELER shows: state names and titles, declaration and action rows,
// region labels and transition labels, the same line styles and decorators, the same region directions and
// the same arrangement of states. The references were recorded from KIELER's own diagram synthesis with
// tools/diagram-kieler-labels.mjs (needs Java; the JSON is committed).

import fs from 'node:fs'
import path from 'node:path'
import { describe } from 'vitest'
import { compareWithKieler, type KielerLabels } from './kieler-compare'

const here = path.dirname(new URL(import.meta.url).pathname)
const cases = ['kieler', 'charts'].flatMap(dir => fs.readdirSync(path.join(here, dir))
    .filter(f => f.endsWith('.kieler-labels.json'))
    .map(f => ({ dir, name: f.replace('.kieler-labels.json', '') })))

describe('the diagram matches KIELER (diagram test charts)', () => {
    for (const { dir, name } of cases) {
        const reference = JSON.parse(fs.readFileSync(path.join(here, dir, `${name}.kieler-labels.json`), 'utf8')) as KielerLabels
        compareWithKieler(`${dir}/${name}`, fs.readFileSync(path.join(here, dir, `${name}.sctx`), 'utf8'), reference)
    }
})
