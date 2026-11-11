//! Endpoint keys. Every key is Ed25519, and the endpoint id is its public
//! key.
//!
//! - A key file holds the 32-byte seed as base64, with mode 0600. The CLI
//!   makes the device key in this format.
//! - hostd gives the host key on a file descriptor, as 32 raw bytes.
//!
//! On Windows a key file has the default ACL of its directory, and nothing
//! checks it. A Windows build must restrict the ACL to the user first.

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{fs, io::Write, path::Path};

use anyhow::{Context, Result, bail};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use iroh::SecretKey;

/// Loads the key file at `path`. Refuses a file that other users can read.
pub fn load(path: &Path) -> Result<SecretKey> {
    #[cfg(unix)]
    {
        let mode = fs::metadata(path)
            .with_context(|| format!("reading {}", path.display()))?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            bail!(
                "key file {} has mode {:o}; it must be 600",
                path.display(),
                mode & 0o777
            );
        }
    }
    let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    decode_seed(text.trim())
        .with_context(|| format!("key file {} is not a base64 seed", path.display()))
}

/// Loads the key file at `path`, or makes a new one there if it is missing.
pub fn load_or_create(path: &Path) -> Result<SecretKey> {
    if path.exists() {
        return load(path);
    }
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir)?;
    }
    let key = SecretKey::generate();
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .with_context(|| format!("creating {}", path.display()))?;
    writeln!(file, "{}", STANDARD.encode(key.to_bytes()))?;
    Ok(key)
}

/// Reads the key from file descriptor `fd`: exactly 32 raw bytes. Then
/// closes the descriptor.
#[cfg(unix)]
pub fn read_fd(fd: i32) -> Result<SecretKey> {
    use std::{io::Read, os::fd::FromRawFd};

    if fd <= 2 {
        bail!("--key-fd must not be stdin, stdout or stderr");
    }
    // SAFETY: F_GETFD only reads the descriptor's flags.
    if unsafe { libc::fcntl(fd, libc::F_GETFD) } == -1 {
        bail!("file descriptor {fd} is not open");
    }
    // SAFETY: the descriptor is open, and this process takes it over: no
    // other code uses it. Dropping the file closes it.
    let mut file = unsafe { fs::File::from_raw_fd(fd) };
    let mut seed = [0u8; 32];
    file.read_exact(&mut seed)
        .with_context(|| format!("reading 32 key bytes from file descriptor {fd}"))?;
    let key = SecretKey::from_bytes(&seed);
    seed.fill(0);
    Ok(key)
}

fn decode_seed(text: &str) -> Result<SecretKey> {
    let mut bytes = STANDARD
        .decode(text)
        .or_else(|_| STANDARD_NO_PAD.decode(text))
        .context("not base64")?;
    let Ok(seed) = <[u8; 32]>::try_from(bytes.as_slice()) else {
        bail!("expected 32 bytes, got {}", bytes.len());
    };
    bytes.fill(0);
    Ok(SecretKey::from_bytes(&seed))
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::fd::IntoRawFd;

    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("amika-net-keys-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_new_key_file_is_mode_600_and_reloads() {
        let dir = temp_dir("new");
        let path = dir.join("key");
        let created = load_or_create(&path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(load(&path).unwrap().public(), created.public());

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(&path).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_key_file_is_the_base64_seed() {
        let dir = temp_dir("b64");
        let path = dir.join("key");
        let seed = [7u8; 32];
        for text in [STANDARD.encode(seed), STANDARD_NO_PAD.encode(seed)] {
            let _ = fs::remove_file(&path);
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true).mode(0o600);
            writeln!(options.open(&path).unwrap(), "{text}").unwrap();
            assert_eq!(
                load(&path).unwrap().public(),
                SecretKey::from_bytes(&seed).public()
            );
        }
        fs::write(&path, STANDARD.encode([7u8; 31])).unwrap();
        assert!(load(&path).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_key_fd_gives_32_raw_bytes() {
        let (r, mut w) = std::io::pipe().unwrap();
        let seed = [9u8; 32];
        w.write_all(&seed).unwrap();
        let key = read_fd(r.into_raw_fd()).unwrap();
        assert_eq!(key.public(), SecretKey::from_bytes(&seed).public());
        // The read end is closed, so the write end sees a broken pipe.
        assert!(w.write_all(&[0u8; 1]).is_err());
    }

    #[test]
    fn a_short_key_fd_is_refused() {
        let (r, mut w) = std::io::pipe().unwrap();
        w.write_all(&[1u8; 31]).unwrap();
        drop(w);
        assert!(read_fd(r.into_raw_fd()).is_err());
        assert!(read_fd(1).is_err());
    }
}
