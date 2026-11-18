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
#[cfg(test)]
thread_local! {
    static DISCARDED: AtomicU64 = const { AtomicU64::new(0) };
}

/// Updates IronRDP said it ignored (its "Ignoring ..." warnings) since the process began.
pub fn discarded_updates() -> u64 {
    #[cfg(not(test))]
    return DISCARDED.load(Ordering::Relaxed);
    #[cfg(test)]
    DISCARDED.with(|d| d.load(Ordering::Relaxed))
}

fn count_discarded() {
    #[cfg(not(test))]
    DISCARDED.fetch_add(1, Ordering::Relaxed);
    #[cfg(test)]
    DISCARDED.with(|d| d.fetch_add(1, Ordering::Relaxed));
}

struct IgnoreCounter;

struct Message(bool);
impl Visit for Message {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        // The text is looked at and thrown away: only whether it says a VISUAL update was ignored matters. An ignored
        // pointer update is not a lost piece of the picture, so it is not counted as one.
        if field.name() == "message" {
            let text = format!("{value:?}");
            if text.starts_with("Ignoring") && !text.contains("pointer") {
                self.0 = true;
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
        let mut message = Message(false);
        event.record(&mut message);
        if message.0 {
            count_discarded();
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
}

pub struct Health {
    started: Instant,
    updates: u64,
    pixels: u64,
    last_update: Option<Instant>,
    recoveries: u64,
    recovery_skipped: u64,
    ignored_outputs: u64,
    recent: Vec<Instant>,
    last_sent: Option<(Snapshot, Instant)>,
}

impl Health {
    pub fn new() -> Health {
        let started = Instant::now();
        // The baseline is the all-zero snapshot, back-dated so the first change is sent at once; nothing is sent while nothing happened.
        let baseline = (Snapshot { discarded: discarded_updates(), ..Snapshot::default() }, started.checked_sub(STATS_EVERY).unwrap_or(started));
        Health { started, updates: 0, pixels: 0, last_update: None, recoveries: 0, recovery_skipped: 0, ignored_outputs: 0, recent: Vec::new(), last_sent: Some(baseline) }
    }

    /// A region was applied to the framebuffer.
    pub fn applied(&mut self, width: u32, height: u32) {
        self.updates += 1;
        self.pixels = self.pixels.saturating_add(u64::from(width) * u64::from(height));
        self.last_update = Some(Instant::now());
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
            ignored_outputs: self.ignored_outputs,
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
            tracing::warn!(target: "ironrdp_session::fast_path", update_code = 1, "Ignoring invalid Fast-Path update");
            tracing::warn!(target: "ironrdp_session::fast_path", "something else went wrong");
            tracing::warn!(target: "some_other_crate", "Ignoring this one: not ironrdp");
            tracing::warn!(target: "ironrdp_connector::connection", "Ignoring a server capability during the handshake");
            tracing::warn!(target: "ironrdp_session::fast_path", pointer_error = "x", "Ignoring unsupported pointer update");
            tracing::info!(target: "ironrdp_session::fast_path", "Ignoring but only info");
        });
        assert_eq!(discarded_updates() - before, 2);
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
