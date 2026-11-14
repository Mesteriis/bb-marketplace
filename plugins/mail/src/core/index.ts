// The host-agnostic core: domain types, ports, and application logic.
// Nothing here may import BB, Node, Electron, Tauri, or React; the test in
// tests/architecture.test.ts enforces it.
export * from "./model.ts";
export * from "./ports.ts";
export * from "./presets.ts";
export * from "./contract.ts";
