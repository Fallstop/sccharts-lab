import { readFileSync, writeFileSync } from 'node:fs'
import { compile } from '@sccharts-lab/engine'
import { chartToSvg } from '@sccharts-lab/diagram'

const result = compile(readFileSync('turnstile.sctx', 'utf8'))

// A file on its own carries its stylesheet and its fonts,
// so it looks the same in any viewer.
const urlOf = (name) => new URL(import.meta.resolve(name))
const fontsUrl = urlOf('@sccharts-lab/diagram/fonts.css')
const cssUrl = urlOf('@sccharts-lab/diagram/diagram.css')
const inline = (_, file) => {
  const font = readFileSync(new URL(file, fontsUrl)).toString('base64')
  return `url(data:font/woff2;base64,${font})`
}
const fonts = readFileSync(fontsUrl, 'utf8')
  .replace(/url\(\.\/([^)]+)\)/g, inline)
const css = readFileSync(cssUrl, 'utf8')

const svg = await chartToSvg(result.chart, {
  program: result.program,
  fit: 'none',
  stylesheet: fonts + css,
})
writeFileSync('turnstile.svg', svg)
console.log('wrote turnstile.svg')
