use crate::db::{self, Result};
use fs2::FileExt;
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const BEGIN: &str = "# BEGIN Orka integration";
const END: &str = "# END Orka integration";
const SOURCE: &str = "# Orka source hook (retained)";

fn git(checkout: &Path, args: &[&str], path: &Path) -> Result<Output> {
    let mut command = Command::new("/usr/bin/git");
    // Hooks may inherit Git's environment for a different checkout or index.
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_PREFIX",
        "GIT_LITERAL_PATHSPECS",
        "GIT_GLOB_PATHSPECS",
        "GIT_NOGLOB_PATHSPECS",
        "GIT_ICASE_PATHSPECS",
    ] {
        command.env_remove(key);
    }
    command
        .current_dir(checkout)
        .arg("--no-optional-locks")
        .args(args)
        .arg("--")
        .arg(path)
        .output()
        .map_err(|e| e.to_string())
}

pub(crate) fn untracked(checkout: &Path, relative: &Path) -> Result<()> {
    let output = git(
        checkout,
        &["--literal-pathspecs", "ls-files", "-z", "--cached"],
        relative,
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    if !output.stdout.is_empty() {
        return Err("Destination is tracked by Git".into());
    }
    Ok(())
}

fn rule(relative: &Path) -> Result<String> {
    let relative = relative
        .to_str()
        .ok_or("Git exclusion requires a UTF-8 path")?;
    crate::packages::safe_relative(relative)?;
    let mut rule = String::from("/");
    for c in relative.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | ' ' | '\\') {
            rule.push('\\');
        }
        rule.push(c);
    }
    Ok(rule)
}

pub(crate) struct Excludes {
    _lock: fs::File,
    path: PathBuf,
    before: String,
    after: String,
    rules: BTreeMap<String, bool>,
}

impl Excludes {
    pub(crate) fn open(common: &Path) -> Result<Self> {
        let info = common.join("info");
        crate::packages::safe_directory(common, &info)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(info.join("orka-integration.lock"))
            .map_err(|e| e.to_string())?;
        FileExt::lock_exclusive(&lock).map_err(|e| e.to_string())?;
        let path = info.join("exclude");
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.to_string()),
        };
        let mut rules = BTreeMap::new();
        let (before, after) =
            if let Some((before, rest)) = content.split_once(&format!("{BEGIN}\n")) {
                let (block, after) = rest
                    .split_once(&format!("{END}\n"))
                    .ok_or("Incomplete Orka Git exclude block")?;
                let mut source = false;
                for line in block.lines() {
                    if line == SOURCE {
                        source = true;
                    } else if line.starts_with('/') {
                        rules.insert(line.to_owned(), source);
                        source = false;
                    } else {
                        return Err("Unrecognized rule in Orka Git exclude block".into());
                    }
                }
                (before.to_owned(), after.to_owned())
            } else {
                (content, String::new())
            };
        Ok(Self {
            _lock: lock,
            path,
            before,
            after,
            rules,
        })
    }

    fn write(&self) -> Result<()> {
        let mut content = self.before.clone();
        if !self.rules.is_empty() {
            if !content.is_empty() && !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str(BEGIN);
            content.push('\n');
            for (rule, retain) in &self.rules {
                if *retain {
                    content.push_str(SOURCE);
                    content.push('\n');
                }
                content.push_str(rule);
                content.push('\n');
            }
            content.push_str(END);
            content.push('\n');
        }
        content.push_str(&self.after);
        db::atomic(&self.path, content.as_bytes())
    }

    pub(crate) fn protect(&mut self, checkout: &Path, relative: &Path, retain: bool) -> Result<()> {
        untracked(checkout, relative)?;
        let rule = rule(relative)?;
        let previous = self.rules.get(&rule).copied();
        let retain = retain || previous == Some(true);
        if previous != Some(retain) {
            self.rules.insert(rule.clone(), retain);
            self.write()?;
        }
        let output = git(checkout, &["check-ignore", "--no-index", "-q"], relative);
        if output.as_ref().is_ok_and(|output| output.status.success()) {
            return Ok(());
        }
        if previous != Some(retain) {
            match previous {
                Some(retain) => {
                    self.rules.insert(rule, retain);
                }
                None => {
                    self.rules.remove(&rule);
                }
            }
            self.write()?;
        }
        let output = output?;
        if output.status.code() == Some(1) {
            Err("Destination is not ignored by Git".into())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
        }
    }

    pub(crate) fn release(&mut self, relative: &Path) -> Result<()> {
        let rule = rule(relative)?;
        if self.rules.get(&rule) == Some(&false) {
            self.rules.remove(&rule);
            self.write()?;
        }
        Ok(())
    }
}

pub(crate) fn scratch(relative: &Path) -> PathBuf {
    relative.with_file_name(format!(
        ".orka-{}.pending",
        db::digest(relative.as_os_str().as_encoded_bytes())
    ))
}

/// The caller protects both paths and journals ownership before publication.
/// No scratch name aliases an existing user file, even after a crash.
pub(crate) fn publish(
    path: &Path,
    scratch: &Path,
    bytes: &[u8],
    mode: u32,
    replacing: bool,
) -> Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let mut tmp = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(scratch)
        .map_err(|e| e.to_string())?;
    let result = (|| -> io::Result<()> {
        tmp.write_all(bytes)?;
        tmp.sync_all()?;
        if replacing {
            fs::rename(scratch, path)
        } else {
            fs::hard_link(scratch, path)
        }
    })();
    if let Err(error) = fs::remove_file(scratch) {
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error.to_string());
        }
    }
    result
        .and_then(|()| {
            fs::File::open(path.parent().ok_or(io::ErrorKind::InvalidInput)?)
                .and_then(|parent| parent.sync_all())
        })
        .map_err(|e| e.to_string())
}
