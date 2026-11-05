//! Runs the official Obsidian CLI (Obsidian 1.12.7+) for data sources (D41).
//!
//! The `obsidian` binary is Obsidian's own executable: with Obsidian running it
//! connects to the app's CLI socket, prints the command's text result and
//! exits; without it, it becomes Obsidian and never runs the command. So the
//! app is started first, detached, and the command runs once the socket answers. Only read-only subcommands and
//! a fixed set of options are allowed; the check lives here, not in the webview.
//! The command runs without a shell.
//!
//! The daily note (D65) is the one file the app writes: `daily_note_write`
//! writes the vault's daily note, found through the read-only `vault info=path`
//! and `daily:path`, only inside the vault, only a `.md` file, and only when
//! the file still holds the text the caller last read (compare-and-swap). No
//! writing CLI subcommand is allowed. The other write, an image pasted into
//! the note (D70), lives in `note_images.rs` and uses the same lookups.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// The first call may have to start Obsidian.
const TIMEOUT: Duration = Duration::from_secs(30);
/// How long Obsidian gets to start and open its CLI socket.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for output pipes to close once the command has exited.
const PIPE_GRACE: Duration = Duration::from_secs(2);
const MAX_ARGS: usize = 20;
const MAX_ARG_LEN: usize = 2000;

const SUBCOMMANDS: &[&str] = &[
    "search",
    "search:context",
    "read",
    "backlinks",
    "tags",
    "aliases",
    "links",
    "file",
    "files",
    "vaults",
    "version",
    // The daily note (D65): where the vault is and where today's note is; both only read.
    "vault",
    "daily:path",
];
const KEYS: &[&str] = &[
    "query", "path", "file", "limit", "format", "folder", "ext", "info",
];
const FLAGS: &[&str] = &["total", "counts", "verbose", "case"];

const HOW_TO_ENABLE: &str = "Turn on the command line interface in Obsidian 1.12.7 or later \
     (Settings > General > Advanced > Command line interface), or set the path of the \
     obsidian command in Settings > Data sources.";

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CliOutput {
    pub stdout: String,
    pub code: Option<i32>,
}

/// Checks a value of `key=value`: non-empty, one line, no NUL.
fn check_value(arg: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("argument \"{arg}\" has an empty value"));
    }
    if value.contains(['\n', '\r', '\0']) {
        return Err(format!("argument \"{arg}\" must be one line"));
    }
    Ok(())
}

