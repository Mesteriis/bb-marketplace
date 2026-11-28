import type { CommonLayer, Scaffold } from "./model.ts";

/** Where a scaffold comes from: the templates repository on GitHub, or a templates folder on the machine. */
export type ScaffoldSource = "github" | "folder";
/** A scaffold offered; it renders with its repository's common layer. */
export type OfferedScaffold = {key: string; source: ScaffoldSource; scaffold: Scaffold; common?: CommonLayer};
