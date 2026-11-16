//! Kernel identities bind helper lifetimes and consent to the actual assistant process.
use crate::db::Result;
use serde::{Deserialize, Serialize};
use std::{os::fd::AsRawFd, os::unix::net::UnixStream};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProcessIdentity {
    pid: u32,
    started: u64,
    fraction: u64,
}

impl ProcessIdentity {
    pub(crate) fn read(pid: u32) -> Result<(Self, u32)> {
        #[cfg(target_os = "macos")]
        {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of_val(&info) as i32;
            let read = unsafe {
                libc::proc_pidinfo(
                    pid as i32,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    size,
                )
            };
            if pid <= 1
                || read != size
                || info.pbi_pid != pid
                || info.pbi_uid != unsafe { libc::geteuid() }
                || info.pbi_status == 5
            {
                return Err("Connector process is unavailable".into());
            }
            Ok((
                Self {
                    pid,
                    started: info.pbi_start_tvsec,
                    fraction: info.pbi_start_tvusec,
                },
                info.pbi_ppid,
            ))
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt;
            let path = format!("/proc/{pid}/stat");
            let stat =
                std::fs::read_to_string(&path).map_err(|_| "Connector process is unavailable")?;
            let fields = stat
                .rsplit_once(')')
                .ok_or("Invalid connector process")?
                .1
                .split_whitespace()
                .collect::<Vec<_>>();
            if pid <= 1
                || std::fs::metadata(&path).map_err(|e| e.to_string())?.uid()
                    != unsafe { libc::geteuid() }
                || fields.first() == Some(&"Z")
            {
                return Err("Connector process is unavailable".into());
            }
            let parent = fields
                .get(1)
                .and_then(|v| v.parse().ok())
                .ok_or("Invalid connector parent")?;
            let started = fields
                .get(19)
                .and_then(|v| v.parse().ok())
                .ok_or("Invalid connector process start")?;
            Ok((
                Self {
                    pid,
                    started,
                    fraction: 0,
                },
                parent,
            ))
        }
    }

    pub(crate) fn alive(&self) -> bool {
        Self::read(self.pid).is_ok_and(|(current, _)| current == *self)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Peer {
    pub(crate) helper: ProcessIdentity,
    pub(crate) assistant: ProcessIdentity,
}

impl Peer {
    pub(crate) fn read(stream: &UnixStream) -> Result<Self> {
        crate::plugin_broker::verify_peer(stream)?;
        #[cfg(target_os = "macos")]
        let pid = {
            let mut pid: libc::pid_t = 0;
            let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_LOCAL,
                    libc::LOCAL_PEERPID,
                    (&mut pid as *mut libc::pid_t).cast(),
                    &mut size,
                )
            } != 0
                || pid <= 1
            {
                return Err("Cannot identify connector process".into());
            }
            pid as u32
        };
        #[cfg(target_os = "linux")]
        let pid = {
            let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
            let mut size = std::mem::size_of_val(&credentials) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut credentials as *mut libc::ucred).cast(),
                    &mut size,
                )
            } != 0
                || credentials.pid <= 1
            {
                return Err("Cannot identify connector process".into());
            }
            credentials.pid as u32
        };
        let (helper, parent) = ProcessIdentity::read(pid)?;
        // An orphan has no assistant authority to share. It remains its own connection.
        let assistant = ProcessIdentity::read(parent)
            .map(|(identity, _)| identity)
            .unwrap_or_else(|_| helper.clone());
        Ok(Self { helper, assistant })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exited_processes_and_reused_process_ids_are_not_live() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let (identity, parent) = ProcessIdentity::read(child.id()).unwrap();
        assert_eq!(parent, std::process::id());
        assert!(identity.alive());
        let mut reused = identity.clone();
        reused.started += 1;
        assert!(!reused.alive());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!identity.alive());
    }
}
