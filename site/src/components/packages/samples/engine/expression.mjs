import {
  formatExpressionParenthesised, parseExpression,
} from '@sccharts-lab/engine'

const parsed = parseExpression('a + b * c > 3 && !d')
console.log(parsed.as)
console.log(formatExpressionParenthesised(parsed.expression))

console.log(parseExpression('x += 1').as)
console.log(parseExpression('a +').diagnostics[0].message)
