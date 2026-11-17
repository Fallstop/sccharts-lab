import {
  embedUrl, envelope, parseEvent, type EmbedCommand,
} from '@sccharts-lab/embed'

const SITE = 'https://sccharts.jmw.nz'

const frame = document.createElement('iframe')
frame.src = embedUrl(`${SITE}/`, {
  example: 'showcase/abro',
  height: 'auto',
})
frame.title = 'ABRO in SCCharts Lab'
document.body.append(frame)

// Commands go to the frame, in the envelope, to the embed's own origin.
const send = (command: EmbedCommand, id?: number) =>
  frame.contentWindow!.postMessage(envelope({ ...command, id }), SITE)

// Events come back. Take them only from the frame, and let parseEvent
// check their shape.
addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow) return
  const event = parseEvent(e.data)
  if (!event) return
  if (event.event === 'ready') {
    send({ command: 'step', inputs: { A: true } }, 1)
  }
  if (event.event === 'resize') frame.style.height = `${event.height}px`
  if (event.event === 'reply' && event.id === 1) console.log(event.result)
})
