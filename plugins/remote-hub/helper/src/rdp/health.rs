//! What the RDP engine knows about how complete its picture is (stage 4c, the Windows repaint investigation).
//!
//! IronRDP DISCARDS a malformed or truncated visual update and only logs a warning ("Ignoring ..."); for a Bitmap update it
//! also sets a recovery flag the caller must answer with a full-redraw request. The engine used to do neither, so one lost
//! band stayed wallpaper for ever. This module counts what is dropped (counts only, never a payload), what the engine
//! applied, and how often it asked the server to redraw, and says so in one `Stats` event.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tracing_core::field::{Field, Visit};
use tracing_core::span::{Attributes, Id, Record};
use tracing_core::{Dispatch, Event, Level, Metadata, Subscriber};

// One engine process is one session, so a process-wide counter is the session's. Tests run many "sessions" in one process
// on separate threads, so there each thread has its own.
#[cfg(not(test))]
static DISCARDED: AtomicU64 = AtomicU64::new(0);
#[cfg(not(test))]
static IGNORED_OTHER: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
thread_local! {
    static DISCARDED: AtomicU64 = const { AtomicU64::new(0) };
    static IGNORED_OTHER: AtomicU64 = const { AtomicU64::new(0) };
}

/// Updates IronRDP said it ignored (its "Ignoring ..." warnings) since the process began.
pub fn discarded_updates() -> u64 {
    #[cfg(not(test))]
    return DISCARDED.load(Ordering::Relaxed);
    #[cfg(test)]
    DISCARDED.with(|d| d.load(Ordering::Relaxed))
}

/// Updates of a kind IronRDP could not decode and ignored (not a lost piece of the picture as far as is known).
pub fn ignored_other_updates() -> u64 {
    #[cfg(not(test))]
    return IGNORED_OTHER.load(Ordering::Relaxed);
    #[cfg(test)]
    IGNORED_OTHER.with(|d| d.load(Ordering::Relaxed))
}

fn count_discarded() {
    #[cfg(not(test))]
    DISCARDED.fetch_add(1, Ordering::Relaxed);
    #[cfg(test)]
    DISCARDED.with(|d| d.fetch_add(1, Ordering::Relaxed));
}

fn count_ignored_other() {
    #[cfg(not(test))]
    IGNORED_OTHER.fetch_add(1, Ordering::Relaxed);
    #[cfg(test)]
    IGNORED_OTHER.with(|d| d.fetch_add(1, Ordering::Relaxed));
}

struct IgnoreCounter;

/// What an ignored update was: a lost piece of the picture, some other update, or nothing we count.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ignored {
    No,
    Visual,
    Other,
}

struct Message(Ignored);
impl Visit for Message {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        // The text is looked at and thrown away: only whether it says a VISUAL update was ignored matters. An ignored
        // pointer update is not a lost piece of the picture, so it is not counted as one.
        if field.name() == "message" {
            let text = format!("{value:?}");
            if text.starts_with("Ignoring") && !text.contains("pointer") {
                // Only a visual update (a bitmap or surface band) is a lost piece of the picture. "Ignoring invalid
                // Fast-Path update" is IronRDP's catch-all for an update type it does not decode: counted apart.
                self.0 = if text.contains("visual") || text.contains("bitmap") || text.contains("surface") { Ignored::Visual } else { Ignored::Other };
            }
        }
    }
}

impl Subscriber for IgnoreCounter {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        // Only the session crate decodes the picture: the connector's own "Ignoring ..." notes (capabilities, channels)
        // during the handshake are not discarded updates.
        *metadata.level() <= Level::WARN && metadata.target().starts_with("ironrdp_session")
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        let mut message = Message(Ignored::No);
        event.record(&mut message);
        match message.0 {
            Ignored::Visual => count_discarded(),
            Ignored::Other => count_ignored_other(),
            Ignored::No => {}
        }
    }
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
}

/// The counting subscriber, for tests that scope it to one call.
#[cfg(test)]
pub fn test_counter() -> impl Subscriber {
    IgnoreCounter
}

/// Installs the counter for this process (one engine process is one session). A second call changes nothing.
pub fn install_counter() {
    let _ = tracing_core::dispatcher::set_global_default(Dispatch::new(IgnoreCounter));
}

/// At most this many redraw requests per window: IronRDP latches its own flag, this is the second bound.
pub const RECOVERY_CAP: usize = 3;
pub const RECOVERY_WINDOW: Duration = Duration::from_secs(60);
/// Stats are sent when they changed and at least this long after the last one.
pub const STATS_EVERY: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Snapshot {
    pub updates: u64,
    pub pixels: u64,
    pub last_update_ms: u64,
    pub discarded: u64,
    pub recoveries: u64,
    pub recovery_skipped: u64,
    pub ignored_outputs: u64,
    /// Bytes of server PDU payload received (the wire, before decoding; TLS/TPKT framing not counted).
    pub bytes_in: u64,
}

pub struct Health {
    started: Instant,
    updates: u64,
    pixels: u64,
    last_update: Option<Instant>,
    recoveries: u64,
    recovery_skipped: u64,
    ignored_outputs: u64,
    bytes_in: u64,
    recent: Vec<Instant>,
    last_sent: Option<(Snapshot, Instant)>,
}

