//! Turns validated client input events into IronRDP FastPath input events.
//! Pure (no I/O): the produced events are compared with literals in the tests.
use ironrdp_pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp_pdu::input::mouse::{MousePdu, PointerFlags};

use super::input::{valid_key, validate_pointer, Geometry, InputError, PointerPosition};
use super::protocol::{InputEvent, InputRejection};

#[derive(Debug, PartialEq, Eq)]
pub struct Encoded {
    pub events: Vec<FastPathInputEvent>,
    /// Events that were refused; the rest of the batch is still applied.
    pub rejected: Vec<InputRejection>,
    /// Number of input events of the batch that were accepted.
    pub applied: u32,
}

fn mouse(flags: PointerFlags, wheel: i16, x: u32, y: u32) -> FastPathInputEvent {
    FastPathInputEvent::MouseEvent(MousePdu {
        flags,
        number_of_wheel_rotation_units: wheel,
        x_position: x as u16,
        y_position: y as u16,
    })
}

fn check_pointer(fb: Geometry, geom_w: u32, geom_h: u32, x: u32, y: u32) -> Result<(), InputError> {
    validate_pointer(Geometry { width: geom_w, height: geom_h }, fb, PointerPosition { x, y })
}

fn encode_one(event: &InputEvent, fb: Geometry, out: &mut Vec<FastPathInputEvent>) -> Result<(), InputError> {
    match event {
        InputEvent::MouseMove { x, y, geom_width, geom_height } => {
            check_pointer(fb, *geom_width, *geom_height, *x, *y)?;
            out.push(mouse(PointerFlags::MOVE, 0, *x, *y));
        }
        InputEvent::MouseButton { button, down, x, y, geom_width, geom_height } => {
            check_pointer(fb, *geom_width, *geom_height, *x, *y)?;
            let mut flags = match button.as_str() {
                "left" => PointerFlags::LEFT_BUTTON,
                "right" => PointerFlags::RIGHT_BUTTON,
                "middle" => PointerFlags::MIDDLE_BUTTON_OR_WHEEL,
                _ => return Err(InputError::InvalidButton),
            };
            if *down {
                flags |= PointerFlags::DOWN;
            }
            out.push(mouse(flags, 0, *x, *y));
        }
        InputEvent::MouseWheel { vertical, horizontal, x, y, geom_width, geom_height } => {
            check_pointer(fb, *geom_width, *geom_height, *x, *y)?;
            for (amount, axis) in [(*vertical, PointerFlags::VERTICAL_WHEEL), (*horizontal, PointerFlags::HORIZONTAL_WHEEL)] {
                if amount != 0 {
                    let mut flags = axis;
                    if amount < 0 {
                        flags |= PointerFlags::WHEEL_NEGATIVE;
                    }
                    out.push(mouse(flags, amount.clamp(-256, 255), *x, *y));
                }
            }
        }
        InputEvent::Key { scancode, extended, down } => {
            if !valid_key(*scancode, *extended) {
                return Err(InputError::InvalidScancode);
            }
            let mut flags = KeyboardFlags::empty();
            if !*down {
                flags |= KeyboardFlags::RELEASE;
            }
            if *extended {
                flags |= KeyboardFlags::EXTENDED;
            }
            out.push(FastPathInputEvent::KeyboardEvent(flags, *scancode));
        }
        InputEvent::CtrlAltDel => {
            out.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::empty(), 0x1D));
            out.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::empty(), 0x38));
            out.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::EXTENDED, 0x53));
            out.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::EXTENDED | KeyboardFlags::RELEASE, 0x53));
            out.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::RELEASE, 0x38));
            out.push(FastPathInputEvent::KeyboardEvent(KeyboardFlags::RELEASE, 0x1D));
        }
        InputEvent::Unicode { text } => {
            // One press and one release per UTF-16 code unit; characters above
            // U+FFFF become a surrogate pair, each unit pressed and released.
            for unit in text.encode_utf16() {
                out.push(FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::empty(), unit));
                out.push(FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::RELEASE, unit));
            }
        }
    }
    Ok(())
}