/// Allows `[vault=<name>] <subcommand> (key=value | flag)*` with the read-only
/// subcommands, keys and flags above.
pub fn validate_args(args: &[String]) -> Result<(), String> {
    if args.len() > MAX_ARGS {
        return Err(format!("too many arguments (at most {MAX_ARGS})"));
    }
    if let Some(long) = args.iter().find(|a| a.chars().count() > MAX_ARG_LEN) {
        let head: String = long.chars().take(40).collect();
        return Err(format!(
            "argument \"{head}...\" is longer than {MAX_ARG_LEN} characters"
        ));
    }
    let mut rest = args;
    if let Some(first) = rest.first() {
        if let Some(vault) = first.strip_prefix("vault=") {
            check_value(first, vault)?;
            rest = &rest[1..];
        }
    }
    let Some((sub, options)) = rest.split_first() else {
        return Err("missing Obsidian subcommand".into());
    };
    if !SUBCOMMANDS.contains(&sub.as_str()) {
        return Err(format!(
            "Obsidian subcommand \"{sub}\" is not allowed (allowed: {})",
            SUBCOMMANDS.join(", ")
        ));
    }
    for arg in options {
        match arg.split_once('=') {
            Some((key, value)) => {
                if !KEYS.contains(&key) {
                    return Err(format!(
                        "option \"{key}\" is not allowed (allowed: {})",
                        KEYS.join(", ")
                    ));
                }
                check_value(arg, value)?;
            }
            None => {
                if !FLAGS.contains(&arg.as_str()) {
                    return Err(format!(
                        "flag \"{arg}\" is not allowed (allowed: {})",
                        FLAGS.join(", ")
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Where the platform installs the command, in the order to try. Entries from
/// `path_dirs` (the PATH) come after the fixed locations.
pub fn default_candidates(
    os: &str,
    home: Option<&Path>,
    local_app_data: Option<&Path>,
    path_dirs: &[PathBuf],
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let exe = match os {
        "macos" => {
            // GUI apps on macOS do not get /usr/local/bin on their PATH.
            out.push(PathBuf::from("/usr/local/bin/obsidian"));
            out.push(PathBuf::from("/opt/homebrew/bin/obsidian"));
            "obsidian"
        }
        "windows" => {
            if let Some(dir) = local_app_data {
                out.push(dir.join("Programs").join("Obsidian").join("Obsidian.com"));
            }
            "Obsidian.com"
        }
        _ => {
            if let Some(home) = home {
                out.push(home.join(".local").join("bin").join("obsidian"));
            }
            "obsidian"
        }
    };
    out.extend(path_dirs.iter().map(|dir| dir.join(exe)));
    out
}

/// The configured path when set (it must be an existing absolute file), else the
/// first candidate for which `is_file` holds.
pub fn resolve_binary(
    cli_path: Option<&str>,
    candidates: &[PathBuf],
    is_file: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    if let Some(configured) = cli_path.map(str::trim).filter(|p| !p.is_empty()) {
        let path = PathBuf::from(configured);
        if !path.is_absolute() {
            return Err(format!(
                "not_installed: the Obsidian command path \"{configured}\" must be a full path. {HOW_TO_ENABLE}"
            ));
        }
        if !is_file(&path) {
            return Err(format!(
                "not_installed: no file at \"{configured}\". {HOW_TO_ENABLE}"
            ));
        }
        return Ok(path);
    }
    candidates
        .iter()
        .find(|p| is_file(p))
        .cloned()
        .ok_or_else(|| {
            format!("not_installed: the obsidian command was not found. {HOW_TO_ENABLE}")
        })
}

fn find_binary(cli_path: Option<&str>) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .filter(|d| d.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    let candidates = default_candidates(
        std::env::consts::OS,
        home.as_deref(),
        local_app_data.as_deref(),
        &path_dirs,
    );
    resolve_binary(cli_path, &candidates, Path::is_file)
}

/// Output collected by a reader thread so far, and whether the pipe closed.
type Captured = Arc<(Mutex<Vec<u8>>, AtomicBool)>;

/// Drains a pipe on its own thread so a large result cannot block the child.
fn capture(mut pipe: impl Read + Send + 'static) -> Captured {
    let captured: Captured = Arc::new((Mutex::new(Vec::new()), AtomicBool::new(false)));
    let sink = Arc::clone(&captured);
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            if let Ok(mut buf) = sink.0.lock() {
                buf.extend_from_slice(&chunk[..n]);
            }
        }
        sink.1.store(true, Ordering::Release);
    });
    captured
}

fn take(captured: &Captured) -> String {
    let buf = captured.0.lock().map(|b| b.clone()).unwrap_or_default();
    String::from_utf8_lossy(&buf).into_owned()
}

/// Runs the binary, killing it after `timeout`.
fn run_blocking(bin: &Path, args: &[String], timeout: Duration) -> Result<CliOutput, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", bin.display()))?;
    let stdout = child.stdout.take().map(capture);
    let stderr = child.stderr.take().map(capture);

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "timeout: Obsidian did not answer within {} seconds",
                    timeout.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => {
                let _ = child.kill();
                return Err(format!("could not wait for the obsidian command: {e}"));
            }
        }
    };
    // An Obsidian started by this call can inherit the pipes and keep them
    // open, so wait only briefly for them to close after the command exits.
    let grace = Instant::now() + PIPE_GRACE;
    let closed = |c: &Option<Captured>| c.as_ref().is_none_or(|c| c.1.load(Ordering::Acquire));
    while !(closed(&stdout) && closed(&stderr)) && Instant::now() < grace {
        std::thread::sleep(Duration::from_millis(10));
    }
    let out = stdout.as_ref().map(take).unwrap_or_default();
    let err = stderr.as_ref().map(take).unwrap_or_default();
    let stdout = if out.trim().is_empty() && !err.trim().is_empty() {
        err
    } else {
        out
    };
    Ok(CliOutput {
        stdout,
        code: status.code(),
    })
}

/// Where the running Obsidian listens for CLI commands (Obsidian 1.13 main.js):
/// a named pipe per user on Windows, `~/.obsidian-cli.sock` on macOS, and
/// `$XDG_RUNTIME_DIR/.obsidian-cli.sock` (or the home folder) on Linux.
pub fn cli_socket(
    os: &str,
    home: Option<&Path>,
    runtime_dir: Option<&Path>,
    user: Option<&str>,
) -> Option<PathBuf> {
    match os {
        "windows" => user.map(|u| PathBuf::from(format!(r"\\.\pipe\obsidian-cli-{u}"))),
        "macos" => home.map(|h| h.join(".obsidian-cli.sock")),
        _ => runtime_dir.or(home).map(|d| d.join(".obsidian-cli.sock")),
    }
}

fn socket_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from);
    let user = std::env::var("USERNAME").ok();
    cli_socket(
        std::env::consts::OS,
        home.as_deref(),
        runtime.as_deref(),
        user.as_deref(),
    )
}