impl Health {
    pub fn new() -> Health {
        let started = Instant::now();
        // The baseline is the all-zero snapshot, back-dated so the first change is sent at once; nothing is sent while nothing happened.
        let baseline = (Snapshot { discarded: discarded_updates(), ..Snapshot::default() }, started.checked_sub(STATS_EVERY).unwrap_or(started));
        Health { started, updates: 0, pixels: 0, last_update: None, recoveries: 0, recovery_skipped: 0, ignored_outputs: 0, bytes_in: 0, recent: Vec::new(), last_sent: Some(baseline) }
    }

    /// A region was applied to the framebuffer.
    pub fn applied(&mut self, width: u32, height: u32) {
        self.updates += 1;
        self.pixels = self.pixels.saturating_add(u64::from(width) * u64::from(height));
        self.last_update = Some(Instant::now());
    }

    /// A PDU of `n` payload bytes arrived from the server.
    pub fn received(&mut self, n: usize) {
        self.bytes_in = self.bytes_in.saturating_add(n as u64);
    }

    /// An output kind this engine does not act on (see `handle_outputs`).
    pub fn ignored_output(&mut self) {
        self.ignored_outputs += 1;
    }

    /// Whether a redraw request may be sent now (and records it when it may).
    pub fn allow_recovery(&mut self, now: Instant) -> bool {
        self.recent.retain(|t| now.duration_since(*t) < RECOVERY_WINDOW);
        if self.recent.len() >= RECOVERY_CAP {
            return false;
        }
        self.recent.push(now);
        true
    }

    pub fn recovered(&mut self) {
        self.recoveries += 1;
    }

    pub fn recovery_skipped(&mut self) {
        self.recovery_skipped += 1;
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            updates: self.updates,
            pixels: self.pixels,
            last_update_ms: self.last_update.map(|t| t.duration_since(self.started).as_millis() as u64).unwrap_or(0),
            discarded: discarded_updates(),
            recoveries: self.recoveries,
            recovery_skipped: self.recovery_skipped,
            // Output kinds this engine does not act on, plus updates IronRDP could not decode (counted apart in the hook).
            ignored_outputs: self.ignored_outputs.saturating_add(ignored_other_updates()),
            bytes_in: self.bytes_in,
        }
    }

    /// The snapshot to send now, if it changed since the last one sent (or `force`) and it is not too soon.
    pub fn due(&mut self, now: Instant, force: bool) -> Option<Snapshot> {
        let current = self.snapshot();
        match self.last_sent {
            Some((last, at)) if !force && (last == current || now.duration_since(at) < STATS_EVERY) => None,
            _ => {
                self.last_sent = Some((current, now));
                Some(current)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_counter_counts_ironrdps_ignoring_warnings_and_nothing_else() {
        let dispatch = Dispatch::new(IgnoreCounter);
        let before = discarded_updates();
        tracing_core::dispatcher::with_default(&dispatch, || {
            tracing::warn!(target: "ironrdp_session::fast_path", "Ignoring truncated Fast-Path visual update PDU");
            tracing::warn!(target: "ironrdp_session::fast_path", update_code = 1, "Ignoring truncated Fast-Path visual update");
            tracing::warn!(target: "ironrdp_session::fast_path", "something else went wrong");
            tracing::warn!(target: "some_other_crate", "Ignoring this one: not ironrdp");
            tracing::warn!(target: "ironrdp_connector::connection", "Ignoring a server capability during the handshake");
            tracing::warn!(target: "ironrdp_session::fast_path", pointer_error = "x", "Ignoring unsupported pointer update");
            tracing::info!(target: "ironrdp_session::fast_path", "Ignoring but only info");
            tracing::warn!(target: "ironrdp_session::fast_path", reason = "x", "Ignoring invalid Fast-Path update");
        });
        // A visual update the session ignored counts as discarded; an update type it cannot decode counts apart.
        assert_eq!(discarded_updates() - before, 2);
        assert_eq!(ignored_other_updates(), 1);
    }

    #[test]
    fn received_bytes_add_up_and_show_in_the_snapshot() {
        let mut h = Health::new();
        h.received(1200);
        h.received(34);
        h.applied(10, 10);
        assert_eq!(h.snapshot().bytes_in, 1234);
    }

    #[test]
    fn redraw_requests_are_capped_per_window() {
        let mut h = Health::new();
        let t0 = Instant::now();
        assert!(h.allow_recovery(t0) && h.allow_recovery(t0) && h.allow_recovery(t0));
        assert!(!h.allow_recovery(t0), "a fourth request inside the window is refused");
        assert!(h.allow_recovery(t0 + RECOVERY_WINDOW + Duration::from_secs(1)), "the window moved on");
    }

    #[test]
    fn stats_are_sent_when_they_changed_and_not_more_often_than_the_interval() {
        let mut h = Health::new();
        let t0 = Instant::now();
        assert!(h.due(t0, false).is_none(), "nothing happened yet: nothing is sent");
        h.applied(64, 64);
        let s = h.due(t0, false).expect("the first change goes out at once");
        assert_eq!((s.updates, s.pixels), (1, 4096));
        h.applied(8, 8);
        assert!(h.due(t0 + Duration::from_millis(100), false).is_none(), "too soon");
        assert!(h.due(t0 + Duration::from_secs(2), false).is_some(), "changed and due");
        assert!(h.due(t0 + Duration::from_secs(9), false).is_none(), "nothing changed");
        assert!(h.due(t0 + Duration::from_millis(2100), true).is_some(), "forced");
    }
}
