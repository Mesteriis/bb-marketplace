// The host-agnostic core: domain types, ports, and application logic.
// Nothing here may import BB, Node, Electron, Tauri, or React; the test in
// tests/architecture.test.ts enforces it.
export {
  mailAccountSchema,
  type AccountRepository,
  type MailAccount,
} from "./accounts.ts";
export {
  getMailOverview,
  mailOverviewSchema,
  type MailOverview,
} from "./overview.ts";