/// Encode a batch against the current framebuffer geometry. A rejected event
/// is reported with its index and a stable code; the remaining events are
/// still encoded.
pub fn encode_input(events: &[InputEvent], fb: Geometry) -> Encoded {
    let mut out = Vec::new();
    let mut rejected = Vec::new();
    let mut applied = 0u32;
    for (index, event) in events.iter().enumerate() {
        let before = out.len();
        match encode_one(event, fb, &mut out) {
            Ok(()) => applied += 1,
            Err(e) => {
                out.truncate(before);
                rejected.push(InputRejection { index: index as u32, code: e.as_str().to_string() });
            }
        }
    }
    Encoded { events: out, rejected, applied }
}

/// Collapse every run of consecutive plain mouse moves to its last position
/// (mouse moves are coalesced to the latest while the engine is busy). Any
/// other event ends a run, so ordering with clicks and keys is preserved.
pub fn coalesce_moves(events: Vec<FastPathInputEvent>) -> Vec<FastPathInputEvent> {
    let is_move = |e: &FastPathInputEvent| matches!(e, FastPathInputEvent::MouseEvent(m) if m.flags == PointerFlags::MOVE);
    let mut out: Vec<FastPathInputEvent> = Vec::with_capacity(events.len());
    for event in events {
        if is_move(&event) && out.last().map(is_move).unwrap_or(false) {
            out.pop();
        }
        out.push(event);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FB: Geometry = Geometry { width: 100, height: 100 };

    fn key(scancode: u8, extended: bool, down: bool) -> InputEvent {
        InputEvent::Key { scancode, extended, down }
    }

    fn mv(x: u32, y: u32, w: u32, h: u32) -> InputEvent {
        InputEvent::MouseMove { x, y, geom_width: w, geom_height: h }
    }

    #[test]
    fn plain_and_extended_keys_encode_with_literal_flags() {
        let e = encode_input(&[key(0x1E, false, true), key(0x1E, false, false), key(0x5B, true, true)], FB);
        assert_eq!(
            e.events,
            vec![
                FastPathInputEvent::KeyboardEvent(KeyboardFlags::empty(), 0x1E),
                FastPathInputEvent::KeyboardEvent(KeyboardFlags::RELEASE, 0x1E),
                FastPathInputEvent::KeyboardEvent(KeyboardFlags::EXTENDED, 0x5B),
            ]
        );
        assert_eq!(e.applied, 3);
        assert!(e.rejected.is_empty());
    }

    #[test]
    fn windows_and_menu_keys_are_accepted_only_extended() {
        for code in [0x5B, 0x5C, 0x5D] {
            let e = encode_input(&[key(code, true, true)], FB);
            assert_eq!(e.applied, 1, "{code:#x}");
            let e = encode_input(&[key(code, false, true)], FB);
            assert_eq!(e.rejected, vec![InputRejection { index: 0, code: "invalid_scancode".into() }]);
        }
    }

    /// A rejected event does not drop the rest of the batch, and the rejection
    /// names its index and a stable code.
    #[test]
    fn a_rejected_event_does_not_drop_the_rest_of_the_batch() {
        let batch = [
            key(0x1E, false, true),    // 0 ok
            key(0x70, false, true),    // 1 invalid scancode
            mv(5, 5, 99, 100),         // 2 stale geometry
            mv(100, 5, 100, 100),      // 3 out of bounds
            InputEvent::MouseButton { button: "side".into(), down: true, x: 1, y: 1, geom_width: 100, geom_height: 100 }, // 4 invalid button
            key(0x1E, false, false),   // 5 ok
        ];
        let e = encode_input(&batch, FB);
        assert_eq!(
            e.events,
            vec![
                FastPathInputEvent::KeyboardEvent(KeyboardFlags::empty(), 0x1E),
                FastPathInputEvent::KeyboardEvent(KeyboardFlags::RELEASE, 0x1E),
            ]
        );
        assert_eq!(e.applied, 2);
        assert_eq!(
            e.rejected,
            vec![
                InputRejection { index: 1, code: "invalid_scancode".into() },
                InputRejection { index: 2, code: "stale_geometry".into() },
                InputRejection { index: 3, code: "out_of_bounds".into() },
                InputRejection { index: 4, code: "invalid_button".into() },
            ]
        );
    }

    #[test]
    fn unicode_is_press_and_release_per_utf16_unit() {
        let e = encode_input(&[InputEvent::Unicode { text: "aé".into() }], FB);
        assert_eq!(
            e.events,
            vec![
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::empty(), 0x0061),
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::RELEASE, 0x0061),
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::empty(), 0x00E9),
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::RELEASE, 0x00E9),
            ]
        );
    }

    /// U+1F600 is the surrogate pair D83D DE00.
    #[test]
    fn non_bmp_unicode_becomes_a_surrogate_pair() {
        let e = encode_input(&[InputEvent::Unicode { text: "\u{1F600}".into() }], FB);
        assert_eq!(
            e.events,
            vec![
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::empty(), 0xD83D),
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::RELEASE, 0xD83D),
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::empty(), 0xDE00),
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::RELEASE, 0xDE00),
            ]
        );
    }

    #[test]
    fn mouse_events_encode_with_literal_flags() {
        let e = encode_input(
            &[
                mv(10, 20, 100, 100),
                InputEvent::MouseButton { button: "left".into(), down: true, x: 10, y: 20, geom_width: 100, geom_height: 100 },
                InputEvent::MouseButton { button: "left".into(), down: false, x: 10, y: 20, geom_width: 100, geom_height: 100 },
                InputEvent::MouseWheel { vertical: -3, horizontal: 2, x: 10, y: 20, geom_width: 100, geom_height: 100 },
            ],
            FB,
        );
        assert_eq!(
            e.events,
            vec![
                mouse(PointerFlags::MOVE, 0, 10, 20),
                mouse(PointerFlags::LEFT_BUTTON | PointerFlags::DOWN, 0, 10, 20),
                mouse(PointerFlags::LEFT_BUTTON, 0, 10, 20),
                mouse(PointerFlags::VERTICAL_WHEEL | PointerFlags::WHEEL_NEGATIVE, -3, 10, 20),
                mouse(PointerFlags::HORIZONTAL_WHEEL, 2, 10, 20),
            ]
        );
    }

    #[test]
    fn mouse_moves_coalesce_to_the_latest_and_keep_ordering() {
        let m = |x| mouse(PointerFlags::MOVE, 0, x, 0);
        let click = mouse(PointerFlags::LEFT_BUTTON | PointerFlags::DOWN, 0, 3, 0);
        let k = FastPathInputEvent::KeyboardEvent(KeyboardFlags::empty(), 0x1E);
        let out = coalesce_moves(vec![m(1), m(2), m(3), click, m(4), m(5), k, m(6)]);
        assert_eq!(out, vec![m(3), click, m(5), k, m(6)]);
        // a lone move and a non-move run are untouched
        assert_eq!(coalesce_moves(vec![m(9)]), vec![m(9)]);
        assert_eq!(coalesce_moves(vec![k, k]), vec![k, k]);
        assert!(coalesce_moves(vec![]).is_empty());
    }

    #[test]
    fn ctrl_alt_del_is_six_literal_events() {
        let e = encode_input(&[InputEvent::CtrlAltDel], FB);
        assert_eq!(
            e.events,
            vec![
                FastPathInputEvent::KeyboardEvent(KeyboardFlags::empty(), 0x1D),
                FastPathInputEvent::KeyboardEvent(KeyboardFlags::empty(), 0x38),
                FastPathInputEvent::KeyboardEvent(KeyboardFlags::EXTENDED, 0x53),
                FastPathInputEvent::KeyboardEvent(KeyboardFlags::EXTENDED | KeyboardFlags::RELEASE, 0x53),
                FastPathInputEvent::KeyboardEvent(KeyboardFlags::RELEASE, 0x38),
                FastPathInputEvent::KeyboardEvent(KeyboardFlags::RELEASE, 0x1D),
            ]
        );
    }
}
