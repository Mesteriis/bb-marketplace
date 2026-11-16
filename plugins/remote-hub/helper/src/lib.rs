//! Remote Hub helper library. The binary (src/main.rs) is a thin wrapper;
//! integration tests import the framing and message types from here.
pub mod ipc;
pub mod protocol;
pub mod sessions;
pub mod ssh_args;
