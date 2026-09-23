//! OS keychain access for PATs and API keys (design.md section 9).
//!
//! Secret values are never logged. Errors carry the keyring error text only,
//! which does not include the secret.

use keyring::{Entry, Error};

const SERVICE: &str = "dev.rickliu.secretary";

fn entry(name: &str) -> Result<Entry, String> {
    if name.is_empty() || name.len() > 200 {
        return Err("invalid secret name".into());
    }
    Entry::new(SERVICE, name).map_err(|e| format!("keychain unavailable: {e}"))
}

/// Returns the secret, or `None` when no entry exists.
#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    entry(&name)?
        .set_password(&value)
        .map_err(|e| format!("keychain write failed: {e}"))
}

/// Deleting a missing entry is not an error.
#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}
