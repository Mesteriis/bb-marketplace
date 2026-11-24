export type WorktreeIssue = {
    id: string;
    name: string;
    branch: string | null;
} & (
    | {kind: 'unverified'}
    | {kind: 'unmerged'; dirty: boolean; committed: boolean}
);
