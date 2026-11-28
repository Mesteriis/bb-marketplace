//! Entry-name checks (S14 spec §5.4). Names are raw bytes: archives allow non-UTF-8 names.

/// Why an entry is refused for extraction (`RefusedReason`, not an error code).
pub const UNSAFE_NAME: &str = "unsafe_name";
pub const BACKSLASH: &str = "backslash";
pub const NAME_ENCODING: &str = "name_encoding";

pub const MAX_NAME: usize = 4096;
pub const MAX_SEGMENT: usize = 255;

/// Returns the path segments or the refusal reason.
/// A single trailing `/` (directory marker) is allowed; everything else that is empty, `.`, `..`,
/// absolute, drive-like, UNC-like, backslashed, NUL, control or over-long is refused.
pub fn check_entry_name(raw: &[u8]) -> Result<Vec<Vec<u8>>, &'static str> {
    if raw.is_empty() {
        return Err(UNSAFE_NAME);
    }
    if raw.contains(&0) || raw.iter().any(|b| *b < 0x20) {
        return Err(UNSAFE_NAME);
    }
    if raw[0] == b'/' {
        return Err(UNSAFE_NAME);
    }
    // Drive letter ("C:..."), extended and UNC prefixes.
    if raw.len() >= 2 && raw[0].is_ascii_alphabetic() && raw[1] == b':' {
        return Err(UNSAFE_NAME);
    }
    if raw.starts_with(b"\\\\") {
        return Err(UNSAFE_NAME);
    }
    let body = raw.strip_suffix(b"/").unwrap_or(raw);
    if body.is_empty() {
        return Err(UNSAFE_NAME);
    }
    let mut segments: Vec<Vec<u8>> = Vec::new();
    for segment in body.split(|b| *b == b'/') {
        if segment.is_empty() || segment == b"." || segment == b".." || segment.len() > MAX_SEGMENT {
            return Err(UNSAFE_NAME);
        }
        segments.push(segment.to_vec());
    }
    if raw.contains(&b'\\') {
        return Err(BACKSLASH);
    }
    if std::str::from_utf8(raw).is_err() {
        return Err(NAME_ENCODING);
    }
    Ok(segments)
}

/// Second line after `check_entry_name`: the library's `ZipFile::enclosed_name()` returned `None` for a name our
/// raw checks accepted. Such an entry is refused as `unsafe_name`; an entry already refused keeps its reason.
pub fn second_line(enclosed_is_none: bool, already: Option<&'static str>) -> Option<&'static str> {
    if already.is_some() { already } else if enclosed_is_none { Some(UNSAFE_NAME) } else { None }
}

/// Normalised key of a name for tree building; `None` when the name is refused.
pub fn tree_key(raw: &[u8]) -> Option<Vec<Vec<u8>>> {
    check_entry_name(raw).ok()
}

/// Display form: UTF-8 when valid, lossy otherwise.
pub fn display(raw: &[u8]) -> (String, bool) {
    match std::str::from_utf8(raw) {
        Ok(s) => (s.to_string(), false),
        Err(_) => (String::from_utf8_lossy(raw).into_owned(), true),
    }
}

const CP437_HIGH: [char; 128] = [
    'Ç','ü','é','â','ä','à','å','ç','ê','ë','è','ï','î','ì','Ä','Å',
    'É','æ','Æ','ô','ö','ò','û','ù','ÿ','Ö','Ü','¢','£','¥','₧','ƒ',
    'á','í','ó','ú','ñ','Ñ','ª','º','¿','⌐','¬','½','¼','¡','«','»',
    '░','▒','▓','│','┤','╡','╢','╖','╕','╣','║','╗','╝','╜','╛','┐',
    '└','┴','┬','├','─','┼','╞','╟','╚','╔','╩','╦','╠','═','╬','╧',
    '╨','╤','╥','╙','╘','╒','╓','╫','╪','┘','┌','█','▄','▌','▐','▀',
    'α','ß','Γ','π','Σ','σ','µ','τ','Φ','Θ','Ω','δ','∞','φ','ε','∩',
    '≡','±','≥','≤','⌠','⌡','÷','≈','°','∙','·','√','ⁿ','²','■','\u{a0}',
];

/// CP437 decoding for ZIP names without the UTF-8 flag (display only; raw bytes stay authoritative).
pub fn cp437(raw: &[u8]) -> String {
    raw.iter().map(|b| if *b < 0x80 { *b as char } else { CP437_HIGH[(*b - 0x80) as usize] }).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_library_check_refuses_what_ours_let_through_and_never_overrides_an_earlier_reason() {
        assert_eq!(super::second_line(true, None), Some("unsafe_name"));
        assert_eq!(super::second_line(true, Some("backslash")), Some("backslash"));
        assert_eq!(super::second_line(false, None), None);
        assert_eq!(super::second_line(false, Some("name_encoding")), Some("name_encoding"));
    }

    use super::*;

    #[test]
    fn hostile_names_are_refused_with_their_reason() {
        let refused: [(&[u8], &str); 12] = [
            (b"../x", UNSAFE_NAME),
            (b"/abs", UNSAFE_NAME),
            (b"C:\\x", UNSAFE_NAME),
            (b"a/../../b", UNSAFE_NAME),
            (b"a//b", UNSAFE_NAME),
            (b"a/./b", UNSAFE_NAME),
            (b"", UNSAFE_NAME),
            (b"/", UNSAFE_NAME),
            (b"a\\b", BACKSLASH),
            (b"a\0b", UNSAFE_NAME),
            (b"a\x01b", UNSAFE_NAME),
            (b"caf\x82.txt", NAME_ENCODING),
        ];
        for (name, reason) in refused {
            assert_eq!(check_entry_name(name), Err(reason), "{:?}", String::from_utf8_lossy(name));
        }
        assert_eq!(check_entry_name(&[b'a'; 256]), Err(UNSAFE_NAME));
        assert_eq!(check_entry_name(b"\\\\server\\share"), Err(UNSAFE_NAME));
    }

    #[test]
    fn plain_names_and_directory_markers_pass() {
        assert_eq!(check_entry_name(b"a/b/"), Ok(vec![b"a".to_vec(), b"b".to_vec()]));
        assert_eq!(check_entry_name(b"file.txt"), Ok(vec![b"file.txt".to_vec()]));
        assert_eq!(check_entry_name(&[b'a'; 255]).unwrap().len(), 1);
    }

    #[test]
    fn cp437_decodes_the_high_half() {
        assert_eq!(cp437(b"caf\x82.txt"), "café.txt");
    }
}
