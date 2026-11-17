import {
  embedUrl, envelope, parseCommand, parseEvent,
} from '@sccharts-lab/embed'

// The address of an embed, from its options.
const src = embedUrl('https://sccharts.jmw.nz/', {
  example: 'learn/concurrency/abro',
  view: 'diagram',
  controls: false,
})
console.log(src)

// A command for the frame, in the protocol's envelope.
const step = envelope({ command: 'step', inputs: { A: true }, id: 1 })
console.log(step)

// What the embed makes of a message: a command, or the reason it is not.
console.log(parseCommand(step).kind)
console.log(parseCommand(envelope({ command: 'jump' })))

// An event from the frame, checked.
const message = envelope({ event: 'resize', height: 320 })
console.log(parseEvent(message))
console.log(parseEvent({ hello: 'world' }))
