//! The models Oblique declares to app-kit (Epic 17 story 2c, `model-downloads.md`).
//!
//! app-kit's `models` feature owns the folder, the download, the SHA-256 check, cancel and remove
//! (`guidance/projects/app-kit/design/models.md`). This file is only Oblique's side of it: the
//! registry, the `install` call, and the one-off removal of the weights the old sidecar fetch left.

use std::fs;
use std::path::{Path, PathBuf};

use preset_app_kit::models::{FileSpec, ModelSpec};
use tauri::{AppHandle, Manager, Runtime};

/// MobileSAM (Apache-2.0, ONNX export by Acly: the pair the Krita AI plugin uses for interactive
/// segmentation). The single-mask decoder, not the 4-mask one: v1 takes the decoder's own best
/// mask. URLs are pinned to the repo's revision, never `main` (models.md decision 9), so the id
/// always means the same bytes. SHA-256 values and sizes verified 2026-09-10, and again against
/// this revision on 2026-10-21.
pub const REGISTRY: &[ModelSpec] = &[ModelSpec {
    id: "mobile_sam",
    label: "MobileSAM",
    used_by: "Smart Select",
    licence: "Apache-2.0",
    host: "huggingface.co",
    files: &[
        FileSpec {
            name: "mobile_sam_image_encoder.onnx",
            url: "https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8/mobile_sam_image_encoder.onnx",
            sha256: "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749",
            size: 28_157_093,
        },
        FileSpec {
            name: "sam_mask_decoder_single.onnx",
            url: "https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8/sam_mask_decoder_single.onnx",
            sha256: "93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d",
            size: 16_501_323,
        },
    ],
}];

/// Declare the registry to app-kit: writes this app's `.users` file, sweeps stale `.part` files,
/// manages the store and starts the `app-kit://models` event. Call it from the synchronous
/// `setup` (the downloader is reqwest's blocking client, which panics on a tokio worker thread).
///
/// The bundle id and the name come from the Tauri config, so they stay in `tauri.conf.json`.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let config = app.config();
    let name = config
        .product_name
        .clone()
        .unwrap_or_else(|| app.package_info().name.clone());
    preset_app_kit::models::install(app, &config.identifier, &name, REGISTRY)?;
    remove_legacy_weights(&app.path().app_data_dir()?);
    Ok(())
}

/// The old fetch (story 2) left `<app_data>/models/mobile_sam/` behind, where nothing could list
/// or remove it. Delete it; app-kit downloads a fresh copy into its own folder on first use
/// (adopting it would mean writing app-kit's manifest from here). Remove this in a later release.
/// Best effort: a failure is logged and never stops the launch.
fn remove_legacy_weights(app_data: &Path) {
    let dir = legacy_weights_dir(app_data);
    // `symlink_metadata`: never follow a link out of the app-data folder.
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => {
            if let Err(err) = fs::remove_dir_all(&dir) {
                eprintln!(
                    "models: could not remove old weights at {}: {err}",
                    dir.display()
                );
            }
        }
        _ => {}
    }
}

fn legacy_weights_dir(app_data: &Path) -> PathBuf {
    app_data.join("models").join("mobile_sam")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("oblique-models-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn registry_pins_every_file() {
        let ids: Vec<_> = REGISTRY.iter().map(|m| m.id).collect();
        assert_eq!(ids, ["mobile_sam"]);
        for model in REGISTRY {
            for file in model.files {
                // A host revision (a 40-hex commit), never a moving branch.
                let rest = file
                    .url
                    .strip_prefix("https://huggingface.co/Acly/MobileSAM/resolve/")
                    .expect("pinned to the Hugging Face repo");
                let (revision, tail) = rest.split_once('/').unwrap();
                assert_eq!(revision.len(), 40, "{}", file.url);
                assert!(
                    revision.bytes().all(|b| b.is_ascii_hexdigit()),
                    "{}",
                    file.url
                );
                assert_eq!(tail, file.name);
                assert_eq!(file.sha256.len(), 64);
                assert!(file
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
                assert!(file.size > 0);
            }
        }
        assert_eq!(REGISTRY[0].total_size(), 44_658_416);
    }

    #[test]
    fn legacy_weights_are_removed_and_the_rest_left() {
        let app_data = scratch("legacy");
        let old = legacy_weights_dir(&app_data);
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("mobile_sam_image_encoder.onnx"), b"old").unwrap();
        fs::write(old.join("sam_mask_decoder_single.onnx.part"), b"old").unwrap();
        let other = app_data.join("models").join("other_model");
        fs::create_dir_all(&other).unwrap();
        fs::write(app_data.join("ai-settings.json"), b"{}").unwrap();

        remove_legacy_weights(&app_data);

        assert!(!old.exists());
        assert!(other.exists());
        assert!(app_data.join("ai-settings.json").exists());
        // Nothing there on the next launch: a no-op, not a panic.
        remove_legacy_weights(&app_data);
        let _ = fs::remove_dir_all(&app_data);
    }
}