/// Whether Obsidian answers on its CLI socket. The probe connection sends no
/// command; Obsidian drops it after its header timeout.
fn obsidian_running() -> bool {
    let Some(path) = socket_path() else {
        return false;
    };
    #[cfg(unix)]
    {
        std::os::unix::net::UnixStream::connect(&path).is_ok()
    }
    #[cfg(windows)]
    {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .is_ok()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        false
    }
}

/// Starts Obsidian on its own, not tied to this app, and waits for its socket.
fn ensure_running(bin: &Path) -> Result<(), String> {
    if obsidian_running() {
        return Ok(());
    }
    let mut cmd = Command::new(bin);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start Obsidian ({}): {e}", bin.display()))?;
    // Reap it whenever it quits, without holding this call up.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    let started = Instant::now();
    while started.elapsed() < START_TIMEOUT {
        std::thread::sleep(Duration::from_millis(250));
        if obsidian_running() {
            return Ok(());
        }
    }
    Err(format!(
        "timeout: Obsidian did not start within {} seconds",
        START_TIMEOUT.as_secs()
    ))
}

/// Runs one read-only `obsidian` command. Errors start with "not_installed:",
/// "timeout:" or describe a refused argument or a failed start.
#[tauri::command]
pub async fn obsidian_cli(
    args: Vec<String>,
    cli_path: Option<String>,
) -> Result<CliOutput, String> {
    validate_args(&args)?;
    let bin = find_binary(cli_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        ensure_running(&bin)?;
        run_blocking(&bin, &args, TIMEOUT)
    })
    .await
    .map_err(|e| format!("the obsidian command failed: {e}"))?
}

// ---------------------------------------------------------------------------
// The daily note (D65)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DailyNoteRead {
    pub path: String,
    /// Null when the note does not exist yet.
    pub text: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DailyNoteWrite {
    pub path: String,
    /// True when the file no longer held the expected text; nothing was written.
    pub conflict: bool,
    /// On a conflict, the file's current text (null: it does not exist).
    pub text: Option<String>,
}

