import { KEYWORDS, lex } from '@sccharts-lab/engine/lexer'

const { tokens } = lex('if coin do unlocked = true go to Unlocked')
for (const token of tokens) {
  const kind = KEYWORDS.has(token.kind) ? 'keyword' : token.kind
  console.log(String(token.start).padStart(2), kind.padEnd(8), token.text)
}
