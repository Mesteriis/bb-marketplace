// The host-agnostic core: domain types, ports, and application logic.
// Nothing here may import BB, Node, Electron, Tauri, or React; the test in
// tests/architecture.test.ts enforces it.
export * from "./model.ts";
export * from "./ports.ts";
export * from "./presets.ts";
export * from "./contract.ts";
export * from "./threading.ts";
export * from "./sync.ts";
export * from "./search.ts";
export * from "./agent-text.ts";
export * from "./accounts.ts";
export * from "./store-rules.ts";
export * from "./actions.ts";
export * from "./inline-html.ts";
export * from "./compose-address.ts";
export * from "./compose-subjects.ts";
export * from "./compose-reply.ts";
export * from "./compose-doc.ts";
export * from "./compose-bcc.ts";
export * from "./compose-drafts.ts";
export * from "./compose.ts";
export * from "./compose-outbox.ts";
export { removeControls, removeInvisible } from "./html-entities.ts";