/// One CLI answer as text; a failed command, an empty answer or an error line is an error.
fn cli_answer(
    run: &dyn Fn(&[String]) -> Result<CliOutput, String>,
    args: Vec<String>,
) -> Result<String, String> {
    validate_args(&args)?;
    let out = run(&args)?;
    let text = out.stdout.trim();
    let failed = out.code.is_some_and(|c| c != 0)
        || text.is_empty()
        || text.lines().count() != 1
        || text.to_ascii_lowercase().starts_with("error");
    if failed {
        let head: String = text.chars().take(200).collect();
        return Err(format!(
            "Obsidian did not give the daily note's place ({}): {head}",
            args.join(" ")
        ));
    }
    Ok(text.to_string())
}

/// The daily note's path in the vault, from the CLI.
pub fn resolve_daily_note(
    vault: &str,
    run: &dyn Fn(&[String]) -> Result<CliOutput, String>,
) -> Result<PathBuf, String> {
    resolve_vault_note(vault, run).map(|(_, note)| note)
}

/// The vault's canonical folder and the daily note's path in it, from the two
/// read-only CLI lookups. The images in the note (D70) need both.
pub fn resolve_vault_note(
    vault: &str,
    run: &dyn Fn(&[String]) -> Result<CliOutput, String>,
) -> Result<(PathBuf, PathBuf), String> {
    check_value("vault", vault)?;
    let at = format!("vault={vault}");
    let folder = cli_answer(run, vec![at.clone(), "vault".into(), "info=path".into()])?;
    let rel = cli_answer(run, vec![at, "daily:path".into()])?;
    let note = note_path(Path::new(&folder), &rel)?;
    let root = Path::new(&folder)
        .canonicalize()
        .map_err(|e| format!("the vault folder {folder} cannot be read: {e}"))?;
    Ok((root, note))
}

/// The nearest folder of `path` that exists, `path` included.
pub(crate) fn existing_ancestor(path: &Path) -> Option<&Path> {
    path.ancestors().find(|p| p.exists())
}

/// The note's full path: a `.md` file inside the vault folder. A relative path
/// may not climb out; whatever exists of it, resolved through links, must lie
/// inside the resolved vault folder.
pub fn note_path(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let vault = vault
        .canonicalize()
        .map_err(|e| format!("the vault folder {} cannot be read: {e}", vault.display()))?;
    let rel = Path::new(rel.trim());
    let is_md = rel
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
    if !is_md {
        return Err(format!(
            "the daily note {} is not a .md file",
            rel.display()
        ));
    }
    let full = if rel.is_absolute() {
        rel.to_path_buf()
    } else {
        if rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(format!(
                "the daily note {} is outside the vault",
                rel.display()
            ));
        }
        vault.join(rel)
    };
    let outside = || format!("the daily note {} is outside the vault", full.display());
    let base = existing_ancestor(&full).ok_or_else(outside)?;
    let resolved = base.canonicalize().map_err(|_| outside())?;
    if !resolved.starts_with(&vault) {
        return Err(outside());
    }
    // What does not exist yet must not climb back out either.
    if let Ok(rest) = full.strip_prefix(base) {
        if rest
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(outside());
        }
    }
    if full.exists() && !resolved.is_file() {
        return Err(format!("the daily note {} is not a file", full.display()));
    }
    Ok(full)
}

/// The note's text; None when it does not exist.
pub fn read_note(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| format!("the daily note {} is not UTF-8 text", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "the daily note {} cannot be read: {e}",
            path.display()
        )),
    }
}

/// Writes `text` only when the file holds `expected` (None: it must not exist),
/// through a temporary file in the same folder renamed over it. Returns the
/// current text on a conflict, and None when written.
pub fn write_note_cas(
    path: &Path,
    text: &str,
    expected: Option<&str>,
) -> Result<Option<Option<String>>, String> {
    let current = read_note(path)?;
    if current.as_deref() != expected {
        return Ok(Some(current));
    }
    let dir = path
        .parent()
        .ok_or_else(|| format!("the daily note {} has no folder", path.display()))?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("the folder {} cannot be made: {e}", dir.display()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(
        ".{name}.{}-{nanos}.secretary-tmp",
        std::process::id()
    ));
    if let Err(e) = std::fs::write(&tmp, text) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("the daily note cannot be written: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("the daily note cannot be written: {e}"));
    }
    Ok(None)
}

