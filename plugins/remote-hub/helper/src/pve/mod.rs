//! Proxmox VE engine support: the `--pve-engine` child process and the pure modules it uses.
//! The helper stays single-threaded and poll-driven; every PVE operation (discovery, one
//! console) runs in its own engine process, connected by a socketpair on fd 3 exactly like the
//! RDP engine. See docs/pve-consoles.md.

pub mod api;
pub mod engine;
pub mod glue;
pub mod manager;
pub mod protocol;
pub mod provision;
pub mod term;
pub mod tls;
