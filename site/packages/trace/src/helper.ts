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

// The helpers of keith-vscode's simulation/helper.ts that traces use.

/** The input that tells timed models how much time passes per tick; clocks only advance when it is set. */
export function isTimeDelta(data: { id?: string; categories: string[] }): boolean {
    return /^[#_]*deltaT$/i.test(data.id ?? '')
}

/** Clocks and the time delta belong to the model author, whatever the compiler tagged them as. */
export function isTimeRelated(data: { id?: string; categories: string[] }): boolean {
    return isTimeDelta(data) || data.categories.includes('clock')
}