/// Whether a daily-note command may go on: with Obsidian closed it starts it
/// only when the caller asked to `launch` (the page opening, Read now); the
/// poll and the passes never start Obsidian.
pub fn may_run(launch: bool, running: bool) -> Result<(), String> {
    if running || launch {
        Ok(())
    } else {
        Err("not_running: Obsidian is not running".into())
    }
}

/// Runs CLI commands for the daily note: finds the binary, starts Obsidian if needed.
pub(crate) fn cli_runner(
    cli_path: Option<String>,
    launch: bool,
) -> Result<impl Fn(&[String]) -> Result<CliOutput, String>, String> {
    let bin = find_binary(cli_path.as_deref())?;
    may_run(launch, obsidian_running())?;
    ensure_running(&bin)?;
    Ok(move |args: &[String]| run_blocking(&bin, args, TIMEOUT))
}

/// Reads the vault's daily note for today (D65).
#[tauri::command]
pub async fn daily_note_read(
    vault: String,
    cli_path: Option<String>,
    launch: bool,
) -> Result<DailyNoteRead, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let run = cli_runner(cli_path, launch)?;
        let path = resolve_daily_note(&vault, &run)?;
        let text = read_note(&path)?;
        Ok(DailyNoteRead {
            path: path.to_string_lossy().into_owned(),
            text,
        })
    })
    .await
    .map_err(|e| format!("reading the daily note failed: {e}"))?
}

/// Writes the vault's daily note for today when it still holds `expected` (D65).
#[tauri::command]
pub async fn daily_note_write(
    vault: String,
    cli_path: Option<String>,
    text: String,
    expected: Option<String>,
    launch: bool,
) -> Result<DailyNoteWrite, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let run = cli_runner(cli_path, launch)?;
        let path = resolve_daily_note(&vault, &run)?;
        let conflict = write_note_cas(&path, &text, expected.as_deref())?;
        Ok(DailyNoteWrite {
            path: path.to_string_lossy().into_owned(),
            conflict: conflict.is_some(),
            text: conflict.flatten(),
        })
    })
    .await
    .map_err(|e| format!("writing the daily note failed: {e}"))?
}

#[cfg(test)]
pub(crate) mod daily_note_tests {
    use super::*;
    use std::cell::RefCell;

