// The widgets' seam to the engine (src/engine/index.ts): compile(), createSimulation(), describeTick(), elementName()
// and traceableVariables() (what `show` may name besides the data pool).
// Everything in src/components/sim goes through here, so the widgets have one place that knows the engine's API.

export { compile, createSimulation, describeTick, elementName, traceableVariables, type CompileResult, type Simulation, type TraceableVariable } from '~engine/index'
