use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(crate) struct Interval(Duration);

impl Interval {
    const JITTER_DIVISOR: u32 = 5;
    const FIRST_RETRY: Duration = Duration::from_secs(30);

    pub(crate) fn from_config(config: &Value) -> Self {
        Self(Duration::from_secs(
            config["syncMinutes"].as_u64().unwrap_or(15).clamp(1, 1440) * 60,
        ))
    }

    pub(crate) fn duration(&self) -> Duration {
        self.0
    }

    pub(crate) fn stale_after(&self) -> Duration {
        // Keep the existing two-interval allowance and add at most one jitter window.
        (2 * self.0 + self.0 / Self::JITTER_DIVISOR).max(Duration::from_secs(300))
    }

    /// The wait after `attempts` failures in a row: 30 seconds, doubling, at most one interval.
    pub(crate) fn retry(&self, attempts: u32) -> Duration {
        let doublings = attempts.saturating_sub(1).min(16);
        (Self::FIRST_RETRY * 2u32.pow(doublings)).min(self.0)
    }
}

/// A stable offset of up to a fifth of `base` for one project on one Mac, so
/// projects and Macs that share a schedule do not all sync at the same moment.
pub(crate) fn jitter(device: &str, project: &str, base: Duration) -> Duration {
    let digest = Sha256::digest(format!("{device}:{project}"));
    let hash = u32::from_be_bytes(digest[..4].try_into().unwrap());
    let bound = (base / Interval::JITTER_DIVISOR).as_millis() as u64;
    Duration::from_millis(u64::from(hash) * bound / u64::from(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_offsets_are_stable_and_spread_inside_timer_and_retry_bounds() {
        for base in [Duration::from_secs(900), Duration::from_secs(30)] {
            let offsets = |device: &str| {
                (0..12)
                    .map(|project| jitter(device, &project.to_string(), base))
                    .collect::<Vec<_>>()
            };
            let first = offsets("mac-a");
            assert!(first.iter().all(|offset| *offset <= base / 5));
            assert_eq!(first, offsets("mac-a"));
            assert_ne!(first, offsets("mac-b"));
            assert!(first.windows(2).any(|pair| pair[0] != pair[1]));
        }
    }

    #[test]
    fn retries_double_from_thirty_seconds_up_to_the_interval() {
        let interval = Interval(Duration::from_secs(300));
        let waits: Vec<_> = (1..=6).map(|n| interval.retry(n).as_secs()).collect();
        assert_eq!(waits, [30, 60, 120, 240, 300, 300]);
        assert_eq!(interval.retry(u32::MAX), Duration::from_secs(300));
    }
}
