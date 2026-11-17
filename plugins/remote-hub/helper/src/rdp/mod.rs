//! RDP engine support: the `--rdp-engine` child process and the pure modules
//! it uses. The helper stays single-threaded and poll-driven; each RDP session
//! runs in its own engine process, connected by a socketpair through the fd
//! allowlist. See docs/rdp-engine.md.

pub mod cert;
pub mod engine;
pub mod framebuffer;
pub mod input;
pub mod input_encode;
pub mod mapping;
pub mod manager;
pub mod protocol;
pub mod reasons;
