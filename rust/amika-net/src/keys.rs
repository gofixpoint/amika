//! The endpoint key file: 32 secret-key bytes as hex, in a mode-600 file.

use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};

use anyhow::{Context, Result, bail};
use iroh::SecretKey;

/// Loads the key at `path`, or makes a new one there if the file is missing.
/// Refuses a key file that other users can read.
pub fn load_or_create(path: &Path) -> Result<SecretKey> {
    if path.exists() {
        return load(path);
    }
    create(path)
}

fn load(path: &Path) -> Result<SecretKey> {
    let mode = fs::metadata(path)?.permissions().mode();
    if mode & 0o077 != 0 {
        bail!(
            "key file {} has mode {:o}; it must be 600",
            path.display(),
            mode & 0o777
        );
    }
    let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let bytes = decode_hex(text.trim()).context("key file is not 64 hex characters")?;
    Ok(SecretKey::from_bytes(&bytes))
}

fn create(path: &Path) -> Result<SecretKey> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir)?;
    }
    let key = SecretKey::generate();
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("creating {}", path.display()))?;
    writeln!(file, "{}", encode_hex(&key.to_bytes()))?;
    Ok(key)
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex(s: &str) -> Result<[u8; 32]> {
    if s.len() != 64 {
        bail!("expected 64 characters, got {}", s.len());
    }
    let mut out = [0u8; 32];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk)?, 16)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_file_is_created_mode_600_and_reloads() {
        let dir = std::env::temp_dir().join(format!("amika-net-test-{}", std::process::id()));
        let path = dir.join("key");
        let _ = fs::remove_dir_all(&dir);
        let created = load_or_create(&path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(load_or_create(&path).unwrap().public(), created.public());

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_or_create(&path).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
