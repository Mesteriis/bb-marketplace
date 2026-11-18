//! The transport and experience options of one RDP connection (a connection setting, chosen by the owner, validated on both
//! sides of the engine socket). Everything here is something the pinned IronRDP really does:
//!  - `compression`: bulk compression is advertised in the Client Info PDU (RDP 5.0, 64 K history) and the session
//!    decompresses it (`ActiveStageBuilder.compression_type`);
//!  - `color_depth`: 32, 24 or 16 bits per pixel, advertised in the GCC core data and the Bitmap capability; the session
//!    decodes uncompressed and RLE bitmaps of those depths;
//!  - the six experience switches are the Client Info performance flags (hints: a server may ignore them).
//! No codecs and no graphics pipeline are involved.
use ironrdp_connector::BitmapConfig;
use ironrdp_pdu::rdp::capability_sets::BitmapCodecs;
use ironrdp_pdu::rdp::client_info::{CompressionType, PerformanceFlags};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RdpOptions {
    pub compression: bool,
    pub color_depth: u8,
    pub wallpaper: bool,
    pub full_window_drag: bool,
    pub menu_animations: bool,
    pub font_smoothing: bool,
    pub desktop_composition: bool,
    pub themes: bool,
}

impl Default for RdpOptions {
    /// "Balanced", the default for a VPN/WAN link: compression on, wallpaper, window drag and menu animations off.
    fn default() -> Self {
        RdpOptions { compression: true, color_depth: 32, wallpaper: false, full_window_drag: false, menu_animations: false, font_smoothing: true, desktop_composition: false, themes: true }
    }
}

impl RdpOptions {
    /// Closed set: anything but 16, 24 or 32 bits per pixel is refused.
    pub fn validate(&self) -> Result<(), &'static str> {
        if matches!(self.color_depth, 16 | 24 | 32) {
            Ok(())
        } else {
            Err("color depth must be 16, 24 or 32")
        }
    }

    /// Client Info performance flags: an effect that is OFF here becomes a DISABLE_* flag, ON becomes nothing (or the
    /// ENABLE_* flag for font smoothing and desktop composition).
    pub fn performance_flags(&self) -> PerformanceFlags {
        let mut f = PerformanceFlags::empty();
        if !self.wallpaper {
            f |= PerformanceFlags::DISABLE_WALLPAPER;
        }
        if !self.full_window_drag {
            f |= PerformanceFlags::DISABLE_FULLWINDOWDRAG;
        }
        if !self.menu_animations {
            f |= PerformanceFlags::DISABLE_MENUANIMATIONS;
        }
        if !self.themes {
            f |= PerformanceFlags::DISABLE_THEMING;
        }
        if self.font_smoothing {
            f |= PerformanceFlags::ENABLE_FONT_SMOOTHING;
        }
        if self.desktop_composition {
            f |= PerformanceFlags::ENABLE_DESKTOP_COMPOSITION;
        }
        f
    }

    pub fn compression_type(&self) -> Option<CompressionType> {
        self.compression.then_some(CompressionType::K64)
    }

    /// 32 bpp is IronRDP's own default (no override); 24 and 16 request that depth, with no codecs (so no surface commands).
    pub fn bitmap(&self) -> Option<BitmapConfig> {
        (self.color_depth != 32).then(|| BitmapConfig { lossy_compression: false, color_depth: u32::from(self.color_depth), codecs: BitmapCodecs(Vec::new()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_balanced() {
        let d = RdpOptions::default();
        assert_eq!((d.compression, d.color_depth, d.wallpaper, d.full_window_drag, d.menu_animations, d.font_smoothing, d.desktop_composition, d.themes), (true, 32, false, false, false, true, false, true));
    }

    /// Literal flag values of MS-RDPBCGR 2.2.1.11.1.1.1 (wallpaper 1, drag 2, animations 4, theming 8, font smoothing 0x80, composition 0x100).
    #[test]
    fn effects_map_to_the_literal_performance_flags() {
        let all_off = RdpOptions { compression: false, color_depth: 32, wallpaper: false, full_window_drag: false, menu_animations: false, font_smoothing: false, desktop_composition: false, themes: false };
        assert_eq!(all_off.performance_flags().bits(), 0x1 | 0x2 | 0x4 | 0x8);
        let all_on = RdpOptions { wallpaper: true, full_window_drag: true, menu_animations: true, font_smoothing: true, desktop_composition: true, themes: true, ..all_off };
        assert_eq!(all_on.performance_flags().bits(), 0x80 | 0x100);
        assert_eq!(RdpOptions::default().performance_flags().bits(), 0x1 | 0x2 | 0x4 | 0x80);
    }

    #[test]
    fn compression_is_rdp5_64k_only_when_on_and_depth_is_a_closed_set() {
        let mut o = RdpOptions::default();
        assert_eq!(o.compression_type().map(|c| c.as_u8()), Some(1));
        o.compression = false;
        assert!(o.compression_type().is_none());
        for ok in [16u8, 24, 32] {
            o.color_depth = ok;
            assert!(o.validate().is_ok());
        }
        for bad in [0u8, 8, 15, 31, 33, 255] {
            o.color_depth = bad;
            assert!(o.validate().is_err(), "{bad}");
        }
    }

    #[test]
    fn a_requested_depth_other_than_32_is_passed_to_the_connector_with_no_codecs() {
        let mut o = RdpOptions::default();
        assert!(o.bitmap().is_none());
        o.color_depth = 16;
        let b = o.bitmap().unwrap();
        assert_eq!((b.color_depth, b.lossy_compression, b.codecs.0.len()), (16, false, 0));
        o.color_depth = 24;
        assert_eq!(o.bitmap().unwrap().color_depth, 24);
    }

    #[test]
    fn unknown_fields_and_wrong_types_are_refused_on_the_wire() {
        let ok = r#"{"compression":true,"colorDepth":16,"wallpaper":false,"fullWindowDrag":false,"menuAnimations":false,"fontSmoothing":true,"desktopComposition":false,"themes":true}"#;
        assert!(serde_json::from_str::<RdpOptions>(ok).is_ok());
        assert!(serde_json::from_str::<RdpOptions>(&ok.replace("}", ",\"flags\":4}")).is_err());
        assert!(serde_json::from_str::<RdpOptions>(&ok.replace("\"colorDepth\":16", "\"colorDepth\":\"16\"")).is_err());
        assert!(serde_json::from_str::<RdpOptions>(&ok.replace(",\"themes\":true", "")).is_err());
    }
}
