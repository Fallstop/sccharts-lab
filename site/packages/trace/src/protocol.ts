/*
 * KIELER - Kiel Integrated Environment for Layout Eclipse RichClient
 *
 * http://rtsys.informatik.uni-kiel.de/kieler
 *
 * Copyright 2026 by
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

// The part of keith-vscode's simulation/protocol.ts that replaying uses: what a view shows of a replay.

/** A trace file driving the inputs of the running simulation. */
export interface ReplayState {
    /** File name of the trace. */
    label: string
    /** Ticks in the file. */
    length: number
    /** Rows of the file driven so far, at most `length`. */
    tick: number
    /** Outputs in both the file and the model, checked after each tick. */
    checked: string[]
    /** Inputs in the file that the model does not have. */
    ignored: string[]
    /** Inputs of the model the file does not set; they stay under the user's control. */
    unset: string[]
    /** Ticks so far at which a checked output differs from the file. */
    mismatchTicks: number
    firstMismatch?: { tick: number; text: string }
    /** File values that do not fit the model's inputs. */
    problems: string[]
    /** What the reader left out, e.g. further traces in the file. */
    notes: string[]
}
