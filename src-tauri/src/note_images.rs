//! Images in the note (D70, FR-20.9).
//!
//! An image pasted or dropped into the note is saved as a file where Obsidian
//! would put it, named as Obsidian names a pasted image and linked as Obsidian
//! would link it, following the vault's own `.obsidian/app.json`
//! (`attachmentFolderPath`, `useMarkdownLinks`, `newLinkFormat`). Without a
//! vault it goes to `<app data>/notes/attachments/`. The vault folder and the
//! note's path come from the two read-only CLI lookups the daily note already
//! uses (`obsidian::resolve_vault_note`); the CLI allowlist is not touched.
//!
//! The only write is the image file: created new (never over an existing
//! file), only after the folder it goes in is found inside the vault (or the
//! app's attachments folder) with links resolved. Loading an image never starts
//! Obsidian, reads only files inside those folders, and caps the size. A link
//! target is checked on its text before any file is looked at: a backslash, a
//! colon or NUL is refused, and `..` is worked out lexically and may not climb
//! above the vault root, so no path outside (a UNC share, another drive, a
//! folder the OS guards) is ever opened or even checked for existence.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::obsidian::{cli_runner, existing_ancestor, resolve_vault_note};

/// The largest image saved or loaded.
pub const MAX_BYTES: usize = 20 * 1024 * 1024;
/// How many entries the search for a bare name looks at in the vault.
pub const WALK_LIMIT: usize = 5_000;
/// How many ` 1`, ` 2`... names are tried before giving up.
const MAX_COLLISIONS: usize = 1_000;

/// The three settings of the vault's `.obsidian/app.json` that decide where a
/// pasted image goes and how it is linked. Missing keys take Obsidian's defaults.
#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultSettings {
    /// Default "/": the vault root.
    pub attachment_folder_path: Option<String>,
    /// Default false: wikilinks.
    pub use_markdown_links: Option<bool>,
    /// Default "shortest"; also "relative" and "absolute".
    pub new_link_format: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkFormat {
    Shortest,
    Relative,
    Absolute,
}

impl VaultSettings {
    /// The settings from `app.json`'s text; anything unreadable gives the defaults.
    pub fn parse(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_default()
    }

    /// The vault's settings; a missing or unreadable `app.json` gives the defaults.
    pub fn of_vault(root: &Path) -> Self {
        std::fs::read_to_string(root.join(".obsidian").join("app.json"))
            .map(|t| Self::parse(&t))
            .unwrap_or_default()
    }

    fn folder(&self) -> &str {
        self.attachment_folder_path.as_deref().unwrap_or("/")
    }

    fn markdown(&self) -> bool {
        self.use_markdown_links.unwrap_or(false)
    }

    fn format(&self) -> LinkFormat {
        match self.new_link_format.as_deref() {
            Some("relative") => LinkFormat::Relative,
            Some("absolute") => LinkFormat::Absolute,
            _ => LinkFormat::Shortest,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SavedImage {
    pub path: String,
    /// The link text to insert, as Obsidian would write it.
    pub link: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct LoadedImage {
    pub mime: String,
    /// The file's bytes, base64.
    pub data: String,
}

/// The extension a pasted image is saved with: png, jpg (for JPEG), gif, webp.
pub fn save_ext(ext: &str) -> Result<&'static str, String> {
    match ext
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Ok("png"),
        "jpg" | "jpeg" => Ok("jpg"),
        "gif" => Ok("gif"),
        "webp" => Ok("webp"),
        other => Err(format!(
            "an image of type \"{other}\" is not saved (png, jpg, gif or webp)"
        )),
    }
}

/// The type of an image file by its extension; None for anything else (svg included).
pub fn mime_for(name: &str) -> Option<&'static str> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => return None,
    })
}

