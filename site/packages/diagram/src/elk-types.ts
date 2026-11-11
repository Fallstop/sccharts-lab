// The ELK graph as JSON, as elkjs declares it (elkjs/lib/elk-api.d.ts, 0.12.0): the shapes the layout sends ELK and
// reads back. Kept here so that this package's declarations never load elkjs's, whose ELK interface does not type-check
// with skipLibCheck off (TS2536 on `T['children'][number]`). Structurally the same, so elkjs's own values fit.

export interface LayoutOptions {
    [key: string]: string
}

export interface ElkPoint {
    x: number
    y: number
}

export interface ElkGraphElement {
    id?: string
    labels?: ElkLabel[]
    layoutOptions?: LayoutOptions
}

export interface ElkShape extends ElkGraphElement {
    x?: number
    y?: number
    width?: number
    height?: number
}

export interface ElkNode extends ElkShape {
    id: string
    children?: ElkNode[]
    ports?: ElkPort[]
    edges?: ElkExtendedEdge[]
}

export interface ElkPort extends ElkShape {
    id: string
}

export interface ElkLabel extends ElkShape {
    text?: string
}

export interface ElkEdge extends ElkGraphElement {
    id: string
    container?: string
    junctionPoints?: ElkPoint[]
}

export interface ElkExtendedEdge extends ElkEdge {
    sources: string[]
    targets: string[]
    sections?: ElkEdgeSection[]
}

export interface ElkEdgeSection extends ElkGraphElement {
    id: string
    startPoint: ElkPoint
    endPoint: ElkPoint
    bendPoints?: ElkPoint[]
    incomingShape?: string
    outgoingShape?: string
    incomingSections?: string[]
    outgoingSections?: string[]
}
