export type LayoutNode = {
    kind: 'item';
    id: string;
    hidden: boolean;
    itemId: string;
} | {
    kind: 'separator';
    id: string;
    hidden: boolean;
} | {
    kind: 'group';
    id: string;
    hidden: boolean;
    name: string;
    icon: string;
    children: LayoutNode[];
};
export interface LayoutDocument {
    version: 1;
    revision: number;
    nodes: LayoutNode[];
}
export type DecodeResult = {
    kind: 'valid';
    document: LayoutDocument;
} | {
    kind: 'corrupt';
    message: string;
} | {
    kind: 'unsupported';
};
export interface NavigationBadge { count?: number; text?: string; label: string; tone?: 'critical'|'neutral'|'warning' }
