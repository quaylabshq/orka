use std::{
    fs::{self, Metadata},
    path::Path,
};
use crate::db::Result;

pub fn meta_dev(meta: &Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.dev()
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        0
    }
}

pub fn meta_ino(meta: &Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.ino()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.creation_time() ^ (meta.file_size() << 32) ^ meta.last_write_time()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = meta;
        0
    }
}

pub fn meta_mode(meta: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.mode()
    }
    #[cfg(not(unix))]
    {
        if meta.permissions().readonly() {
            0o444
        } else {
            0o644
        }
    }
}

pub fn meta_ctime(meta: &Metadata) -> (i64, i64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (meta.ctime(), meta.ctime_nsec())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        (meta.last_write_time() as i64, 0)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = meta;
        (0, 0)
    }
}

pub fn set_permissions_owner_rwx(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

#[allow(dead_code)]
pub fn set_permissions_owner_rw(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
