//! Memory-maps cache files for the JS reader (design D1, D7).
//!
//! `mapFile` wraps a read-only mapping in an external ArrayBuffer, so JS reads
//! the mapped bytes with no copy. Mappings live in a registry keyed by a unique
//! id: `unmap` removes one eagerly, and the ArrayBuffer's finalizer removes it
//! when the buffer is garbage collected. Whichever runs first wins; the other
//! finds nothing and does nothing. Ids (not addresses) key the registry so a
//! late finalizer can never unmap a newer mapping that reused the address.

#[cfg(target_endian = "big")]
compile_error!("nickle's file format is little-endian; big-endian hosts are unsupported");

use std::fs::File;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use memmap2::{Mmap, MmapOptions};
use napi::bindgen_prelude::*;
use napi_derive::napi;

static MAPS: Mutex<Vec<(u64, Mmap)>> = Mutex::new(Vec::new());
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Maps `path` read-only. Returns `None` for an empty file, which cannot be mapped.
pub fn map_path(path: &Path) -> io::Result<Option<Mmap>> {
  let file = File::open(path)?;
  if file.metadata()?.len() == 0 {
    return Ok(None);
  }
  // SAFETY: the mapping is read-only. nickle replaces files by rename, so the
  // mapped inode is never modified in place by nickle's own writer.
  unsafe { MmapOptions::new().map(&file) }.map(Some)
}

fn register(map: Mmap) -> u64 {
  let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
  MAPS.lock().unwrap().push((id, map));
  id
}

/// Drops the mapping for `id`. Returns whether one was found.
fn release_id(id: u64) -> bool {
  let mut maps = MAPS.lock().unwrap();
  let found = maps.iter().position(|(i, _)| *i == id).map(|at| maps.swap_remove(at));
  drop(maps);
  found.is_some()
}

/// Drops the mapping starting at `ptr`. Returns whether one was found.
fn release_ptr(ptr: *const u8) -> bool {
  let mut maps = MAPS.lock().unwrap();
  let found = maps
    .iter()
    .position(|(_, m)| std::ptr::eq(m.as_ptr(), ptr))
    .map(|at| maps.swap_remove(at));
  drop(maps);
  found.is_some()
}

/// Number of live mappings (for tests).
#[napi(js_name = "mappingCount")]
pub fn mapping_count() -> u32 {
  MAPS.lock().unwrap().len() as u32
}

#[napi(js_name = "mapFile")]
pub fn map_file<'env>(env: &'env Env, path: String) -> Result<ArrayBuffer<'env>> {
  let map = map_path(Path::new(&path))
    .map_err(|e| Error::new(Status::GenericFailure, format!("{e}: {path}")))?;
  let Some(map) = map else {
    return ArrayBuffer::copy_from(env, []);
  };
  let ptr = map.as_ptr() as *mut u8;
  let len = map.len();
  let id = register(map);
  // SAFETY: the registry keeps the mapping alive until `unmap` or the
  // finalizer. `unmap` detaches the buffer before releasing it, so JS can
  // never read unmapped memory.
  unsafe {
    ArrayBuffer::from_external(env, ptr, len, id, |_, id| {
      release_id(id);
    })
  }
}

/// Detaches `buf`, then unmaps it. Idempotent; a no-op for empty or detached buffers.
#[napi]
pub fn unmap(buf: ArrayBuffer) -> Result<()> {
  if buf.is_detached()? || buf.is_empty() {
    return Ok(());
  }
  let ptr = buf.as_ptr();
  buf.detach()?;
  release_ptr(ptr);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("nickle-{}-{name}", std::process::id()));
    File::create(&path).unwrap().write_all(bytes).unwrap();
    path
  }

  #[test]
  fn maps_file_bytes() {
    let path = temp_file("bytes", b"NKL\0hello");
    let map = map_path(&path).unwrap().unwrap();
    assert_eq!(&map[..], b"NKL\0hello");
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn empty_file_is_none() {
    let path = temp_file("empty", b"");
    assert!(map_path(&path).unwrap().is_none());
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn missing_file_is_not_found() {
    let err = map_path(Path::new("/nonexistent/nickle")).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::NotFound);
  }

  #[cfg(unix)]
  #[test]
  fn mapping_survives_replacement() {
    let path = temp_file("replace", b"old!");
    let map = map_path(&path).unwrap().unwrap();
    let next = temp_file("replace-next", b"new!");
    std::fs::rename(&next, &path).unwrap();
    assert_eq!(&map[..], b"old!");
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn release_is_idempotent_and_keyed_by_id() {
    let path = temp_file("registry", b"abcd");
    let map = map_path(&path).unwrap().unwrap();
    let ptr = map.as_ptr();
    let id = register(map);
    assert!(release_ptr(ptr));
    assert!(!release_ptr(ptr));
    assert!(!release_id(id), "late finalizer finds nothing");
    std::fs::remove_file(path).unwrap();
  }
}
