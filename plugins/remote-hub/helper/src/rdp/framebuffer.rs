//! One RGBA8 framebuffer per session plus per-view ack-driven update tracking
//! (stage 2b contract B5). Bounded by construction: at most one update is in
//! flight per view; while a view has not acked, later dirty rectangles are
//! coalesced into a single pending region (latest pixels win), never queued.

pub const MAX_DESKTOP_WIDTH: u32 = 3840;
pub const MAX_DESKTOP_HEIGHT: u32 = 2160;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    /// Smallest rectangle covering both `self` and `other`.
    pub fn union(self, other: Rect) -> Rect {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = self.x.saturating_add(self.w).max(other.x.saturating_add(other.w));
        let bottom = self.y.saturating_add(self.h).max(other.y.saturating_add(other.h));
        Rect { x, y, w: right - x, h: bottom - y }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FramebufferError(pub &'static str);

/// A software RGBA8 framebuffer owned by the engine. `frame_id` increments
/// once per applied update; `last_update_ms` is the timestamp of the last one.
pub struct Framebuffer {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    frame_id: u64,
    last_update_ms: u64,
}

impl Framebuffer {
    pub fn new(width: u32, height: u32) -> Result<Self, FramebufferError> {
        if width == 0 || height == 0 {
            return Err(FramebufferError("framebuffer must be at least 1x1"));
        }
        if width > MAX_DESKTOP_WIDTH || height > MAX_DESKTOP_HEIGHT {
            return Err(FramebufferError("desktop larger than 3840x2160"));
        }
        Ok(Framebuffer {
            width,
            height,
            pixels: vec![0u8; (width as usize) * (height as usize) * 4],
            frame_id: 0,
            last_update_ms: 0,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn frame_id(&self) -> u64 {
        self.frame_id
    }

    pub fn last_update_ms(&self) -> u64 {
        self.last_update_ms
    }

    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Copy `w * h * 4` RGBA bytes into the rectangle at (x, y), bump the frame
    /// id and record the timestamp. Rejects out-of-bounds rectangles.
    pub fn apply(
        &mut self,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
        rgba: &[u8],
        now_ms: u64,
    ) -> Result<(), FramebufferError> {
        let (Some(right), Some(bottom)) = (x.checked_add(w), y.checked_add(h)) else {
            return Err(FramebufferError("update rectangle overflows"));
        };
        if right > self.width || bottom > self.height {
            return Err(FramebufferError("update rectangle outside the framebuffer"));
        }
        let expected = (w as usize).saturating_mul(h as usize).saturating_mul(4);
        if rgba.len() != expected {
            return Err(FramebufferError("update payload has the wrong byte length"));
        }
        for row in 0..h as usize {
            let src_start = row * w as usize * 4;
            let dst_start = ((y as usize + row) * self.width as usize + x as usize) * 4;
            self.pixels[dst_start..dst_start + w as usize * 4]
                .copy_from_slice(&rgba[src_start..src_start + w as usize * 4]);
        }
        self.frame_id = self.frame_id.wrapping_add(1);
        self.last_update_ms = now_ms;
        Ok(())
    }

    /// Copy `rect` out of a whole-desktop RGBA image (`stride` bytes per row,
    /// `src_height` rows) into the framebuffer, bump the frame id and record the
    /// timestamp. Only the dirty rectangle is touched.
    pub fn apply_from_image(
        &mut self,
        rect: Rect,
        src: &[u8],
        stride: usize,
        now_ms: u64,
    ) -> Result<(), FramebufferError> {
        let (Some(right), Some(bottom)) = (rect.x.checked_add(rect.w), rect.y.checked_add(rect.h)) else {
            return Err(FramebufferError("update rectangle overflows"));
        };
        if rect.w == 0 || rect.h == 0 || right > self.width || bottom > self.height {
            return Err(FramebufferError("update rectangle outside the framebuffer"));
        }
        if stride != self.width as usize * 4 {
            return Err(FramebufferError("image stride does not match the framebuffer"));
        }
        let needed = (bottom as usize).saturating_mul(stride);
        if src.len() < needed {
            return Err(FramebufferError("image is smaller than the framebuffer"));
        }
        let row_bytes = rect.w as usize * 4;
        for row in 0..rect.h as usize {
            let start = (rect.y as usize + row) * stride + rect.x as usize * 4;
            self.pixels[start..start + row_bytes].copy_from_slice(&src[start..start + row_bytes]);
        }
        self.frame_id = self.frame_id.wrapping_add(1);
        self.last_update_ms = now_ms;
        Ok(())
    }

    /// Copy the RGBA bytes of a rectangle into `out` (row-major), clamped to the
    /// framebuffer bounds. Returns the clamped rectangle actually copied.
    pub fn copy_region(&self, x: u32, y: u32, w: u32, h: u32, out: &mut Vec<u8>) -> Rect {
        let x2 = x.min(self.width);
        let y2 = y.min(self.height);
        let w = x.saturating_add(w).min(self.width) - x2;
        let h = y.saturating_add(h).min(self.height) - y2;
        out.clear();
        out.reserve((w as usize) * (h as usize) * 4);
        for row in 0..h as usize {
            let start = ((y2 as usize + row) * self.width as usize + x2 as usize) * 4;
            out.extend_from_slice(&self.pixels[start..start + w as usize * 4]);
        }
        Rect { x: x2, y: y2, w, h }
    }

    /// The RGBA value of a single pixel as `[r, g, b, a]`.
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y as usize) * self.width as usize + x as usize) * 4;
        [self.pixels[i], self.pixels[i + 1], self.pixels[i + 2], self.pixels[i + 3]]
    }
}

/// Ack-driven update tracking for ONE view. Invariant: at most one update in
/// flight; pending holds at most one coalesced region (never a list).
#[derive(Debug, Default)]
pub struct ViewUpdates {
    in_flight: bool,
    pending: Option<Rect>,
}

impl ViewUpdates {
    pub fn new() -> Self {
        ViewUpdates { in_flight: false, pending: None }
    }

    pub fn in_flight(&self) -> bool {
        self.in_flight
    }

    pub fn pending_region(&self) -> Option<Rect> {
        self.pending
    }

    /// A dirty rectangle arrived. Returns `Some(rect)` when the view may send
    /// an update for it now (nothing in flight), `None` when it was coalesced
    /// into the pending region because an update is already in flight.
    pub fn on_dirty(&mut self, rect: Rect) -> Option<Rect> {
        if !self.in_flight {
            self.in_flight = true;
            Some(rect)
        } else {
            self.pending = Some(match self.pending {
                Some(p) => p.union(rect),
                None => rect,
            });
            None
        }
    }

    /// The view acked its in-flight update. Returns `Some(rect)` when a pending
    /// region must now be sent, `None` when nothing is pending.
    pub fn on_ack(&mut self) -> Option<Rect> {
        self.in_flight = false;
        match self.pending.take() {
            Some(rect) => {
                self.in_flight = true;
                Some(rect)
            }
            None => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fill_rect(fb: &mut Framebuffer, x: u32, y: u32, w: u32, h: u32, rgba: [u8; 4], now: u64) {
        let mut data = vec![0u8; (w as usize) * (h as usize) * 4];
        for px in data.chunks_exact_mut(4) {
            px.copy_from_slice(&rgba);
        }
        fb.apply(x, y, w, h, &data, now).unwrap();
    }

    #[test]
    fn rejects_oversized_desktop() {
        assert!(Framebuffer::new(3841, 2160).is_err());
        assert!(Framebuffer::new(3840, 2161).is_err());
        assert!(Framebuffer::new(3840, 2160).is_ok());
    }

    #[test]
    fn arithmetic_is_checked_not_panicking() {
        let mut fb = Framebuffer::new(100, 100).unwrap();
        // x + w overflows u32
        assert!(fb.apply(u32::MAX, 0, 2, 1, &[0u8; 8], 1).is_err());
        assert!(fb.apply(0, u32::MAX, 1, 2, &[0u8; 8], 1).is_err());
        let mut out = Vec::new();
        let r = fb.copy_region(u32::MAX, u32::MAX, u32::MAX, u32::MAX, &mut out);
        assert_eq!((r.w, r.h), (0, 0));
        assert!(out.is_empty());
        let r = Rect { x: u32::MAX, y: 0, w: 2, h: 1 }.union(Rect { x: 0, y: 0, w: 1, h: 1 });
        assert_eq!(r.x, 0);
    }

    #[test]
    fn apply_from_image_copies_only_the_dirty_rectangle() {
        let mut fb = Framebuffer::new(4, 3).unwrap();
        // 4x3 image whose pixel (x, y) has red = 10 * y + x
        let mut img = vec![0u8; 4 * 3 * 4];
        for y in 0..3usize {
            for x in 0..4usize {
                img[(y * 4 + x) * 4] = (10 * y + x) as u8;
                img[(y * 4 + x) * 4 + 3] = 255;
            }
        }
        fb.apply_from_image(Rect { x: 1, y: 1, w: 2, h: 1 }, &img, 16, 7).unwrap();
        assert_eq!(fb.pixel(1, 1), [11, 0, 0, 255]);
        assert_eq!(fb.pixel(2, 1), [12, 0, 0, 255]);
        assert_eq!(fb.pixel(0, 1), [0, 0, 0, 0]); // outside the rectangle
        assert_eq!(fb.pixel(1, 0), [0, 0, 0, 0]);
        assert_eq!(fb.frame_id(), 1);
        assert_eq!(fb.last_update_ms(), 7);
        assert!(fb.apply_from_image(Rect { x: 3, y: 0, w: 2, h: 1 }, &img, 16, 8).is_err());
        assert!(fb.apply_from_image(Rect { x: 0, y: 0, w: 1, h: 1 }, &img, 12, 8).is_err());
        // rows 0..=2 need 48 bytes; 40 are not enough
        assert!(fb.apply_from_image(Rect { x: 0, y: 2, w: 1, h: 1 }, &img[..40], 16, 8).is_err());
    }

    #[test]
    fn rejects_out_of_bounds_and_wrong_length_updates() {
        let mut fb = Framebuffer::new(100, 100).unwrap();
        assert!(fb.apply(90, 0, 20, 10, &vec![0u8; 20 * 10 * 4], 1).is_err());
        assert!(fb.apply(0, 0, 10, 10, &vec![0u8; 10 * 10 * 4 - 1], 1).is_err());
    }

    #[test]
    fn coalescing_two_rects_gives_the_literal_bounding_rect_and_latest_pixels() {
        let mut fb = Framebuffer::new(100, 100).unwrap();
        let red = [255, 0, 0, 255];
        let green = [0, 255, 0, 255];
        let blue = [0, 0, 255, 255];

        let mut view = ViewUpdates::new();
        // First dirty rect goes in flight immediately.
        assert_eq!(view.on_dirty(Rect { x: 0, y: 0, w: 10, h: 10 }), Some(Rect { x: 0, y: 0, w: 10, h: 10 }));
        fill_rect(&mut fb, 0, 0, 10, 10, red, 1);

        // Two more rects arrive while the view has not acked: they coalesce
        // into one pending region (the literal bounding box), never a list.
        assert_eq!(view.on_dirty(Rect { x: 5, y: 5, w: 10, h: 10 }), None);
        fill_rect(&mut fb, 5, 5, 10, 10, green, 2);
        assert_eq!(view.on_dirty(Rect { x: 20, y: 20, w: 5, h: 5 }), None);
        fill_rect(&mut fb, 20, 20, 5, 5, blue, 3);

        // Bounding box of (5,5,10,10) and (20,20,5,5) is (5,5,20,20).
        assert_eq!(view.pending_region(), Some(Rect { x: 5, y: 5, w: 20, h: 20 }));

        // Latest pixels win: the overlap of rects 1 and 2 keeps the second
        // colour; the third rect keeps its own.
        assert_eq!(fb.pixel(0, 0), red); // only the first rect covered it
        assert_eq!(fb.pixel(5, 5), green); // second rect overwrote the first
        assert_eq!(fb.pixel(20, 20), blue); // third rect
        assert_eq!(fb.pixel(24, 24), blue);
        assert_eq!(fb.pixel(14, 14), green);
    }

    #[test]
    fn an_unacked_view_receives_exactly_one_update_however_many_server_updates_arrive() {
        let mut view = ViewUpdates::new();
        let rects = [
            Rect { x: 0, y: 0, w: 10, h: 10 },
            Rect { x: 1, y: 1, w: 10, h: 10 },
            Rect { x: 2, y: 2, w: 10, h: 10 },
            Rect { x: 3, y: 3, w: 10, h: 10 },
            Rect { x: 4, y: 4, w: 10, h: 10 },
            Rect { x: 5, y: 5, w: 10, h: 10 },
        ];
        let sent: Vec<Rect> = rects.iter().filter_map(|&r| view.on_dirty(r)).collect();
        // Exactly one update was released; the rest were coalesced.
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0], rects[0]);
        // The pending structure holds ONE region, the bounding box of the rest.
        assert_eq!(view.pending_region(), Some(Rect { x: 1, y: 1, w: 14, h: 14 }));

        // Ack releases the single pending region, which becomes the next in-flight.
        assert_eq!(view.on_ack(), Some(Rect { x: 1, y: 1, w: 14, h: 14 }));
        assert!(view.in_flight());
        assert_eq!(view.pending_region(), None);
        // A further ack releases nothing.
        assert_eq!(view.on_ack(), None);
        assert!(!view.in_flight());
    }

    #[test]
    fn frame_id_increments_per_update_and_timestamp_is_recorded() {
        let mut fb = Framebuffer::new(10, 10).unwrap();
        assert_eq!(fb.frame_id(), 0);
        fill_rect(&mut fb, 0, 0, 2, 2, [9, 8, 7, 6], 42);
        assert_eq!(fb.frame_id(), 1);
        assert_eq!(fb.last_update_ms(), 42);
        fill_rect(&mut fb, 1, 1, 2, 2, [1, 2, 3, 4], 43);
        assert_eq!(fb.frame_id(), 2);
        assert_eq!(fb.last_update_ms(), 43);
    }
}
