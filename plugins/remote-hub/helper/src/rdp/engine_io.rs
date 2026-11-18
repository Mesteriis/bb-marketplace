//! The engine's channel to the helper: framed writes, the reader thread that
//! turns helper commands into bounded channels, and the cancellation signal.
//!
//! Boundedness: the reader thread never blocks on the engine. The helper
//! bounds what it sends (a byte cap, coalesced acknowledgements, a screenshot
//! cap), so a full control channel means the engine stopped consuming; that
//! ends the session (`protocol_error`) instead of stalling the one reader that
//! must still see a certificate decision, a close and the helper's EOF. When the helper's end closes (it died or closed the session) the
//! thread records it, wakes every waiter and drops its senders, so the engine
//! never lingers as an orphan holding a logged-in session.
use std::io::Write as _;
use std::os::unix::net::UnixStream;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use super::protocol::{self, EngineCommand, EngineEvent, InputEvent};
use super::reasons::RdpClosedReason;

/// Capacity of the helper → engine command channel.
pub const CONTROL_CAPACITY: usize = 4096;

/// Writes whole frames to the helper. Shared (`Arc`) so the TLS certificate
/// callback can report from inside the handshake.
pub struct Out {
    stream: Mutex<UnixStream>,
}

impl Out {
    pub fn new(stream: UnixStream) -> Self {
        Out { stream: Mutex::new(stream) }
    }

    pub fn send_frame(&self, frame: &[u8]) -> std::io::Result<()> {
        self.stream.lock().unwrap().write_all(frame)
    }

    pub fn send(&self, event: &EngineEvent) -> std::io::Result<()> {
        self.send_frame(&protocol::encode_control(event))
    }

    pub fn state(&self, state: &str) -> std::io::Result<()> {
        self.send(&EngineEvent::State { state: state.to_string() })
    }

    pub fn closed(&self, reason: RdpClosedReason) -> std::io::Result<()> {
        self.send(&EngineEvent::Closed { reason: reason.as_str().to_string() })
    }
}

/// A certificate decision or a cancellation, delivered to the code that waits
/// inside the TLS handshake.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Cert { fingerprint: String, accept: String },
    /// The helper's answer to a `PinRequest`.
    Pin { verdict: String },
    Cancel(RdpClosedReason),
}

/// Everything else the helper can ask of a running session.
#[derive(Debug)]
pub enum Control {
    Input { generation: u64, events: Vec<InputEvent> },
    SetOwner { generation: u64, request: u64 },
    Screenshot,
    Ack(u64),
    Refresh,
}

/// Set once, by the first cause: the helper asked to close, or it went away.
pub struct Cancel {
    reason: Mutex<Option<RdpClosedReason>>,
    notify: Notify,
}

impl Cancel {
    pub fn new() -> Self {
        Cancel { reason: Mutex::new(None), notify: Notify::new() }
    }

    pub fn trigger(&self, reason: RdpClosedReason) {
        {
            let mut slot = self.reason.lock().unwrap();
            if slot.is_none() {
                *slot = Some(reason);
            }
        }
        self.notify.notify_one();
    }

    pub fn reason(&self) -> Option<RdpClosedReason> {
        *self.reason.lock().unwrap()
    }

    /// Resolves with the cancellation reason. Cancel-safe.
    pub async fn wait(&self) -> RdpClosedReason {
        loop {
            if let Some(r) = self.reason() {
                return r;
            }
            self.notify.notified().await;
        }
    }
}

impl Default for Cancel {
    fn default() -> Self {
        Self::new()
    }
}

pub struct Inbox {
    pub control: tokio::sync::mpsc::Receiver<Control>,
    pub decisions: mpsc::Receiver<Decision>,
    pub cancel: Arc<Cancel>,
}

