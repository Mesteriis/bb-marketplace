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
