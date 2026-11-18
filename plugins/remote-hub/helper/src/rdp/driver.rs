//! Who may drive an RDP session, decided INSIDE the engine process (stage 4b-1, A2).
//!
//! The helper process queues input and puts it on the pipe to the engine; whatever is already on that pipe when the
//! driver changes cannot be recalled from the helper's side. So every input command carries the driver generation it
//! was queued under, and the engine drops a command whose generation is not the current one. The engine also notes
//! which keys and buttons it APPLIED and still holds down; on a change of driver it releases exactly those, against
//! ITS framebuffer at that moment (a resize between the press and the handover moves the position inside the desktop),
//! and answers with the count: the barrier the helper waits for before it tells the next driver to go ahead.
//! What remains is what the engine already wrote to the server's socket: it cannot be taken back.
use super::protocol::InputEvent;

#[derive(Debug, Default)]
pub struct Driver {
    generation: u64,
    keys: Vec<(u8, bool)>,
    buttons: Vec<(String, u32, u32)>,
}

impl Driver {
    /// Keys and buttons currently held down by what was applied (for tests).
    pub fn held(&self) -> usize {
        self.keys.len() + self.buttons.len()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// True when input queued under `generation` may still be applied.
    pub fn accepts(&self, generation: u64) -> bool {
        generation == self.generation
    }

    /// Notes what the applied (not rejected) events left pressed. `rejected` holds the indexes the encoder refused.
    pub fn applied(&mut self, events: &[InputEvent], rejected: &[u32]) {
        for (index, event) in events.iter().enumerate() {
            if rejected.contains(&(index as u32)) {
                continue;
            }
            match event {
                InputEvent::Key { scancode, extended, down } => {
                    self.keys.retain(|k| *k != (*scancode, *extended));
                    if *down {
                        self.keys.push((*scancode, *extended));
                    }
                }
                InputEvent::MouseButton { button, down, x, y, .. } => {
                    self.buttons.retain(|b| b.0 != *button);
                    if *down {
                        self.buttons.push((button.clone(), *x, *y));
                    }
                }
                _ => {}
            }
        }
    }

    /// A new driver: the generation moves on and what the old one left down is returned as release events for a
    /// desktop of `fb` pixels (positions clamped into it).
    pub fn hand_over(&mut self, generation: u64, fb: (u32, u32)) -> Vec<InputEvent> {
        self.generation = generation;
        let mut release = Vec::new();
        for (scancode, extended) in self.keys.drain(..) {
            release.push(InputEvent::Key { scancode, extended, down: false });
        }
        let (w, h) = fb;
        for (button, x, y) in self.buttons.drain(..) {
            release.push(InputEvent::MouseButton {
                button,
                down: false,
                x: x.min(w.saturating_sub(1)),
                y: y.min(h.saturating_sub(1)),
                geom_width: w,
                geom_height: h,
            });
        }
        release
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(scancode: u8, down: bool) -> InputEvent {
        InputEvent::Key { scancode, extended: false, down }
    }
    fn button(name: &str, down: bool, x: u32, y: u32) -> InputEvent {
        InputEvent::MouseButton { button: name.into(), down, x, y, geom_width: 800, geom_height: 600 }
    }

    #[test]
    fn only_the_current_generation_is_accepted() {
        let mut d = Driver::default();
        assert!(d.accepts(0));
        d.hand_over(3, (800, 600));
        assert!(!d.accepts(0) && !d.accepts(2) && d.accepts(3));
    }

    #[test]
    fn a_handover_releases_exactly_what_was_applied_and_still_down() {
        let mut d = Driver::default();
        d.applied(&[key(0x1d, true), key(0x2a, true), key(0x2a, false), button("left", true, 700, 500)], &[]);
        let released = d.hand_over(1, (800, 600));
        assert_eq!(released.len(), 2);
        assert!(matches!(released[0], InputEvent::Key { scancode: 0x1d, down: false, .. }));
        assert!(matches!(&released[1], InputEvent::MouseButton { button, down: false, x: 700, y: 500, .. } if button == "left"));
        assert!(d.hand_over(2, (800, 600)).is_empty(), "nothing is released twice");
    }

    #[test]
    fn rejected_events_were_never_applied_so_they_are_never_released() {
        let mut d = Driver::default();
        d.applied(&[key(0x10, true), key(0x11, true)], &[1]);
        let released = d.hand_over(1, (800, 600));
        assert_eq!(released.len(), 1);
        assert!(matches!(released[0], InputEvent::Key { scancode: 0x10, .. }));
    }

    #[test]
    fn a_button_pressed_before_a_resize_is_released_inside_the_new_smaller_desktop() {
        let mut d = Driver::default();
        d.applied(&[button("right", true, 1900, 1000)], &[]);
        let released = d.hand_over(1, (1024, 768));
        match &released[0] {
            InputEvent::MouseButton { x, y, geom_width, geom_height, .. } => {
                assert_eq!((*x, *y, *geom_width, *geom_height), (1023, 767, 1024, 768));
            }
            other => panic!("{other:?}"),
        }
    }
}