/// Refuses data over the size cap.
pub fn check_size(len: usize) -> Result<(), String> {
    if len > MAX_BYTES {
        return Err(format!(
            "the image is larger than {} MB",
            MAX_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// The name Obsidian gives a pasted image: `Pasted image <stamp>.<ext>`, then
/// `Pasted image <stamp> 1.<ext>`, ` 2`... on a collision.
pub fn image_name(stamp: &str, ext: &str, n: usize) -> String {
    if n == 0 {
        format!("Pasted image {stamp}.{ext}")
    } else {
        format!("Pasted image {stamp} {n}.{ext}")
    }
}

/// Text that could name something other than a plain path inside a folder on
/// some platform: a backslash (a UNC path or a Windows separator), a colon (a
/// drive or a stream) or NUL. Refused before any file is looked at.
pub fn unsafe_text(text: &str) -> bool {
    text.contains(['\\', ':', '\0'])
}

/// Whether every part of a relative path is a plain name (no root, drive,
/// `.` or `..`), so joining it to a folder stays in that folder lexically.
pub fn all_normal(path: &Path) -> bool {
    path.components().all(|c| matches!(c, Component::Normal(_)))
}

/// Plain folder names from a `/`-separated path; `..`, a backslash, a colon
/// or NUL is refused.
fn plain_parts(path: &str) -> Result<PathBuf, String> {
    if unsafe_text(path) {
        return Err(format!(
            "the attachment folder \"{path}\" is not a plain folder path"
        ));
    }
    let mut out = PathBuf::new();
    for part in path.split('/') {
        match part.trim() {
            "" | "." => {}
            ".." => {
                return Err(format!(
                    "the attachment folder \"{path}\" climbs out of the vault"
                ))
            }
            _ => out.push(part),
        }
    }
    Ok(out)
}

/// `target` (`/`-separated, `..` allowed) from the vault-relative folder
/// `base`, worked out on the text alone: None when it climbs above the vault
/// root, or holds a backslash, a colon or NUL. The result has only plain names.
pub fn lexical_rel(base: &Path, target: &str) -> Option<PathBuf> {
    if unsafe_text(target) || !all_normal(base) {
        return None;
    }
    let mut parts: Vec<&std::ffi::OsStr> = base.iter().collect();
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            name => parts.push(std::ffi::OsStr::new(name)),
        }
    }
    let out: PathBuf = parts.into_iter().collect();
    all_normal(&out).then_some(out)
}

/// The attachment folder relative to the vault root, by Obsidian's rule for
/// `attachmentFolderPath`: `/` or empty is the root, `.` or `./` the note's own
/// folder, `./x` the folder `x` beside the note, `x` the folder `x` from the root.
pub fn attachment_folder(setting: &str, note_dir: &Path) -> Result<PathBuf, String> {
    let s = setting.trim();
    if s.is_empty() || s == "/" {
        return Ok(PathBuf::new());
    }
    if s == "." || s == "./" {
        return Ok(note_dir.to_path_buf());
    }
    if let Some(rest) = s.strip_prefix("./") {
        return Ok(note_dir.join(plain_parts(rest)?));
    }
    plain_parts(s.trim_start_matches('/'))
}

/// A path's parts joined with `/`, as links write them.
fn slashed(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(p) => Some(p.to_string_lossy().into_owned()),
            Component::ParentDir => Some("..".into()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// The path from the folder `from` to the file `to`, both relative to the vault.
pub fn relative_path(from: &Path, to: &Path) -> String {
    let a: Vec<_> = from.components().collect();
    let b: Vec<_> = to.components().collect();
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let mut out = PathBuf::new();
    for _ in common..a.len() {
        out.push("..");
    }
    for c in &b[common..] {
        out.push(c.as_os_str());
    }
    slashed(&out)
}

/// Encodes a markdown link target as Obsidian 1.15 does: only a backslash,
/// control characters and the space are percent-encoded (a space is `%20`).
pub fn encode_target(target: &str) -> String {
    let mut out = String::with_capacity(target.len());
    for c in target.chars() {
        let encoded = matches!(c, '\\' | '\x00' | '\x08' | '\x0B' | '\x0C' | ' ')
            || ('\x0E'..='\x1F').contains(&c);
        if encoded {
            out.push_str(&format!("%{:02X}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

/// The link text for a saved image, as Obsidian's `fileToLinktext` makes it
/// for wikilinks and markdown links alike: the name when it is the only file
/// of that name in the vault (shortest; otherwise the path from the root), the
/// path from the note's folder (relative) or from the vault root (absolute).
/// `![[target]]`, or `![](target)` encoded with markdown links.
pub fn link_text(
    settings: &VaultSettings,
    name: &str,
    file: &Path,
    note_dir: &Path,
    name_unique: bool,
) -> String {
    let target = match settings.format() {
        LinkFormat::Shortest if name_unique => name.to_string(),
        LinkFormat::Shortest | LinkFormat::Absolute => slashed(file),
        LinkFormat::Relative => relative_path(note_dir, file),
    };
    if settings.markdown() {
        format!("![]({})", encode_target(&target))
    } else {
        format!("![[{target}]]")
    }
}

/// `path` relative to the canonical `root`, with links resolved in the part
/// that exists; None when it is not inside.
fn inside(root: &Path, path: &Path) -> Option<PathBuf> {
    let base = existing_ancestor(path)?;
    let resolved = base.canonicalize().ok()?;
    let rest = path.strip_prefix(base).ok()?;
    if rest
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return None;
    }
    resolved
        .join(rest)
        .strip_prefix(root)
        .ok()
        .map(Path::to_path_buf)
}

/// Makes `dir` (relative to `root`) and checks that it lies inside `root`
/// before and after, links resolved: a link out of the root is refused.
fn contained_dir(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let dir = root.join(rel);
    let outside = || format!("the folder {} is outside the vault", dir.display());
    // On the text first: nothing outside the vault is looked at.
    if !all_normal(rel) {
        return Err(outside());
    }
    inside(root, &dir).ok_or_else(outside)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("the folder {} cannot be made: {e}", dir.display()))?;
    let resolved = dir.canonicalize().map_err(|_| outside())?;
    if !resolved.starts_with(root) {
        return Err(outside());
    }
    Ok(resolved)
}

/// Writes `data` as a new file `Pasted image <stamp>[ n].<ext>` in `dir`,
/// never over an existing file. Returns the name.
pub fn create_unique(dir: &Path, stamp: &str, ext: &str, data: &[u8]) -> Result<String, String> {
    for n in 0..MAX_COLLISIONS {
        let name = image_name(stamp, ext, n);
        let path = dir.join(&name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(e) = file.write_all(data).and_then(|_| file.sync_all()) {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("the image cannot be written: {e}"));
                }
                return Ok(name);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("the image cannot be written: {e}")),
        }
    }
    Err("no free name for the image".into())
}

/// The note's folder relative to the canonical vault root.
fn note_dir(root: &Path, note: &Path) -> Result<PathBuf, String> {
    let dir = note.parent().unwrap_or(root);
    inside(root, dir)
        .ok_or_else(|| format!("the daily note {} is outside the vault", note.display()))
}

/// Saves an image in the vault by its settings; `root` is the canonical vault folder.
pub fn save_in_vault(
    root: &Path,
    note: &Path,
    settings: &VaultSettings,
    stamp: &str,
    ext: &str,
    data: &[u8],
) -> Result<SavedImage, String> {
    let ext = save_ext(ext)?;
    check_size(data.len())?;
    let note_dir = note_dir(root, note)?;
    let folder = attachment_folder(settings.folder(), &note_dir)?;
    let dir = contained_dir(root, &folder)?;
    let name = create_unique(&dir, stamp, ext, data)?;
    let unique =
        settings.format() != LinkFormat::Shortest || count_named(root, &name, WALK_LIMIT) <= 1;
    let link = link_text(settings, &name, &folder.join(&name), &note_dir, unique);
    Ok(SavedImage {
        path: dir.join(&name).to_string_lossy().into_owned(),
        link,
    })
}

/// Saves an image in the app's attachments folder, linked as `![[name]]`.
pub fn save_in_folder(
    dir: &Path,
    stamp: &str,
    ext: &str,
    data: &[u8],
) -> Result<SavedImage, String> {
    let ext = save_ext(ext)?;
    check_size(data.len())?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("the folder {} cannot be made: {e}", dir.display()))?;
    let name = create_unique(dir, stamp, ext, data)?;
    Ok(SavedImage {
        path: dir.join(&name).to_string_lossy().into_owned(),
        link: format!("![[{name}]]"),
    })
}

/// Files named `name` (case ignored, as Obsidian resolves links) in the vault,
/// breadth first, at most `limit` entries looked at and at most `max` found;
/// hidden folders (`.obsidian` among them) and links are not entered.
fn walk_named(root: &Path, name: &str, limit: usize, max: usize) -> Vec<PathBuf> {
    let wanted = name.to_lowercase();
    let mut found = Vec::new();
    let mut queue = VecDeque::from([root.to_path_buf()]);
    let mut seen = 0usize;
    while let Some(dir) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > limit {
                return found;
            }
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if file_name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                queue.push_back(entry.path());
            } else if kind.is_file() && file_name.to_lowercase() == wanted {
                found.push(entry.path());
                if found.len() >= max {
                    return found;
                }
            }
        }
    }
    found
}

/// A file named `name` in the vault (case ignored), breadth first, at most
/// `limit` entries looked at; hidden folders and links are not entered.
pub fn walk_for(root: &Path, name: &str, limit: usize) -> Option<PathBuf> {
    walk_named(root, name, limit, 1).into_iter().next()
}

/// How many files of this name the vault holds, counting to two at most.
fn count_named(root: &Path, name: &str, limit: usize) -> usize {
    walk_named(root, name, limit, 2).len()
}

/// The candidate paths for a link target, in the order to try: a target with a
/// folder from the vault root and from the note's folder (the note's folder
/// first when links are relative, the root only first for a leading `/`); a
/// bare name in the attachment folder, the note's folder, then the vault root.
/// Worked out on the text alone: a target with a backslash, a colon or NUL,
/// or one that climbs above the vault root, gives no candidate. The walk for a
/// bare name comes after these.
pub fn candidates(
    root: &Path,
    note_dir: &Path,
    settings: &VaultSettings,
    target: &str,
) -> Vec<PathBuf> {
    let target = target.trim();
    if unsafe_text(target) {
        return Vec::new();
    }
    let top = Path::new("");
    let rels: Vec<Option<PathBuf>> = if target.contains('/') {
        let from_root = lexical_rel(top, target);
        let from_note = lexical_rel(note_dir, target);
        if settings.format() == LinkFormat::Relative && !target.starts_with('/') {
            vec![from_note, from_root]
        } else {
            vec![from_root, from_note]
        }
    } else {
        let folder = attachment_folder(settings.folder(), note_dir).ok();
        vec![
            folder.and_then(|f| lexical_rel(&f, target)),
            lexical_rel(note_dir, target),
            lexical_rel(top, target),
        ]
    };
    let mut out: Vec<PathBuf> = Vec::new();
    for rel in rels.into_iter().flatten() {
        let path = root.join(rel);
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// An existing file at `path` whose resolved place lies inside `root`. The
/// part of `path` under `root` must be plain names before anything is looked at.
fn contained_file(root: &Path, path: &Path) -> Option<PathBuf> {
    if !path.strip_prefix(root).is_ok_and(all_normal) {
        return None;
    }
    let resolved = path.canonicalize().ok()?;
    (resolved.starts_with(root) && resolved.is_file()).then_some(resolved)
}

/// Where a link target is in the vault; None when nowhere inside it.
pub fn find_in_vault(
    root: &Path,
    note: &Path,
    settings: &VaultSettings,
    target: &str,
) -> Option<PathBuf> {
    let target = target.trim();
    if unsafe_text(target) {
        return None;
    }
    let note_dir = note_dir(root, note).ok()?;
    if let Some(found) = candidates(root, &note_dir, settings, target)
        .iter()
        .find_map(|p| contained_file(root, p))
    {
        return Some(found);
    }
    if target.contains('/') || target == "." || target == ".." {
        return None;
    }
    walk_for(root, target, WALK_LIMIT).and_then(|p| contained_file(root, &p))
}

/// Where a link target is in the app's attachments folder: a bare file name only.
pub fn find_in_folder(dir: &Path, target: &str) -> Option<PathBuf> {
    let name = target.trim();
    if unsafe_text(name) || name.contains('/') || !all_normal(Path::new(name)) {
        return None;
    }
    let root = dir.canonicalize().ok()?;
    contained_file(&root, &root.join(name))
}

/// The image file's bytes as base64 with its type; None for a type not shown.
/// Reads at most one byte over the cap through the open file, and fails then.
pub fn read_image(path: &Path) -> Result<Option<LoadedImage>, String> {
    let Some(mime) = mime_for(&path.to_string_lossy()) else {
        return Ok(None);
    };
    let cannot = |e: std::io::Error| format!("the image {} cannot be read: {e}", path.display());
    let file = std::fs::File::open(path).map_err(cannot)?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(cannot)?;
    check_size(bytes.len())?;
    Ok(Some(LoadedImage {
        mime: mime.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

/// Base64 from the webview to bytes, refusing more than the size cap.
pub fn decode(data: &str) -> Result<Vec<u8>, String> {
    // Four characters carry three bytes; refuse before decoding a huge string.
    if data.len() / 4 * 3 > MAX_BYTES + 3 {
        check_size(MAX_BYTES + 1)?;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("the image data is not base64: {e}"))?;
    check_size(bytes.len())?;
    Ok(bytes)
}

// ---------------------------------------------------------------------------
// The vault and note lookups, kept a minute
// ---------------------------------------------------------------------------

/// How long a vault's folder and note path are reused before the CLI is asked again.
pub const LOOKUP_TTL: Duration = Duration::from_secs(60);

type Lookup = (PathBuf, PathBuf);

/// The vault folder and the daily note's path per vault, reused for a minute,
/// so a note with ten images asks the CLI twice, not twenty times. The lock is
/// held while the CLI answers, so loads that arrive together wait for one lookup.
#[derive(Default)]
pub struct LookupCache {
    map: Mutex<HashMap<String, (Instant, Lookup)>>,
}

impl LookupCache {
    pub fn get_or(
        &self,
        vault: &str,
        now: Instant,
        resolve: impl FnOnce() -> Result<Lookup, String>,
    ) -> Result<Lookup, String> {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, hit)) = map.get(vault) {
            if now.saturating_duration_since(*at) < LOOKUP_TTL {
                return Ok(hit.clone());
            }
        }
        let found = resolve()?;
        map.insert(vault.to_string(), (now, found.clone()));
        Ok(found)
    }
}

fn lookups() -> &'static LookupCache {
    static CACHE: OnceLock<LookupCache> = OnceLock::new();
    CACHE.get_or_init(LookupCache::default)
}

/// The vault and the note, from the cache or the CLI (`launch` as the caller asked).
fn vault_note(vault: &str, cli_path: Option<String>, launch: bool) -> Result<Lookup, String> {
    lookups().get_or(vault, Instant::now(), || {
        let run = cli_runner(cli_path, launch)?;
        resolve_vault_note(vault, &run)
    })
}

fn app_attachments<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("the app's data folder is unknown: {e}"))?;
    Ok(base.join("notes").join("attachments"))
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d%H%M%S").to_string()
}

fn chosen(vault: Option<String>) -> Option<String> {
    vault.filter(|v| !v.trim().is_empty())
}

/// Saves a pasted or dropped image (D70) and returns its path and the link
/// text to insert. With a vault: where Obsidian would put it, by the vault's
/// settings; `launch` starts a closed Obsidian for the lookups. Without: the
/// app's attachments folder.
#[tauri::command]
pub async fn note_image_save<R: Runtime>(
    app: AppHandle<R>,
    vault: Option<String>,
    cli_path: Option<String>,
    launch: bool,
    data: String,
    ext: String,
) -> Result<SavedImage, String> {
    let folder = app_attachments(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode(&data)?;
        match chosen(vault) {
            Some(vault) => {
                let (root, note) = vault_note(&vault, cli_path, launch)?;
                let settings = VaultSettings::of_vault(&root);
                save_in_vault(&root, &note, &settings, &stamp(), &ext, &bytes)
            }
            None => save_in_folder(&folder, &stamp(), &ext, &bytes),
        }
    })
    .await
    .map_err(|e| format!("saving the image failed: {e}"))?
}

/// Loads the image a link names (its target, decoded): null when it is not
/// found or not an image type. Never starts Obsidian: a closed one is
/// "not_running:" (unless the lookups are still fresh).
#[tauri::command]
pub async fn note_image_load<R: Runtime>(
    app: AppHandle<R>,
    vault: Option<String>,
    cli_path: Option<String>,
    link: String,
) -> Result<Option<LoadedImage>, String> {
    if mime_for(link.trim()).is_none() || unsafe_text(&link) {
        return Ok(None);
    }
    let folder = app_attachments(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let found = match chosen(vault) {
            Some(vault) => {
                let (root, note) = vault_note(&vault, cli_path, false)?;
                let settings = VaultSettings::of_vault(&root);
                find_in_vault(&root, &note, &settings, &link)
            }
            None => find_in_folder(&folder, &link),
        };
        match found {
            Some(path) => read_image(&path),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("loading the image failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obsidian::daily_note_tests::{fake_cli, temp_dir};
    use std::cell::RefCell;

    fn settings(
        folder: Option<&str>,
        markdown: Option<bool>,
        format: Option<&str>,
    ) -> VaultSettings {
        VaultSettings {
            attachment_folder_path: folder.map(Into::into),
            use_markdown_links: markdown,
            new_link_format: format.map(Into::into),
        }
    }

    /// A vault in a temp folder with its daily note at `Daily/2026-11-05.md`.
    fn vault(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let top = temp_dir(name);
        let root = top.join("vault");
        std::fs::create_dir_all(root.join("Daily")).unwrap();
        let root = root.canonicalize().unwrap();
        let note = root.join("Daily").join("2026-11-05.md");
        (top, root, note)
    }

    #[test]
    fn reads_the_three_settings_with_obsidians_defaults() {
        let s = VaultSettings::parse(
            r#"{"attachmentFolderPath":"./assets","useMarkdownLinks":true,"newLinkFormat":"relative","alwaysUpdateLinks":true}"#,
        );
        assert_eq!(s, settings(Some("./assets"), Some(true), Some("relative")));
        assert_eq!(s.format(), LinkFormat::Relative);
        let empty = VaultSettings::parse("{}");
        assert_eq!(empty.folder(), "/");
        assert!(!empty.markdown());
        assert_eq!(empty.format(), LinkFormat::Shortest);
        assert_eq!(VaultSettings::parse("not json"), VaultSettings::default());
        assert_eq!(
            VaultSettings::parse(r#"{"newLinkFormat":"odd"}"#).format(),
            LinkFormat::Shortest
        );
        let (top, root, _) = vault("settings");
        assert_eq!(VaultSettings::of_vault(&root), VaultSettings::default());
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::write(
            root.join(".obsidian").join("app.json"),
            r#"{"attachmentFolderPath":"Files"}"#,
        )
        .unwrap();
        assert_eq!(VaultSettings::of_vault(&root).folder(), "Files");
        std::fs::remove_dir_all(top).unwrap();
    }

    #[test]
    fn the_folder_rule_for_each_form() {
        let note = Path::new("Daily");
        assert_eq!(attachment_folder("/", note), Ok(PathBuf::new()));
        assert_eq!(attachment_folder("", note), Ok(PathBuf::new()));
        assert_eq!(attachment_folder(".", note), Ok(PathBuf::from("Daily")));
        assert_eq!(attachment_folder("./", note), Ok(PathBuf::from("Daily")));
        assert_eq!(
            attachment_folder("./assets", note),
            Ok(Path::new("Daily").join("assets"))
        );
        assert_eq!(
            attachment_folder("Files/Images", note),
            Ok(Path::new("Files").join("Images"))
        );
        assert_eq!(
            attachment_folder("/Files", note),
            Ok(PathBuf::from("Files"))
        );
        assert_eq!(attachment_folder(".", Path::new("")), Ok(PathBuf::new()));
        assert!(attachment_folder("../outside", note).is_err());
        assert!(attachment_folder("./../../outside", note).is_err());
        assert!(attachment_folder("Files/../../x", note).is_err());
    }

    #[test]
    fn names_as_obsidian_with_collisions() {
        assert_eq!(
            image_name("20261105093000", "png", 0),
            "Pasted image 20261105093000.png"
        );
        assert_eq!(
            image_name("20261105093000", "jpg", 2),
            "Pasted image 20261105093000 2.jpg"
        );
        let dir = temp_dir("names");
        assert_eq!(
            create_unique(&dir, "1", "png", b"a"),
            Ok("Pasted image 1.png".into())
        );
        assert_eq!(
            create_unique(&dir, "1", "png", b"b"),
            Ok("Pasted image 1 1.png".into())
        );
        assert_eq!(
            create_unique(&dir, "1", "png", b"c"),
            Ok("Pasted image 1 2.png".into())
        );
        // The first file was not written over.
        assert_eq!(std::fs::read(dir.join("Pasted image 1.png")).unwrap(), b"a");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn link_text_follows_the_format_for_wikilinks_and_markdown() {
        let name = "Pasted image 1.png";
        let file = Path::new("Files").join(name);
        let note = Path::new("Daily");
        let link = |markdown: Option<bool>, format: Option<&str>, unique: bool| {
            link_text(&settings(None, markdown, format), name, &file, note, unique)
        };
        // Wikilinks (the default), as Obsidian's fileToLinktext writes them.
        assert_eq!(link(None, None, true), "![[Pasted image 1.png]]");
        assert_eq!(link(None, None, false), "![[Files/Pasted image 1.png]]");
        assert_eq!(
            link(Some(false), Some("relative"), true),
            "![[../Files/Pasted image 1.png]]"
        );
        assert_eq!(
            link(Some(false), Some("absolute"), true),
            "![[Files/Pasted image 1.png]]"
        );
        // Markdown links, a space as %20.
        assert_eq!(link(Some(true), None, true), "![](Pasted%20image%201.png)");
        assert_eq!(
            link(Some(true), Some("shortest"), false),
            "![](Files/Pasted%20image%201.png)"
        );
        assert_eq!(
            link(Some(true), Some("relative"), true),
            "![](../Files/Pasted%20image%201.png)"
        );
        assert_eq!(
            link(Some(true), Some("absolute"), true),
            "![](Files/Pasted%20image%201.png)"
        );
        let beside = Path::new("Daily").join("assets").join(name);
        assert_eq!(relative_path(note, &beside), "assets/Pasted image 1.png");
        assert_eq!(
            relative_path(Path::new(""), &beside),
            "Daily/assets/Pasted image 1.png"
        );
        assert_eq!(
            relative_path(note, Path::new(name)),
            "../Pasted image 1.png"
        );
        // Obsidian 1.15 encodes only the backslash, control characters and the space.
        assert_eq!(encode_target("a b(c)/é\\\t"), "a%20b(c)/é%5C\t");
        assert_eq!(encode_target("a\x0Eb\x01"), "a%0Eb\x01");
    }

    #[test]
    fn shortest_uses_the_path_when_the_name_is_not_unique() {
        let (top, root, note) = vault("unique");
        std::fs::create_dir_all(root.join("Other")).unwrap();
        std::fs::write(root.join("Other/pasted image 5.png"), b"old").unwrap();
        let s = settings(Some("Files"), None, None);
        let saved = save_in_vault(&root, &note, &s, "5", "png", b"new").unwrap();
        assert_eq!(saved.link, "![[Files/Pasted image 5.png]]");
        let saved = save_in_vault(&root, &note, &s, "6", "png", b"new").unwrap();
        assert_eq!(saved.link, "![[Pasted image 6.png]]");
        std::fs::remove_dir_all(top).unwrap();
    }

    #[test]
    fn targets_are_checked_on_the_text_before_any_file() {
        let top = Path::new("");
        let daily = Path::new("Daily");
        assert_eq!(
            lexical_rel(daily, "a.png"),
            Some(PathBuf::from("Daily/a.png"))
        );
        assert_eq!(
            lexical_rel(daily, "../Files/a.png"),
            Some(PathBuf::from("Files/a.png"))
        );
        assert_eq!(
            lexical_rel(daily, "./x/../a.png"),
            Some(PathBuf::from("Daily/a.png"))
        );
        assert_eq!(
            lexical_rel(top, "/Files/a.png"),
            Some(PathBuf::from("Files/a.png"))
        );
        assert_eq!(lexical_rel(daily, "../../a.png"), None);
        assert_eq!(lexical_rel(top, "../a.png"), None);
        assert_eq!(lexical_rel(top, r"\\evil\s\a.png"), None);
        assert_eq!(lexical_rel(top, "C:/Users/a.png"), None);
        assert_eq!(lexical_rel(top, "C:a.png"), None);
        assert_eq!(lexical_rel(top, "a\0.png"), None);
        assert!(unsafe_text(r"\\evil\s\a.png"));
        assert!(unsafe_text("C:a.png"));
        assert!(!unsafe_text("Files/a b.png"));
        assert!(attachment_folder(r"Files\Images", daily).is_err());
        assert!(attachment_folder("C:/x", daily).is_err());

        // None of these gives a candidate, so nothing outside is ever looked at.
        let root = Path::new("/vault");
        let s = settings(None, None, Some("relative"));
        for bad in [
            r"\\evil\s\a.png",
            r"..\..\a.png",
            "C:/Users/a.png",
            "C:a.png",
            "../../../../etc/a.png",
            "../../Documents/x.png",
        ] {
            assert_eq!(
                candidates(root, daily, &s, bad),
                Vec::<PathBuf>::new(),
                "{bad}"
            );
        }
        // `..` within the vault stays a candidate, on the text alone.
        assert_eq!(
            candidates(root, daily, &s, "../Files/a.png"),
            vec![root.join("Files/a.png")]
        );

        let (top_dir, vroot, note) = vault("unsafe");
        std::fs::write(top_dir.join("x.png"), b"out").unwrap();
        for bad in [
            r"\\evil\s\a.png",
            "C:x.png",
            "../x.png",
            "..",
            "../../x.png",
        ] {
            assert_eq!(find_in_vault(&vroot, &note, &s, bad), None, "{bad}");
        }
        let dir = top_dir.join("app");
        std::fs::create_dir_all(&dir).unwrap();
        for bad in [r"\\evil\s\a.png", "C:x.png", "../x.png", "..", "a/b.png"] {
            assert_eq!(find_in_folder(&dir, bad), None, "{bad}");
        }
        std::fs::remove_dir_all(top_dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_image_file_out_of_the_vault_is_not_read() {
        let (top, root, note) = vault("linked-file");
        std::fs::write(top.join("secret.png"), b"secret").unwrap();
        std::os::unix::fs::symlink(top.join("secret.png"), root.join("shot.png")).unwrap();
        let s = settings(None, None, None);
        // The bare name's candidate at the root is the link: refused.
        assert_eq!(find_in_vault(&root, &note, &s, "shot.png"), None);
        std::fs::remove_dir_all(top).unwrap();
    }

    #[test]
    fn the_walk_ignores_case() {
        let (top, root, _) = vault("case");
        std::fs::create_dir_all(root.join("Old")).unwrap();
        std::fs::write(root.join("Old/Shot.PNG"), b"x").unwrap();
        assert_eq!(
            walk_for(&root, "shot.png", WALK_LIMIT),
            Some(root.join("Old/Shot.PNG"))
        );
        assert_eq!(count_named(&root, "SHOT.png", WALK_LIMIT), 1);
        std::fs::remove_dir_all(top).unwrap();
    }

    #[test]
    fn reads_at_most_the_cap() {
        let dir = temp_dir("cap");
        let path = dir.join("big.png");
        std::fs::write(&path, vec![0u8; MAX_BYTES + 1]).unwrap();
        assert!(read_image(&path).is_err());
        std::fs::write(&path, vec![0u8; 3]).unwrap();
        assert_eq!(read_image(&path).unwrap().unwrap().data, "AAAA");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_lookups_are_kept_a_minute() {
        let (top, root, _) = vault("lookup-cache");
        let seen = RefCell::new(Vec::new());
        let run = fake_cli(
            root.to_string_lossy().into_owned(),
            "Daily/2026-11-05.md",
            &seen,
        );
        let cache = LookupCache::default();
        let start = Instant::now();
        let first = cache
            .get_or("Work", start, || resolve_vault_note("Work", &run))
            .unwrap();
        assert_eq!(seen.borrow().len(), 2);
        // A second load within the minute asks the CLI nothing.
        let second = cache
            .get_or("Work", start + Duration::from_secs(30), || {
                resolve_vault_note("Work", &run)
            })
            .unwrap();
        assert_eq!(second, first);
        assert_eq!(seen.borrow().len(), 2);
        // Another vault, or a minute later, asks again.
        let _ = cache.get_or("Other", start, || resolve_vault_note("Other", &run));
        assert_eq!(seen.borrow().len(), 4);
        cache
            .get_or("Work", start + LOOKUP_TTL, || {
                resolve_vault_note("Work", &run)
            })
            .unwrap();
        assert_eq!(seen.borrow().len(), 6);
        // A failed lookup is not kept.
        let cache = LookupCache::default();
        assert!(cache.get_or("X", start, || Err("down".into())).is_err());
        cache
            .get_or("X", start, || resolve_vault_note("X", &run))
            .unwrap();
        assert_eq!(seen.borrow().len(), 8);
        std::fs::remove_dir_all(top).unwrap();
    }

    #[test]
    fn saves_where_the_settings_say() {
        let (top, root, note) = vault("save");
        let png = b"\x89PNG data";
        let at_root =
            save_in_vault(&root, &note, &settings(None, None, None), "1", "png", png).unwrap();
        assert_eq!(at_root.link, "![[Pasted image 1.png]]");
        assert_eq!(
            PathBuf::from(&at_root.path),
            root.join("Pasted image 1.png")
        );
        assert_eq!(std::fs::read(&at_root.path).unwrap(), png);

        let beside = settings(Some("./assets"), Some(true), Some("relative"));
        let saved = save_in_vault(&root, &note, &beside, "2", "jpeg", b"jpg").unwrap();
        assert_eq!(saved.link, "![](assets/Pasted%20image%202.jpg)");
        assert!(root.join("Daily/assets/Pasted image 2.jpg").is_file());

        let refused = settings(Some("../out"), None, None);
        assert!(save_in_vault(&root, &note, &refused, "3", "png", png).is_err());
        assert!(!top.join("out").exists());
        assert!(
            save_in_vault(&root, &note, &settings(None, None, None), "4", "svg", b"x").is_err()
        );
        std::fs::remove_dir_all(top).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_vault_is_refused() {
        let (top, root, note) = vault("symlink");
        let outside = top.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("Files")).unwrap();
        let s = settings(Some("Files"), None, None);
        assert!(save_in_vault(&root, &note, &s, "1", "png", b"x").is_err());
        let s = settings(Some("Files/deeper"), None, None);
        assert!(save_in_vault(&root, &note, &s, "1", "png", b"x").is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        // Loading does not follow it out either.
        std::fs::write(outside.join("secret.png"), b"x").unwrap();
        assert_eq!(
            find_in_vault(
                &root,
                &note,
                &settings(None, None, None),
                "Files/secret.png"
            ),
            None
        );
        std::fs::remove_dir_all(top).unwrap();
    }

    #[test]
    fn the_search_order_for_a_bare_name() {
        let (top, root, note) = vault("search");
        let s = settings(Some("Files"), None, None);
        let note_dir = PathBuf::from("Daily");
        assert_eq!(
            candidates(&root, &note_dir, &s, "a.png"),
            vec![
                root.join("Files/a.png"),
                root.join("Daily/a.png"),
                root.join("a.png")
            ]
        );
        let rel = settings(None, Some(true), Some("relative"));
        assert_eq!(
            candidates(&root, &note_dir, &rel, "assets/a.png"),
            vec![root.join("Daily/assets/a.png"), root.join("assets/a.png")]
        );
        assert_eq!(
            candidates(&root, &note_dir, &s, "assets/a.png"),
            vec![root.join("assets/a.png"), root.join("Daily/assets/a.png")]
        );

        std::fs::create_dir_all(root.join("Files")).unwrap();
        std::fs::write(root.join("a.png"), b"root").unwrap();
        std::fs::write(root.join("Files/a.png"), b"files").unwrap();
        let found = find_in_vault(&root, &note, &s, "a.png").unwrap();
        assert_eq!(std::fs::read(found).unwrap(), b"files");
        // Elsewhere in the vault: the bounded walk, hidden folders skipped.
        std::fs::create_dir_all(root.join("Projects/Old")).unwrap();
        std::fs::write(root.join("Projects/Old/deep.png"), b"deep").unwrap();
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::write(root.join(".obsidian/hidden.png"), b"h").unwrap();
        assert_eq!(
            find_in_vault(&root, &note, &s, "deep.png"),
            Some(root.join("Projects/Old/deep.png"))
        );
        assert_eq!(find_in_vault(&root, &note, &s, "hidden.png"), None);
        assert_eq!(walk_for(&root, "deep.png", 2), None);
        assert_eq!(find_in_vault(&root, &note, &s, "../x.png"), None);
        std::fs::write(top.join("x.png"), b"out").unwrap();
        assert_eq!(find_in_vault(&root, &note, &s, "../x.png"), None);
        std::fs::remove_dir_all(top).unwrap();
    }

    #[test]
    fn the_type_by_extension_and_the_size_cap() {
        assert_eq!(mime_for("a.PNG"), Some("image/png"));
        assert_eq!(mime_for("a.jpeg"), Some("image/jpeg"));
        assert_eq!(mime_for("a.jpg"), Some("image/jpeg"));
        assert_eq!(mime_for("a.gif"), Some("image/gif"));
        assert_eq!(mime_for("a.webp"), Some("image/webp"));
        assert_eq!(mime_for("a.bmp"), Some("image/bmp"));
        assert_eq!(mime_for("a.svg"), None);
        assert_eq!(mime_for("a"), None);
        assert_eq!(save_ext("JPEG"), Ok("jpg"));
        assert_eq!(save_ext(".png"), Ok("png"));
        assert!(save_ext("bmp").is_err());
        assert!(check_size(MAX_BYTES).is_ok());
        assert!(check_size(MAX_BYTES + 1).is_err());
        let big = "A".repeat((MAX_BYTES + 8) / 3 * 4);
        assert!(decode(&big).is_err());
        assert_eq!(decode("aGk="), Ok(b"hi".to_vec()));
        assert!(decode("not base64!").is_err());
    }

    #[test]
    fn reads_and_finds_in_the_apps_folder() {
        let dir = temp_dir("appdata").join("notes").join("attachments");
        let saved = save_in_folder(&dir, "7", "png", b"img").unwrap();
        assert_eq!(saved.link, "![[Pasted image 7.png]]");
        let found = find_in_folder(&dir, "Pasted image 7.png").unwrap();
        let loaded = read_image(&found).unwrap().unwrap();
        assert_eq!(loaded.mime, "image/png");
        assert_eq!(loaded.data, "aW1n");
        assert_eq!(find_in_folder(&dir, "missing.png"), None);
        // Only a bare name: a folder in the link finds nothing.
        assert_eq!(find_in_folder(&dir, "../../Pasted image 7.png"), None);
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        assert_eq!(read_image(&dir.join("a.txt")), Ok(None));
        std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).unwrap();
    }

    #[test]
    fn the_cli_lookups_give_the_vault_and_the_note() {
        let (top, root, _) = vault("lookups");
        let seen = RefCell::new(Vec::new());
        let run = fake_cli(
            root.to_string_lossy().into_owned(),
            "Daily/2026-11-05.md",
            &seen,
        );
        let (r, note) = resolve_vault_note("Work", &run).unwrap();
        assert_eq!(r, root);
        let saved = save_in_vault(
            &r,
            &note,
            &settings(Some("./"), None, None),
            "9",
            "gif",
            b"g",
        )
        .unwrap();
        assert_eq!(
            PathBuf::from(saved.path),
            root.join("Daily/Pasted image 9.gif")
        );
        assert_eq!(seen.borrow().len(), 2);
        std::fs::remove_dir_all(top).unwrap();
    }
}
