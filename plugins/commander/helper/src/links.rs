//! Link classification for symlink/hardlink entries: links are never extracted (S14 spec §5.4).

/// `link_escapes` when the target resolves outside the extraction root, else `link_not_supported`.
/// A symlink target is resolved from the directory of the entry, a hardlink target from the archive root.
pub fn classify(name: &[u8], target: &[u8], hard: bool) -> &'static str {
    if escapes(name, target, hard) {
        "link_escapes"
    } else {
        "link_not_supported"
    }
}

fn escapes(name: &[u8], target: &[u8], hard: bool) -> bool {
    if target.is_empty() || target[0] == b'/' || target.contains(&b'\\') {
        return true;
    }
    if target.len() >= 2 && target[0].is_ascii_alphabetic() && target[1] == b':' {
        return true;
    }
    let mut depth: i64 = if hard { 0 } else { name.strip_suffix(b"/").unwrap_or(name).split(|b| *b == b'/').count() as i64 - 1 };
    for seg in target.split(|b| *b == b'/') {
        match seg {
            b"" | b"." => {}
            b".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            _ => depth += 1,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::classify as classify_link;

    fn classify(name: &[u8], target: &[u8]) -> &'static str {
        classify_link(name, target, false)
    }

    #[test]
    fn links_are_classified_by_where_their_target_resolves() {
        assert_eq!(classify(b"out", b"../../etc/passwd"), "link_escapes");
        assert_eq!(classify(b"d/l", b"../x"), "link_not_supported");
        assert_eq!(classify(b"d/l", b"../../x"), "link_escapes");
        assert_eq!(classify(b"l", b"/etc/passwd"), "link_escapes");
        assert_eq!(classify(b"l", b"C:\\x"), "link_escapes");
        assert_eq!(classify(b"l", b"a/b"), "link_not_supported");
        assert_eq!(classify(b"l", b""), "link_escapes");
        assert_eq!(classify(b"a/b/l", b"../../.."), "link_escapes");
        assert_eq!(classify(b"a/b/l", b"../.."), "link_not_supported");
    }

    #[test]
    fn a_hardlink_target_counts_from_the_archive_root() {
        // The same name and target: a symlink at d/l reaches d/../x = x (inside); a hardlink names x from the root, so ../x is outside.
        assert_eq!(classify_link(b"d/l", b"../x", false), "link_not_supported");
        assert_eq!(classify_link(b"d/l", b"../x", true), "link_escapes");
        assert_eq!(classify_link(b"d/l", b"x/../y", true), "link_not_supported");
        assert_eq!(classify_link(b"d/l", b"a/b", true), "link_not_supported");
        assert_eq!(classify_link(b"d/l", b"..", true), "link_escapes");
    }
}
