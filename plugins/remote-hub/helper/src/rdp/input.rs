//! Input message types and validation (stage 2b contract B6). Input arrives as
//! control messages from the helper, already validated for framing; this module
//! enforces the contract's geometry and coordinate rules and then hands
//! validated events to the engine for FastPath encoding.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputError {
    /// The message was computed against a different framebuffer geometry.
    StaleGeometry,
    /// A coordinate lies outside the current framebuffer.
    OutOfBounds,
    /// A scancode outside the supported key table.
    InvalidScancode,
    /// An unknown mouse button name.
    InvalidButton,
}

impl InputError {
    pub fn as_str(self) -> &'static str {
        match self {
            InputError::StaleGeometry => "stale_geometry",
            InputError::OutOfBounds => "out_of_bounds",
            InputError::InvalidScancode => "invalid_scancode",
            InputError::InvalidButton => "invalid_button",
        }
    }
}

/// The framebuffer geometry an input message was computed against (B6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PointerPosition {
    pub x: u32,
    pub y: u32,
}

/// Validate a pointer event whose coordinates were computed against `geom`
/// against the current framebuffer `fb`. A geometry mismatch is dropped with
/// `stale_geometry`; coordinates outside the framebuffer are rejected.
pub fn validate_pointer(geom: Geometry, fb: Geometry, pos: PointerPosition) -> Result<(), InputError> {
    if geom != fb {
        return Err(InputError::StaleGeometry);
    }
    if pos.x >= fb.width || pos.y >= fb.height {
        return Err(InputError::OutOfBounds);
    }
    Ok(())
}

/// The set-1 scancodes the engine accepts (mirrors src/core/rdp-keys.ts):
/// 0x01..=0x58 plain, and 0x01..=0x58 plus 0x5B (MetaLeft), 0x5C (MetaRight)
/// and 0x5D (ContextMenu) with the extended (E0) flag.
pub fn valid_key(code: u8, extended: bool) -> bool {
    (0x01..=0x58).contains(&code) || (extended && (0x5B..=0x5D).contains(&code))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FB: Geometry = Geometry { width: 100, height: 100 };

    #[test]
    fn geometry_mismatch_is_stale() {
        let other = Geometry { width: 99, height: 100 };
        assert_eq!(
            validate_pointer(other, FB, PointerPosition { x: 0, y: 0 }),
            Err(InputError::StaleGeometry)
        );
        let other2 = Geometry { width: 100, height: 99 };
        assert_eq!(
            validate_pointer(other2, FB, PointerPosition { x: 0, y: 0 }),
            Err(InputError::StaleGeometry)
        );
    }

    #[test]
    fn coordinates_outside_the_framebuffer_are_rejected() {
        assert_eq!(
            validate_pointer(FB, FB, PointerPosition { x: 100, y: 0 }),
            Err(InputError::OutOfBounds)
        );
        assert_eq!(
            validate_pointer(FB, FB, PointerPosition { x: 0, y: 100 }),
            Err(InputError::OutOfBounds)
        );
        assert_eq!(validate_pointer(FB, FB, PointerPosition { x: 99, y: 99 }), Ok(()));
        assert_eq!(validate_pointer(FB, FB, PointerPosition { x: 0, y: 0 }), Ok(()));
    }

    #[test]
    fn scancode_range_matches_the_supported_table() {
        assert!(valid_key(0x01, false));
        assert!(valid_key(0x58, false));
        assert!(!valid_key(0x59, false));
        assert!(!valid_key(0xff, false));
        assert!(!valid_key(0, false));
        assert!(!valid_key(0, true));
        // Windows keys and the context menu are extended-only.
        for code in [0x5B, 0x5C, 0x5D] {
            assert!(valid_key(code, true), "{code:#x} extended");
            assert!(!valid_key(code, false), "{code:#x} plain");
        }
        assert!(!valid_key(0x5A, true));
        assert!(!valid_key(0x5E, true));
    }
}
