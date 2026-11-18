//! The PVE terminal websocket protocol (docs/pve-consoles.md §1.1, from pve-xtermjs `termproxy`):
//! a first line `user:ticket\n`, the answer `OK`, then framed client messages
//! (`0:<len>:<bytes>` data, `1:<cols>:<rows>:` resize, `2` ping) and raw bytes back.

/// Client data larger than this is split into several `0:` messages.
pub const MAX_DATA_FRAME: usize = 4096;
/// The ping message.
pub const PING: &[u8] = b"2";

pub fn ticket_line(user: &str, ticket: &str) -> Vec<u8> {
    format!("{user}:{ticket}\n").into_bytes()
}

pub fn encode_resize(cols: u16, rows: u16) -> Vec<u8> {
    format!("1:{cols}:{rows}:").into_bytes()
}

/// One or more `0:<len>:` messages carrying `data`. Empty data produces none.
pub fn encode_input(data: &[u8]) -> Vec<Vec<u8>> {
    data.chunks(MAX_DATA_FRAME)
        .map(|chunk| {
            let mut m = format!("0:{}:", chunk.len()).into_bytes();
            m.extend_from_slice(chunk);
            m
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Gate {
    /// More bytes are needed to decide.
    NeedMore,
    /// `OK` was seen; the rest of the buffer is already console output.
    Open(Vec<u8>),
    /// The first bytes are not `OK`: the server refused the ticket (or is not termproxy).
    Refused,
}

/// Recognises the server's `OK` at the start of the stream, however the bytes are split, and hands back
/// whatever followed it in the same message.
#[derive(Default)]
pub struct OkGate {
    buf: Vec<u8>,
}

impl OkGate {
    pub fn feed(&mut self, bytes: &[u8]) -> Gate {
        self.buf.extend_from_slice(bytes);
        let n = self.buf.len().min(2);
        if self.buf[..n] != b"OK"[..n] {
            return Gate::Refused;
        }
        if self.buf.len() < 2 {
            return Gate::NeedMore;
        }
        Gate::Open(self.buf[2..].to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_line_is_user_colon_ticket_newline() {
        assert_eq!(ticket_line("remotehub@pve", "PVEVNC:ABC"), b"remotehub@pve:PVEVNC:ABC\n");
    }

    #[test]
    fn resize_literals() {
        assert_eq!(encode_resize(120, 40), b"1:120:40:");
    }

    #[test]
    fn input_is_length_prefixed_by_bytes_not_characters() {
        // "é" is two bytes in UTF-8.
        assert_eq!(encode_input("é".as_bytes()), vec![b"0:2:\xc3\xa9".to_vec()]);
        assert!(encode_input(b"").is_empty());
    }

    #[test]
    fn long_input_is_split_at_4096() {
        let data = vec![b'x'; 4096 + 5];
        let frames = encode_input(&data);
        assert_eq!(frames.len(), 2);
        assert!(frames[0].starts_with(b"0:4096:"));
        assert_eq!(frames[0].len(), 7 + 4096);
        assert_eq!(frames[1], b"0:5:xxxxx");
    }

    #[test]
    fn ok_gate_accepts_ok_alone_split_and_with_trailing_output() {
        let mut g = OkGate::default();
        assert_eq!(g.feed(b"OK"), Gate::Open(vec![]));
        let mut g = OkGate::default();
        assert_eq!(g.feed(b"O"), Gate::NeedMore);
        assert_eq!(g.feed(b"Kroot@h:~# "), Gate::Open(b"root@h:~# ".to_vec()));
        let mut g = OkGate::default();
        assert_eq!(g.feed(b"OKhello"), Gate::Open(b"hello".to_vec()));
    }

    #[test]
    fn ok_gate_refuses_anything_else() {
        assert_eq!(OkGate::default().feed(b"authentication request failed"), Gate::Refused);
        let mut g = OkGate::default();
        assert_eq!(g.feed(b"O"), Gate::NeedMore);
        assert_eq!(g.feed(b"x"), Gate::Refused);
    }
}
