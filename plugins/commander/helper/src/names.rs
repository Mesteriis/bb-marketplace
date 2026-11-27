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
