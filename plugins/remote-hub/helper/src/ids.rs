//! One session-id allocator shared by every session kind (PTY and RDP), so a
//! wire `sessionId` names exactly one session. Wire frames carry no kind tag.
use std::cell::Cell;
use std::rc::Rc;

#[derive(Clone)]
pub struct SessionIds(Rc<Cell<u32>>);

impl SessionIds {
    pub fn new() -> Self {
        SessionIds(Rc::new(Cell::new(1)))
    }

    /// The next unused id. Never returns 0 (reserved as "no session").
    pub fn next(&self) -> u32 {
        let id = self.0.get();
        let mut following = id.wrapping_add(1);
        if following == 0 {
            following = 1;
        }
        self.0.set(following);
        id
    }
}

impl Default for SessionIds {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clones_share_one_sequence() {
        let a = SessionIds::new();
        let b = a.clone();
        assert_eq!(a.next(), 1);
        assert_eq!(b.next(), 2);
        assert_eq!(a.next(), 3);
    }

    #[test]
    fn zero_is_skipped_on_wrap() {
        let a = SessionIds::new();
        a.0.set(u32::MAX);
        assert_eq!(a.next(), u32::MAX);
        assert_eq!(a.next(), 1);
    }
}
