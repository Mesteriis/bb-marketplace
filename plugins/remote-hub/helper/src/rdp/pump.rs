//! Ack-driven update pacing for one consumer (stage 2b contract B5). Wraps the
//! tested `ViewUpdates` into the engine's real path: at most ONE update is in
//! flight; while it is un-acked, later dirty regions are coalesced into one
//! pending region (latest pixels win, taken from the framebuffer at send
//! time), never queued. Memory is therefore bounded by the framebuffer no
//! matter how fast the server paints or how slowly the consumer reads.
use super::framebuffer::{Rect, ViewUpdates};

#[derive(Debug, Default)]
pub struct UpdatePump {
    view: ViewUpdates,
    /// Frame id of the update in flight, as sent (the consumer acks it by id).
    in_flight: Option<u64>,
}

impl UpdatePump {
    pub fn new() -> Self {
        UpdatePump { view: ViewUpdates::new(), in_flight: None }
    }

    pub fn in_flight(&self) -> Option<u64> {
        self.in_flight
    }

    pub fn pending(&self) -> Option<Rect> {
        self.view.pending_region()
    }

    /// A region of the framebuffer changed. Returns the region to send now
    /// (nothing in flight), or None when it was coalesced into the pending
    /// region.
    pub fn on_dirty(&mut self, rect: Rect) -> Option<Rect> {
        self.view.on_dirty(rect)
    }

    /// Record that an update with `frame_id` has been sent.
    pub fn sent(&mut self, frame_id: u64) {
        self.in_flight = Some(frame_id);
    }

    /// The consumer acked `frame_id`. An ack for anything but the update in
    /// flight is stale and ignored. Returns the pending region to send next.
    pub fn on_ack(&mut self, frame_id: u64) -> Option<Rect> {
        if self.in_flight != Some(frame_id) {
            return None;
        }
        self.in_flight = None;
        self.view.on_ack()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: u32, y: u32, w: u32, h: u32) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn exactly_one_update_until_acked_then_one_coalesced_region() {
        let mut p = UpdatePump::new();
        let first = p.on_dirty(r(0, 0, 10, 10));
        assert_eq!(first, Some(r(0, 0, 10, 10)));
        p.sent(5);
        // 100 more server updates while un-acked: none released.
        for i in 0..100u32 {
            assert_eq!(p.on_dirty(r(i % 7, i % 5, 3, 3)), None);
        }
        // One coalesced region: the literal bounding box of all of them.
        assert_eq!(p.pending(), Some(r(0, 0, 9, 7)));
        assert_eq!(p.in_flight(), Some(5));
        // The ack releases exactly that region.
        assert_eq!(p.on_ack(5), Some(r(0, 0, 9, 7)));
        p.sent(6);
        assert_eq!(p.pending(), None);
        assert_eq!(p.on_ack(6), None);
        assert_eq!(p.in_flight(), None);
    }

    #[test]
    fn a_stale_or_wrong_ack_releases_nothing() {
        let mut p = UpdatePump::new();
        assert_eq!(p.on_ack(1), None); // nothing in flight
        assert!(p.on_dirty(r(0, 0, 4, 4)).is_some());
        p.sent(9);
        assert_eq!(p.on_dirty(r(1, 1, 2, 2)), None);
        assert_eq!(p.on_ack(8), None, "ack of another frame");
        assert_eq!(p.in_flight(), Some(9));
        assert_eq!(p.pending(), Some(r(1, 1, 2, 2)));
        assert_eq!(p.on_ack(9), Some(r(1, 1, 2, 2)));
    }
}
