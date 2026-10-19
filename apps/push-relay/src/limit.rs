//! Fixed-window counters, one per key (an address, a device), kept in memory: the relay keeps no
//! other state, and a restart forgetting the counts is harmless.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Limiter {
    per_window: u32,
    window: Duration,
    counts: Mutex<HashMap<String, (Instant, u32)>>,
}

impl Limiter {
    pub fn new(per_window: u32, window: Duration) -> Self {
        Self {
            per_window,
            window,
            counts: Mutex::new(HashMap::new()),
        }
    }

    /// Count one use of `key` at `now`; false once the window's allowance is spent.
    pub fn allow(&self, key: &str, now: Instant) -> bool {
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        // Forget finished windows now and then, so the map does not grow without bound.
        if counts.len() > 10_000 {
            let window = self.window;
            counts.retain(|_, (start, _)| now.duration_since(*start) < window);
        }
        let entry = counts.entry(key.to_owned()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= self.per_window
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allowance_is_counted_per_key_and_per_window() {
        let limiter = Limiter::new(2, Duration::from_secs(60));
        let start = Instant::now();
        assert!(limiter.allow("a", start));
        assert!(limiter.allow("a", start));
        assert!(
            !limiter.allow("a", start),
            "the third in the window is refused"
        );
        assert!(limiter.allow("b", start), "another key has its own count");
        assert!(
            limiter.allow("a", start + Duration::from_secs(61)),
            "a new window starts afresh"
        );
    }
}
