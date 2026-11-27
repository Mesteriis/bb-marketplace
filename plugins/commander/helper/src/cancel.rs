use crate::errors::{self, HErr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

/// Cooperative cancellation: the reader thread stores the request id to cancel.
#[derive(Clone)]
pub struct Ctx {
    pub req: u32,
    pub cancel: Arc<AtomicU32>,
}

impl Ctx {
    pub fn new(req: u32, cancel: Arc<AtomicU32>) -> Self {
        Ctx { req, cancel }
    }
    pub fn none() -> Self {
        Ctx { req: 0, cancel: Arc::new(AtomicU32::new(0)) }
    }
    pub fn check(&self) -> Result<(), HErr> {
        if self.req != 0 && self.cancel.load(Ordering::Relaxed) == self.req {
            Err(errors::cancelled())
        } else {
            Ok(())
        }
    }
}