    /// A fresh folder under the system temp folder.
    pub(crate) fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("secretary-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub(crate) fn fake_cli<'a>(
        folder: String,
        daily: &'static str,
        seen: &'a RefCell<Vec<Vec<String>>>,
    ) -> impl Fn(&[String]) -> Result<CliOutput, String> + 'a {
        move |args: &[String]| {
            seen.borrow_mut().push(args.to_vec());
            let stdout = match args.get(1).map(String::as_str) {
                Some("vault") => format!("{folder}\n"),
                Some("daily:path") => format!("{daily}\n"),
                _ => return Err("unexpected".into()),
            };
            Ok(CliOutput {
                stdout,
                code: Some(0),
            })
        }
    }

    #[test]
    fn allowlist_takes_the_daily_note_lookups_only() {
        let ok = |a: &[&str]| validate_args(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(ok(&["vault=Work", "vault", "info=path"]), Ok(()));
        assert_eq!(ok(&["vault=Work", "daily:path"]), Ok(()));
        for bad in [
            &["vault=Work", "daily"][..],
            &["vault=Work", "daily:append", "content=x"],
            &["vault=Work", "daily:prepend", "content=x"],
            &["vault=Work", "create", "path=x.md"],
            &["vault=Work", "append", "path=x.md", "content=x"],
            &["vault=Work", "vault", "content=x"],
        ] {
            assert!(ok(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn resolves_the_note_inside_the_vault() {
        let vault = temp_dir("vault");
        let seen = RefCell::new(Vec::new());
        let run = fake_cli(
            vault.to_string_lossy().into_owned(),
            "Daily/2026-11-02.md",
            &seen,
        );
        let path = resolve_daily_note("Work", &run).unwrap();
        assert_eq!(
            path,
            vault
                .canonicalize()
                .unwrap()
                .join("Daily")
                .join("2026-11-02.md")
        );
        assert_eq!(
            *seen.borrow(),
            vec![
                vec!["vault=Work".to_string(), "vault".into(), "info=path".into()],
                vec!["vault=Work".to_string(), "daily:path".into()],
            ]
        );
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn refuses_paths_outside_the_vault_or_not_markdown() {
        let root = temp_dir("outside");
        let vault = root.join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(root.join("secret.md"), "x").unwrap();
        assert!(note_path(&vault, "../secret.md").is_err());
        assert!(note_path(&vault, "Daily/../../secret.md").is_err());
        assert!(note_path(&vault, &root.join("secret.md").to_string_lossy()).is_err());
        assert!(note_path(&vault, "Daily/2026-11-02.txt").is_err());
        assert!(note_path(&vault, "Daily/2026-11-02").is_err());
        assert!(note_path(&vault, "Daily/2026-11-02.md").is_ok());
        let inside = vault.canonicalize().unwrap().join("note.md");
        assert_eq!(note_path(&vault, &inside.to_string_lossy()), Ok(inside));
        #[cfg(unix)]
        {
            // A link inside the vault to a folder outside it does not let a write out.
            std::os::unix::fs::symlink(&root, vault.join("escape")).unwrap();
            assert!(note_path(&vault, "escape/secret.md").is_err());
            assert!(note_path(&vault, "escape/new/today.md").is_err());
        }
        std::fs::create_dir_all(vault.join("folder.md")).unwrap();
        assert!(note_path(&vault, "folder.md").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writes_only_over_the_expected_text() {
        let vault = temp_dir("cas");
        let path = vault.join("Daily").join("today.md");
        // Missing: written only when the caller expects it missing; the folder is made.
        assert_eq!(write_note_cas(&path, "a", Some("x")), Ok(Some(None)));
        assert_eq!(read_note(&path), Ok(None));
        assert_eq!(write_note_cas(&path, "first\n", None), Ok(None));
        assert_eq!(read_note(&path), Ok(Some("first\n".into())));
        // Present: a stale expectation gets the current text back, and nothing changes.
        assert_eq!(
            write_note_cas(&path, "other", None),
            Ok(Some(Some("first\n".into())))
        );
        assert_eq!(
            write_note_cas(&path, "other", Some("old")),
            Ok(Some(Some("first\n".into())))
        );
        assert_eq!(read_note(&path), Ok(Some("first\n".into())));
        assert_eq!(
            write_note_cas(&path, "first\nsecond\n", Some("first\n")),
            Ok(None)
        );
        assert_eq!(read_note(&path), Ok(Some("first\nsecond\n".into())));
        // No temporary file is left behind.
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("today.md")]);
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn starts_obsidian_only_when_asked() {
        assert_eq!(may_run(false, true), Ok(()));
        assert_eq!(may_run(true, true), Ok(()));
        assert_eq!(may_run(true, false), Ok(()));
        assert!(may_run(false, false)
            .unwrap_err()
            .starts_with("not_running:"));
    }

    #[test]
    fn a_cli_error_is_no_path() {
        let run = |_: &[String]| {
            Ok(CliOutput {
                stdout: "Error: vault not found\n".into(),
                code: Some(0),
            })
        };
        assert!(resolve_daily_note("Work", &run).is_err());
        let failed = |_: &[String]| {
            Ok(CliOutput {
                stdout: "/x\n".into(),
                code: Some(1),
            })
        };
        assert!(resolve_daily_note("Work", &failed).is_err());
        assert!(resolve_daily_note("a\nb", &failed).is_err());
    }
}

/// Against a real, running Obsidian with its CLI on. Opt in:
/// `SECRETARY_OBSIDIAN_VAULT=<vault> cargo test real_obsidian -- --ignored`.
#[cfg(test)]
mod real_obsidian {
    use super::*;

    #[test]
    #[ignore]
    fn real_obsidian_answers() {
        let vault = std::env::var("SECRETARY_OBSIDIAN_VAULT").expect("SECRETARY_OBSIDIAN_VAULT");
        let bin = find_binary(None).expect("obsidian binary");
        ensure_running(&bin).expect("Obsidian running");
        let args: Vec<String> = [
            format!("vault={vault}"),
            "files".into(),
            "ext=md".into(),
            "total".into(),
        ]
        .into();
        validate_args(&args).expect("allowed");
        let out = run_blocking(&bin, &args, TIMEOUT).expect("ran");
        assert!(
            out.stdout.trim().parse::<u32>().is_ok(),
            "expected a count, got {:?}",
            out.stdout
        );
    }
}

#[cfg(test)]
mod socket_tests {
    use super::cli_socket;
    use std::path::{Path, PathBuf};

    #[test]
    fn socket_per_os() {
        let home = Path::new("/home/rick");
        assert_eq!(
            cli_socket("linux", Some(home), Some(Path::new("/run/user/1000")), None),
            Some(PathBuf::from("/run/user/1000/.obsidian-cli.sock"))
        );
        assert_eq!(
            cli_socket("linux", Some(home), None, None),
            Some(PathBuf::from("/home/rick/.obsidian-cli.sock"))
        );
        assert_eq!(
            cli_socket(
                "macos",
                Some(Path::new("/Users/rick")),
                Some(Path::new("/tmp/x")),
                None
            ),
            Some(PathBuf::from("/Users/rick/.obsidian-cli.sock"))
        );
        assert_eq!(
            cli_socket("windows", None, None, Some("rick")),
            Some(PathBuf::from(r"\\.\pipe\obsidian-cli-rick"))
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn allows_read_only_commands() {
        for ok in [
            &["vaults"][..],
            &["version"],
            &[
                "vault=Work",
                "search:context",
                "query=ledger export",
                "format=json",
                "limit=20",
            ],
            &["vault=My Notes", "read", "path=Projects/Ledger.md"],
            &["read", "file=Ledger"],
            &["vault=Work", "files", "folder=Projects", "ext=md", "total"],
            &["vault=Work", "tags", "counts", "verbose"],
            &["search", "query=a=b", "case"],
            &["backlinks", "path=a.md"],
            &["aliases"],
            &["links", "file=x"],
            &["file", "path=x.md"],
        ] {
            assert_eq!(validate_args(&args(ok)), Ok(()), "{ok:?}");
        }
    }

    #[test]
    fn refuses_everything_else() {
        for bad in [
            &[][..],
            &["vault=Work"],
            &["vault=", "vaults"],
            &["create", "path=x.md"],
            &["vault=Work", "delete", "path=x.md"],
            &["read", "path=x.md", "--copy"],
            &["read", "path=x.md", "copy"],
            &["read", "content=hello"],
            &["read", "path="],
            &["read", "path=a\nb"],
            &["read", "vault=Other"],
            &["search", "vault=Work"],
            &["Vault=Work", "read"],
            &["eval", "code=1"],
        ] {
            assert!(validate_args(&args(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn limits_count_and_length() {
        let mut many = args(&["search"]);
        many.extend((0..MAX_ARGS).map(|_| "case".to_string()));
        assert!(validate_args(&many).is_err());
        let long = format!("query={}", "x".repeat(MAX_ARG_LEN));
        assert!(validate_args(&["search".into(), long]).is_err());
        let fits = format!("query={}", "x".repeat(MAX_ARG_LEN - 6));
        assert_eq!(validate_args(&["search".into(), fits]), Ok(()));
    }

    #[test]
    fn candidates_per_os() {
        let path = [PathBuf::from("/a"), PathBuf::from("/b")];
        assert_eq!(
            default_candidates("macos", Some(Path::new("/Users/r")), None, &path),
            [
                "/usr/local/bin/obsidian",
                "/opt/homebrew/bin/obsidian",
                "/a/obsidian",
                "/b/obsidian"
            ]
            .map(PathBuf::from)
        );
        assert_eq!(
            default_candidates("linux", Some(Path::new("/home/r")), None, &path),
            ["/home/r/.local/bin/obsidian", "/a/obsidian", "/b/obsidian"].map(PathBuf::from)
        );
        assert_eq!(
            default_candidates("linux", None, None, &[]),
            Vec::<PathBuf>::new()
        );
        let local = PathBuf::from("/L");
        assert_eq!(
            default_candidates("windows", None, Some(&local), &path),
            [
                local.join("Programs").join("Obsidian").join("Obsidian.com"),
                PathBuf::from("/a").join("Obsidian.com"),
                PathBuf::from("/b").join("Obsidian.com"),
            ]
        );
    }

    #[test]
    fn resolves_first_existing_candidate() {
        let c = [PathBuf::from("/x/obsidian"), PathBuf::from("/y/obsidian")];
        let found = resolve_binary(None, &c, |p| p == Path::new("/y/obsidian"));
        assert_eq!(found, Ok(PathBuf::from("/y/obsidian")));
        let blank = resolve_binary(Some("  "), &c, |p| p == Path::new("/x/obsidian"));
        assert_eq!(blank, Ok(PathBuf::from("/x/obsidian")));
        let none = resolve_binary(None, &c, |_| false).unwrap_err();
        assert!(none.starts_with("not_installed:"), "{none}");
    }

    #[test]
    fn configured_path_wins_and_must_exist() {
        let abs = if cfg!(windows) {
            r"C:\Tools\Obsidian.com"
        } else {
            "/opt/obsidian"
        };
        let c = [PathBuf::from("/x/obsidian")];
        assert_eq!(
            resolve_binary(Some(abs), &c, |_| true),
            Ok(PathBuf::from(abs))
        );
        let missing = resolve_binary(Some(abs), &c, |p| p == Path::new("/x/obsidian")).unwrap_err();
        assert!(missing.starts_with("not_installed:"), "{missing}");
        let relative = resolve_binary(Some("obsidian"), &c, |_| true).unwrap_err();
        assert!(relative.starts_with("not_installed:"), "{relative}");
    }

    #[cfg(unix)]
    #[test]
    fn runs_and_times_out() {
        let sh = Path::new("/bin/sh");
        let out = run_blocking(sh, &args(&["-c", "echo hi"]), TIMEOUT).unwrap();
        assert_eq!(
            out,
            CliOutput {
                stdout: "hi\n".into(),
                code: Some(0)
            }
        );
        let err = run_blocking(sh, &args(&["-c", "echo oops >&2; exit 3"]), TIMEOUT).unwrap();
        assert_eq!(
            err,
            CliOutput {
                stdout: "oops\n".into(),
                code: Some(3)
            }
        );
        // A process left running with the pipes open does not hold the result.
        let started = Instant::now();
        let bg = run_blocking(sh, &args(&["-c", "sleep 10 & echo hi"]), TIMEOUT).unwrap();
        assert_eq!(bg.stdout, "hi\n");
        assert!(started.elapsed() < Duration::from_secs(5));
        let slow = run_blocking(sh, &args(&["-c", "sleep 5"]), Duration::from_millis(200));
        assert!(slow.unwrap_err().starts_with("timeout:"));
    }
}
