/** Serializes ticks until the server acknowledges them, and cancels obsolete run loops. */
export class StepController {
    private pending: { promise: Promise<void>; finish: (error?: Error) => void } | undefined

    private generation = 0

    private timer: ReturnType<typeof setTimeout> | undefined

    private wake: (() => void) | undefined

    constructor(
        private readonly send: () => Promise<void>,
        private readonly timeout = 30000
    ) {}

    step(): Promise<void> {
        if (this.pending) {
            return this.pending.promise
        }
        let finish!: (error?: Error) => void
        const promise = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => finish(new Error('The simulation did not respond to the tick.')),
                this.timeout
            )
            finish = (error) => {
                clearTimeout(timer)
                this.pending = undefined
                if (error) reject(error)
                else resolve()
            }
        })
        const pending = { promise, finish }
        this.pending = pending
        this.send().catch((error) => {
            if (this.pending === pending) finish(error)
        })
        return promise
    }

    acknowledge(): void {
        this.pending?.finish()
    }

    /**
     * Steps until paused, `getDelay` milliseconds apart. `pace` is called before each tick and the
     * run waits for what it returns after the tick, e.g. the preview drawing the tick's diagram.
     */
    async run(getDelay: () => number, pace: () => Promise<void> | undefined = () => undefined): Promise<void> {
        const generation = ++this.generation
        while (generation === this.generation) {
            const paced = pace()
            // eslint-disable-next-line no-await-in-loop
            await this.step()
            if (generation !== this.generation) return
            if (paced) {
                // A pause ends the wait at once.
                // eslint-disable-next-line no-await-in-loop
                await Promise.race([
                    paced,
                    new Promise<void>((resolve) => {
                        this.wake = resolve
                    }),
                ])
                if (generation !== this.generation) return
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise<void>((resolve) => {
                this.wake = resolve
                const delay = getDelay()
                this.timer = setTimeout(resolve, Number.isFinite(delay) ? Math.max(0, delay) : 200)
            })
        }
    }

    pause(): void {
        this.generation++
        clearTimeout(this.timer)
        this.wake?.()
        this.wake = undefined
    }

    reset(): void {
        this.pause()
        this.acknowledge()
    }
}
