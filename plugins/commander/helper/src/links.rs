//! Link classification for symlink/hardlink entries: links are never extracted (S14 spec §5.4).

/// `link_escapes` when the target resolves outside the extraction root, else `link_not_supported`.
pub fn classify(name: &[u8], target: &[u8]) -> &'static str {
    if escapes(name, target) {
        "link_escapes"
    } else {
        "link_not_supported"
    }
}

fn escapes(name: &[u8], target: &[u8]) -> bool {
    if target.is_empty() || target[0] == b'/' || target.contains(&b'\\') {
        return true;
    }
    if target.len() >= 2 && target[0].is_ascii_alphabetic() && target[1] == b':' {
        return true;
    }
    // Start from the directory that holds the link (hardlink targets are archive-relative, still checked the same way).
    let mut depth: i64 = name.strip_suffix(b"/").unwrap_or(name).split(|b| *b == b'/').count() as i64 - 1;
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
    use super::classify;

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
}