/// Read one length-prefixed frame body. `None` on a clean EOF.
pub fn read_frame(stream: &mut impl std::io::Read) -> std::io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match stream.read(&mut len_buf[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(std::io::Error::other("short frame header")),
            Ok(n) => got += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > protocol::RDP_MAX_COMMAND_BODY {
        return Err(std::io::Error::other("frame body length out of range"));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Hand one control item to the engine without ever blocking. False ends the
/// reader: the engine dropped its receiver, or the channel overflowed (which
/// cancels the session).
fn forward(
    tx: &tokio::sync::mpsc::Sender<Control>,
    item: Control,
    cancel: &Cancel,
    dec_tx: &mpsc::Sender<Decision>,
) -> bool {
    match tx.try_send(item) {
        Ok(()) => true,
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => false,
        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
            cancel.trigger(RdpClosedReason::ProtocolError);
            let _ = dec_tx.send(Decision::Cancel(RdpClosedReason::ProtocolError));
            false
        }
    }
}

/// Start the thread that reads helper commands. Frames that fail to parse are
/// skipped; a framing error or EOF ends the thread and cancels the engine.
pub fn spawn_reader(stream: UnixStream) -> Inbox {
    spawn_reader_with_capacity(stream, CONTROL_CAPACITY)
}

pub(crate) fn spawn_reader_with_capacity(mut stream: UnixStream, capacity: usize) -> Inbox {
    let (ctl_tx, control) = tokio::sync::mpsc::channel::<Control>(capacity);
    let (dec_tx, decisions) = mpsc::channel::<Decision>();
    let cancel = Arc::new(Cancel::new());
    let thread_cancel = cancel.clone();
    std::thread::spawn(move || {
        loop {
            match read_frame(&mut stream) {
                Ok(Some(body)) if body.first() == Some(&protocol::FRAME_CONTROL) => {
                    let Ok(cmd) = serde_json::from_slice::<EngineCommand>(&body[1..]) else { continue };
                    match cmd {
                        EngineCommand::CertDecision { fingerprint, accept } => {
                            let _ = dec_tx.send(Decision::Cert { fingerprint, accept });
                        }
                        EngineCommand::PinAnswer { verdict } => {
                            let _ = dec_tx.send(Decision::Pin { verdict });
                        }
                        EngineCommand::Input { events, generation } => {
                            if !forward(&ctl_tx, Control::Input { generation, events }, &thread_cancel, &dec_tx) {
                                break;
                            }
                        }
                        EngineCommand::SetOwner { generation, request } => {
                            if !forward(&ctl_tx, Control::SetOwner { generation, request }, &thread_cancel, &dec_tx) {
                                break;
                            }
                        }
                        EngineCommand::Screenshot => {
                            if !forward(&ctl_tx, Control::Screenshot, &thread_cancel, &dec_tx) {
                                break;
                            }
                        }
                        EngineCommand::Refresh => {
                            if !forward(&ctl_tx, Control::Refresh, &thread_cancel, &dec_tx) {
                                break;
                            }
                        }
                        EngineCommand::Ack { frame_id } => {
                            if !forward(&ctl_tx, Control::Ack(frame_id), &thread_cancel, &dec_tx) {
                                break;
                            }
                        }
                        EngineCommand::Close => {
                            thread_cancel.trigger(RdpClosedReason::KilledByClose);
                            let _ = dec_tx.send(Decision::Cancel(RdpClosedReason::KilledByClose));
                            break;
                        }
                        EngineCommand::Open { .. } => {}
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => {
                    // The helper is gone: end the session, wake every waiter
                    // (the senders drop with this thread).
                    thread_cancel.trigger(RdpClosedReason::HelperShutdown);
                    let _ = dec_tx.send(Decision::Cancel(RdpClosedReason::HelperShutdown));
                    break;
                }
            }
        }
    });
    Inbox { control, decisions, cancel }
}

#[cfg(test)]
mod tests {
    //! The 30 s limits below are hang guards: each event is awaited, never raced.
    use super::*;
    use std::time::Duration;

    fn pair() -> (UnixStream, UnixStream) {
        UnixStream::pair().unwrap()
    }

    #[test]
    fn helper_eof_cancels_and_closes_the_channels() {
        let (engine_end, helper_end) = pair();
        let mut inbox = spawn_reader(engine_end);
        drop(helper_end);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let reason = tokio::time::timeout(Duration::from_secs(30), inbox.cancel.wait()).await.unwrap();
            assert_eq!(reason, RdpClosedReason::HelperShutdown);
            let next = tokio::time::timeout(Duration::from_secs(30), inbox.control.recv()).await.unwrap();
            assert!(next.is_none(), "the control channel must close when the helper is gone");
        });
        assert_eq!(inbox.decisions.recv_timeout(Duration::from_secs(30)), Ok(Decision::Cancel(RdpClosedReason::HelperShutdown)));
    }

    #[test]
    fn close_command_cancels_with_killed_by_close() {
        let (engine_end, mut helper_end) = pair();
        let inbox = spawn_reader(engine_end);
        helper_end.write_all(&protocol::encode_control(&EngineCommand::Close)).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let reason = rt.block_on(async { tokio::time::timeout(Duration::from_secs(30), inbox.cancel.wait()).await }).unwrap();
        assert_eq!(reason, RdpClosedReason::KilledByClose);
    }

    #[test]
    fn commands_are_routed_to_their_channels() {
        let (engine_end, mut helper_end) = pair();
        let mut inbox = spawn_reader(engine_end);
        for cmd in [
            EngineCommand::Screenshot,
            EngineCommand::Ack { frame_id: 7 },
            EngineCommand::CertDecision { fingerprint: "AA".into(), accept: "once".into() },
        ] {
            helper_end.write_all(&protocol::encode_control(&cmd)).unwrap();
        }
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            assert!(matches!(inbox.control.recv().await, Some(Control::Screenshot)));
            assert!(matches!(inbox.control.recv().await, Some(Control::Ack(7))));
        });
        assert_eq!(
            inbox.decisions.recv_timeout(Duration::from_secs(30)),
            Ok(Decision::Cert { fingerprint: "AA".into(), accept: "once".into() })
        );
    }

    fn input_frame() -> Vec<u8> {
        protocol::encode_control(&EngineCommand::Input { events: vec![], generation: 0 })
    }

    #[test]
    fn a_decision_arrives_while_control_items_are_queued_unconsumed() {
        let (engine_end, mut helper_end) = pair();
        let inbox = spawn_reader_with_capacity(engine_end, 8);
        for _ in 0..5 {
            helper_end.write_all(&input_frame()).unwrap();
        }
        helper_end
            .write_all(&protocol::encode_control(&EngineCommand::CertDecision { fingerprint: "AA".into(), accept: "once".into() }))
            .unwrap();
        assert_eq!(
            inbox.decisions.recv_timeout(Duration::from_secs(30)),
            Ok(Decision::Cert { fingerprint: "AA".into(), accept: "once".into() })
        );
    }

    #[test]
    fn an_overflowing_control_channel_ends_the_session_instead_of_blocking_the_reader() {
        // Nothing consumes `control`; capacity 8; 65 inputs are written. A
        // reader that blocked would never see the frames after the ninth.
        let (engine_end, mut helper_end) = pair();
        let inbox = spawn_reader_with_capacity(engine_end, 8);
        for _ in 0..65 {
            // The reader ends the session at the ninth frame and closes its end:
            // later writes may legitimately fail with a broken pipe.
            if helper_end.write_all(&input_frame()).is_err() {
                break;
            }
        }
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let reason = rt.block_on(async { tokio::time::timeout(Duration::from_secs(30), inbox.cancel.wait()).await }).unwrap();
        assert_eq!(reason, RdpClosedReason::ProtocolError);
    }

    #[test]
    fn helper_eof_is_seen_with_a_full_control_channel() {
        // Capacity 8 is filled exactly, nothing consumes it, then the helper
        // goes away. The reader must still observe EOF.
        let (engine_end, mut helper_end) = pair();
        let inbox = spawn_reader_with_capacity(engine_end, 8);
        for _ in 0..8 {
            helper_end.write_all(&input_frame()).unwrap();
        }
        drop(helper_end);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let reason = rt.block_on(async { tokio::time::timeout(Duration::from_secs(30), inbox.cancel.wait()).await }).unwrap();
        assert_eq!(reason, RdpClosedReason::HelperShutdown);
    }
}
