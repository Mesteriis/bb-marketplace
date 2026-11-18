//! One session-id allocator shared by every session kind (PTY and RDP), so a
//! wire `sessionId` names exactly one session. Wire frames carry no kind tag.
use std::cell::Cell;
use std::rc::Rc;

/// The next id to hand out; `None` once u32::MAX has been issued. Ids are never
/// reused, so after exhaustion the allocator refuses instead of wrapping onto a
/// live session.
#[derive(Clone)]
pub struct SessionIds(Rc<Cell<Option<u32>>>);

impl SessionIds {
    pub fn new() -> Self {
        Self::starting_at(1)
    }

    /// An allocator whose first id is `first` (tests reach the boundary with it).
    pub fn starting_at(first: u32) -> Self {
        SessionIds(Rc::new(Cell::new(Some(first.max(1)))))
    }

    /// The next unused id, or `None` when the id space is exhausted. Never
    /// returns 0 (reserved as "no session").
    pub fn next(&self) -> Option<u32> {
        let id = self.0.get()?;
        self.0.set(id.checked_add(1));
        Some(id)
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
        assert_eq!(a.next(), Some(1));
        assert_eq!(b.next(), Some(2));
        assert_eq!(a.next(), Some(3));
    }

    #[test]
    fn the_last_id_is_issued_once_and_then_the_allocator_refuses() {
        let a = SessionIds::starting_at(u32::MAX - 1);
        assert_eq!(a.next(), Some(4_294_967_294));
        assert_eq!(a.next(), Some(4_294_967_295));
        assert_eq!(a.next(), None);
        assert_eq!(a.next(), None, "it must stay exhausted, never wrap to 1");
    }

    #[test]
    fn zero_is_never_issued() {
        assert_eq!(SessionIds::starting_at(0).next(), Some(1));
    }

    /// An exhausted id space makes both managers refuse to open, before any
    /// child exists (the echo child would otherwise be left running).
    #[test]
    fn both_managers_refuse_to_open_when_ids_are_exhausted() {
        let ids = SessionIds::starting_at(u32::MAX);
        assert_eq!(ids.next(), Some(u32::MAX));

        let mut ptys = crate::sessions::SessionManager::with_ids(Some(vec!["/usr/bin/true".to_string()]), ids.clone());
        assert!(matches!(ptys.open_echo(80, 24), Err(crate::sessions::SessionError::IdsExhausted)));
        assert_eq!(ptys.fds().len(), 0);

        let mut rdp = crate::rdp::manager::RdpManager::with_ids(ids);
        let refused = rdp.open(
            "/usr/bin/true",
            "127.0.0.1".to_string(),
            1,
            "u".to_string(),
            crate::secret::Secret::new("p"),
            None,
            800,
            600,
            None,
            false,
        );
        assert_eq!(refused, Err("session ids are exhausted".to_string()));
        assert_eq!(rdp.count(), 0);
    }
}
