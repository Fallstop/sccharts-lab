/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2021 by
 * + Kiel University
 *   + Department of Computer Science
 *     + Real-Time and Embedded Systems Group
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 */
import * as vscode from 'vscode'
/**
 * Command to restart a simulation.
 */
export const SIMULATE: vscode.Command = {
    command: 'keith-vscode.simulation-restart',
    title: 'Restart simulation',
}

/**
 * Command to compile the model again with the running simulation's system and start over.
 */
export const REBUILD_SIMULATION: vscode.Command = {
    command: 'keith-vscode.simulation-rebuild',
    title: 'Rebuild and Restart Simulation',
}

export const COMPILE_AND_SIMULATE: vscode.Command = {
    command: 'keith-vscode.simulate',
    title: 'Simulate',
}

export const COMPILE_AND_SIMULATE_SNAPSHOT: vscode.Command = {
    command: 'keith-vscode.simulate-snapshot',
    title: 'Simulate snapshot',
}

export const STOP_SIMULATION: vscode.Command = {
    command: 'keith-vscode.simulation-stop',
    title: 'Stop simulation',
}

export const STEP_SIMULATION: vscode.Command = {
    command: 'keith-vscode.simulation-step',
    title: 'Execute simulation step',
}

export const PAUSE_SIMULATION: vscode.Command = {
    command: 'keith-vscode.simulation-pause',
    title: 'Pause simulation',
}

export const RUN_SIMULATION: vscode.Command = {
    command: 'keith-vscode.simulation-run',
    title: 'Run simulation',
}

export const SAVE_TRACE: vscode.Command = {
    command: 'keith-vscode.simulation-save-trace',
    title: 'Save Trace or Input Sequence...',
}

export const LOAD_TRACE: vscode.Command = {
    command: 'keith-vscode.simulation-load-trace',
    title: 'Replay Trace...',
}

export const COMPARE_RUN: vscode.Command = {
    command: 'keith-vscode.simulation-compare-run',
    title: 'Compare Run with Traces...',
}

export const COMPARE_TRACES: vscode.Command = {
    command: 'keith-vscode.compare-traces',
    title: 'Compare Traces...',
}

export const RUN_MODELS_ON_TRACE: vscode.Command = {
    command: 'keith-vscode.run-models-on-trace',
    title: 'Run Models on an Input Sequence...',
}

export const STEP_BACK_SIMULATION: vscode.Command = {
    command: 'keith-vscode.simulation-step-back',
    title: 'Step back one tick',
}

export const RUN_TO_BREAKPOINT: vscode.Command = {
    command: 'keith-vscode.simulation-run-to-breakpoint',
    title: 'Run to breakpoint',
}

export const ADD_BREAKPOINT: vscode.Command = {
    command: 'keith-vscode.simulation-add-breakpoint',
    title: 'Add simulation breakpoint...',
}

export const ADD_WATCH: vscode.Command = {
    command: 'keith-vscode.simulation-add-watch',
    title: 'Add simulation watch expression...',
}

export const NEW_VALUE_SIMULATION: vscode.Command = {
    command: 'keith-vscode.simulation-new-value',
    title: 'New value for ...',
}

export const ADD_CO_SIMULATION: vscode.Command = {
    command: 'keith-vscode.add-co-simulation',
    title: 'Add Co-Simulation',
}

export const SELECT_SIMULATION_CHAIN: vscode.Command = {
    command: 'select-simulation-chain',
    title: 'Select simulation chain',
}

export const SELECT_SNAPSHOT_SIMULATION_CHAIN: vscode.Command = {
    command: 'select-snapshot-simulation-chain',
    title: 'Select snapshot simulation chain',
}

export const SET_SIMULATION_SPEED: vscode.Command = {
    command: 'set-simulation-speed',
    title: 'Set simulation speed',
}

export const REVEAL_SIMULATION_WIDGET: vscode.Command = {
    command: 'reveal-simulation-widget',
    title: 'Reveal simulation widget',
}

export const SET_SIMULATION_STEP_DELAY: vscode.Command = {
    command: 'keith-vscode.simulation-step-delay',
    title: 'Set simulation step delay to ...',
}

export const SET_SIMULATION_TYPE_TO: vscode.Command = {
    command: 'keith-vscode.simulation-type',
    title: 'Set simulation type to ...',
}

export const SHOW_INTERNAL_VARIABLES: vscode.Command = {
    command: 'keith-vscode.show-internal-variables',
    title: 'Set display internal variables to ...',
}

export const RESTART_LANGUAGE_SERVER: vscode.Command = {
    command: 'keith-vscode.restart-language-server',
    title: 'Restart KIELER language server',
}
