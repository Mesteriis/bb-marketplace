//! RDP engine support: the `--rdp-engine` child process and the pure modules
//! it uses. The helper stays single-threaded and poll-driven; each RDP session
//! runs in its own engine process, connected by a socketpair through the fd
//! allowlist. See docs/rdp-engine.md.

pub mod cert;
pub mod connect;
pub mod driver;
pub mod engine;
pub mod engine_io;
pub mod framebuffer;
pub mod health;
pub mod input;
pub mod input_encode;
pub mod mapping;
pub mod manager;
pub mod options;
pub mod protocol;
pub mod pump;
pub mod reasons;

/// Synthetic engines for the integration tests (never in a release helper).
#[cfg(feature = "test-hooks")]
pub mod fake_engine;
