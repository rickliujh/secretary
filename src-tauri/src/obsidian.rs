//! Runs the official Obsidian CLI (Obsidian 1.12.7+) for data sources (D41).
//!
//! The `obsidian` binary talks to the running Obsidian app (starting it when
//! needed) and prints the command's text result. Only read-only subcommands and
//! a fixed set of options are allowed; the check lives here, not in the webview.
//! The command runs without a shell.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// The first call may have to start Obsidian.
const TIMEOUT: Duration = Duration::from_secs(30);
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
];
const KEYS: &[&str] = &["query", "path", "file", "limit", "format", "folder", "ext"];
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

/// Runs one read-only `obsidian` command. Errors start with "not_installed:",
/// "timeout:" or describe a refused argument or a failed start.
#[tauri::command]
pub async fn obsidian_cli(
    args: Vec<String>,
    cli_path: Option<String>,
) -> Result<CliOutput, String> {
    validate_args(&args)?;
    let bin = find_binary(cli_path.as_deref())?;
    tauri::async_runtime::spawn_blocking(move || run_blocking(&bin, &args, TIMEOUT))
        .await
        .map_err(|e| format!("the obsidian command failed: {e}"))?
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
