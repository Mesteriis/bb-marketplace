//! The helper's bytes for one engine, kept as frames so input the previous driver left queued can be dropped at a hand-over
//! without cutting a frame in half: a frame the socket already took part of is finished, every later input frame is dropped,
//! control frames (resize, close, the owner barrier itself) always stay.
use std::collections::VecDeque;

const HEADER: usize = 5; // u32 length + kind byte

#[derive(Default)]
pub struct OutQueue {
    buf: VecDeque<u8>,
    /// Length (header included) and kind of every queued frame, in order.
    frames: VecDeque<(usize, bool)>,
    /// Bytes of the first frame the socket already took.
    head_written: usize,
}

impl OutQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    fn push(&mut self, frame: Vec<u8>, input: bool) {
        self.frames.push_back((frame.len(), input));
        self.buf.extend(frame);
    }

    pub fn push_control(&mut self, frame: Vec<u8>) {
        self.push(frame, false);
    }

    pub fn push_input(&mut self, frame: Vec<u8>) {
        self.push(frame, true);
    }

    /// The next contiguous bytes to write.
    pub fn front(&self) -> &[u8] {
        let (a, b) = self.buf.as_slices();
        if a.is_empty() {
            b
        } else {
            a
        }
    }

    /// `n` bytes of `front` were written.
    pub fn advance(&mut self, mut n: usize) {
        self.buf.drain(..n);
        while n > 0 {
            let Some(&(len, _)) = self.frames.front() else { break };
            let left = len - self.head_written;
            if n >= left {
                n -= left;
                self.frames.pop_front();
                self.head_written = 0;
            } else {
                self.head_written += n;
                n = 0;
            }
        }
    }

    pub fn clear(&mut self) {
        self.buf.clear();
        self.frames.clear();
        self.head_written = 0;
    }

    /// Drop every input frame the socket has not started. Returns the input bytes dropped (payload only).
    pub fn drop_unstarted_input(&mut self) -> u64 {
        let bytes: Vec<u8> = self.buf.drain(..).collect();
        let mut kept_frames = VecDeque::new();
        let mut kept = Vec::with_capacity(bytes.len());
        let (mut at, mut dropped) = (0usize, 0u64);
        for (i, &(len, input)) in self.frames.iter().enumerate() {
            let started = i == 0 && self.head_written > 0;
            // The buffer no longer holds the part of the first frame the socket took.
            let held = if started { len - self.head_written } else { len };
            if input && !started {
                dropped += (len - HEADER) as u64;
            } else {
                kept.extend_from_slice(&bytes[at..at + held]);
                kept_frames.push_back((len, input));
            }
            at += held;
        }
        self.buf = kept.into();
        self.frames = kept_frames;
        dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pve::protocol as proto;

    #[test]
    fn a_hand_over_drops_unstarted_input_and_keeps_control_and_the_started_frame() {
        let mut q = OutQueue::new();
        q.push_input(proto::encode_data(b"first"));
        q.push_control(proto::encode_control(&proto::PveCommand::Close));
        q.push_input(proto::encode_data(b"second"));
        q.push_input(proto::encode_data(b"third"));
        let close_len = proto::encode_control(&proto::PveCommand::Close).len();
        let first_len = 5 + 5;
        q.advance(3); // the socket took part of "first"
        assert_eq!(q.drop_unstarted_input(), 6 + 5, "second and third are dropped, first was started");
        assert_eq!(q.len(), first_len - 3 + close_len);
        q.advance(first_len - 3);
        assert_eq!(q.front(), &proto::encode_control(&proto::PveCommand::Close)[..]);
    }

    #[test]
    fn nothing_started_means_all_input_goes() {
        let mut q = OutQueue::new();
        q.push_input(proto::encode_data(b"a"));
        q.push_input(proto::encode_data(b"bc"));
        assert_eq!(q.drop_unstarted_input(), 3);
        assert!(q.is_empty());
    }
}
