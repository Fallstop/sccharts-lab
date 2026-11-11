// The embed's options: the query of /embed/ and the attributes of <sccharts-lab-chart> (packages/embed/src/options.ts).
import { describe, expect, test } from 'vitest'
import { DEFAULTS, embedQuery, embedUrl, estimateHeight, parseEmbedQuery, parseExample, parseHeight, parseTick, targetFromAttributes, VIEWS } from '@sccharts-lab/embed/options'

describe('the query of /embed/', () => {
    test('defaults: the simulation, filling the frame, no tour, the controls shown', () => {
        expect(parseEmbedQuery('')).toEqual(DEFAULTS)
        expect(DEFAULTS).toEqual({ view: 'sim', height: 'fill', tour: false, controls: true })
    })

    test('every option', () => {
        expect(parseEmbedQuery('?example=learn/concurrency/abro&view=full&height=auto&tour&tick=3&controls=0&chart=Main&source=parent')).toEqual({
            view: 'full', height: 'auto', tour: true, controls: false, tick: 3, chart: 'Main', source: 'parent', example: 'learn/concurrency/abro',
        })
        for (const v of VIEWS) expect(parseEmbedQuery(`view=${v}`).view).toBe(v)
        expect(parseEmbedQuery('view=DIAGRAM').view).toBe('diagram')
    })

    test('anything malformed keeps its default', () => {
        const q = parseEmbedQuery('?view=everything&height=tall&tick=-1&tour=maybe&controls=sometimes&chart=1abc&source=window&example=../etc/passwd')
        expect(q).toEqual(DEFAULTS)
    })

    test('heights: auto, fill, pixels within limits', () => {
        expect(parseHeight('auto')).toBe('auto')
        expect(parseHeight('fill')).toBe('fill')
        expect(parseHeight('480')).toBe(480)
        expect(parseHeight('480px')).toBe(480)
        expect(parseHeight('12')).toBe(120)
        expect(parseHeight('9999')).toBe(4000)
        expect(parseHeight('4.5e2')).toBe('fill')
        expect(parseHeight(null, 'auto')).toBe('auto')
    })

    test('ticks from 0 to 1000', () => {
        expect(parseTick('0')).toBe(0)
        expect(parseTick('12')).toBe(12)
        expect(parseTick('50000')).toBe(1000)
        expect(parseTick('3.5')).toBeUndefined()
        expect(parseTick('')).toBeUndefined()
    })

    test('flags: present, 1/true/yes/on; 0/false/no/off/none', () => {
        expect(parseEmbedQuery('tour').tour).toBe(true)
        expect(parseEmbedQuery('tour=yes').tour).toBe(true)
        expect(parseEmbedQuery('tour=0').tour).toBe(false)
        expect(parseEmbedQuery('controls').controls).toBe(true)
        expect(parseEmbedQuery('controls=none').controls).toBe(false)
        expect(parseEmbedQuery('controls=false').controls).toBe(false)
    })

    test('example ids as playground links write them', () => {
        expect(parseExample('learn/concurrency/abro')).toBe('learn/concurrency/abro')
        expect(parseExample('/showcase/abro.sctx')).toBe('showcase/abro')
        expect(parseExample('learn/../../x')).toBeUndefined()
        expect(parseExample('a b')).toBeUndefined()
        expect(parseExample('javascript:alert(1)')).toBeUndefined()
    })
})

describe('the address of an embed', () => {
    test('only what differs from the defaults, slashes of the example kept', () => {
        expect(embedQuery({})).toBe('')
        expect(embedQuery({ example: 'learn/concurrency/abro', view: 'sim', height: 'fill' })).toBe('?example=learn/concurrency/abro')
        expect(embedQuery({ example: 'showcase/abro', view: 'diagram', height: 'auto', tour: true, tick: 4, controls: false, chart: 'Main' })).toBe(
            '?example=showcase/abro&view=diagram&height=auto&tour&tick=4&controls=0&chart=Main',
        )
        expect(embedQuery({ source: 'parent', height: 360 })).toBe('?source=parent&height=360')
    })

    test('round trip through the parser', () => {
        const t = { example: 'learn/concurrency/abro', view: 'full' as const, height: 520, tour: true, tick: 2, controls: false, chart: 'ABRO' }
        expect(parseEmbedQuery(embedQuery(t))).toEqual({ ...t, height: 520 })
    })

    test('a base with or without its slash, and a hash', () => {
        expect(embedUrl('https://sccharts.jmw.nz', { example: 'showcase/abro' })).toBe('https://sccharts.jmw.nz/embed/?example=showcase/abro')
        expect(embedUrl('https://sccharts.jmw.nz/', { view: 'editor' }, '#code=abc')).toBe('https://sccharts.jmw.nz/embed/?view=editor#code=abc')
    })
})

describe('the attributes of <sccharts-lab-chart>', () => {
    const attrs = (a: Record<string, string>) => (name: string) => (name in a ? a[name] : null)

    test('its height is auto unless given', () => {
        expect(targetFromAttributes(attrs({}))).toEqual({ view: 'sim', height: 'auto', tour: false, controls: true })
        expect(targetFromAttributes(attrs({ height: '400' })).height).toBe(400)
        expect(targetFromAttributes(attrs({ height: 'fill' })).height).toBe('fill')
    })

    test('boolean attributes: present is on, "false" is off', () => {
        expect(targetFromAttributes(attrs({ tour: '' })).tour).toBe(true)
        expect(targetFromAttributes(attrs({ tour: 'false' })).tour).toBe(false)
        expect(targetFromAttributes(attrs({ controls: 'false' })).controls).toBe(false)
        expect(targetFromAttributes(attrs({ controls: '' })).controls).toBe(true)
    })

    test('the chart and the view', () => {
        expect(targetFromAttributes(attrs({ example: 'showcase/abro', view: 'diagram', chart: 'ABRO', tick: '5' }))).toEqual({
            view: 'diagram', height: 'auto', tour: false, controls: true, example: 'showcase/abro', chart: 'ABRO', tick: 5,
        })
        expect(targetFromAttributes(attrs({ view: 'nonsense', chart: 'not a name' }))).toEqual({ view: 'sim', height: 'auto', tour: false, controls: true })
    })

    test('a first guess at the height, per view', () => {
        for (const v of VIEWS) expect(estimateHeight(v)).toBeGreaterThan(200)
        expect(estimateHeight('full', 360)).toBeGreaterThan(estimateHeight('full', 900))
    })
})
