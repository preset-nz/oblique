//! The models Oblique declares to app-kit (Epic 17 story 2c, `model-downloads.md`).
//!
//! app-kit's `models` feature owns the folder, the download, the SHA-256 check, cancel and remove
//! (`guidance/projects/app-kit/design/models.md`). This file is only Oblique's side of it: the
//! registry, the `install` call, and the one-off removal of the weights the old sidecar fetch left.

use std::fs;
use std::path::{Path, PathBuf};

use preset_app_kit::models::{FileSpec, ModelSpec};
use tauri::{AppHandle, Manager, Runtime};

/// The models Oblique asks app-kit for. Each URL is pinned to the host repo's revision, never `main`.
///
/// MobileSAM (Apache-2.0, ONNX export by Acly: the pair the Krita AI plugin uses for interactive
/// segmentation). The single-mask decoder, not the 4-mask one: v1 takes the decoder's own best
/// mask. URLs are pinned to the repo's revision, never `main` (models.md decision 9), so the id
/// always means the same bytes. SHA-256 values and sizes verified 2026-09-10, and again against
/// this revision on 2026-10-21.
pub const REGISTRY: &[ModelSpec] = &[
    ModelSpec {
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
    },
    // Depth Anything V2 Small (Apache-2.0; the Base and Large sizes are CC-BY-NC-4.0 and fail the
    // licence gate). The ONNX export by onnx-community, fp32: about 99 MB. `model_fp16.onnx`
    // (49 642 442 bytes, sha256 2df6223f...0f5fb04) is in the same repo, left unregistered until
    // the maps are compared by eye. Checked on Hugging Face 2026-10-31. The URL tail is
    // `onnx/model.onnx`; the file is installed as `model.onnx`.
    ModelSpec {
        id: "depth_anything_v2_small",
        label: "Depth Anything V2 Small",
        used_by: "Create depth map",
        licence: "Apache-2.0",
        host: "huggingface.co",
        files: &[FileSpec {
            name: "model.onnx",
            url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx",
            sha256: "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c",
            size: 99_060_839,
        }],
    },
];

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
        assert_eq!(ids, ["mobile_sam", "depth_anything_v2_small"]);
        for model in REGISTRY {
            for file in model.files {
                // A host revision (a 40-hex commit), never a moving branch.
                let rest = file
                    .url
                    .strip_prefix("https://huggingface.co/")
                    .expect("pinned to the Hugging Face repo");
                let (_repo, rest) = rest.split_once("/resolve/").expect("a /resolve/ URL");
                let (revision, tail) = rest.split_once('/').unwrap();
                assert_eq!(revision.len(), 40, "{}", file.url);
                assert!(
                    revision.bytes().all(|b| b.is_ascii_hexdigit()),
                    "{}",
                    file.url
                );
                // The file's name is the last path segment: `onnx/model.onnx` installs as `model.onnx`.
                assert_eq!(tail.rsplit('/').next().unwrap(), file.name);
                assert_eq!(file.sha256.len(), 64);
                assert!(file
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
                assert!(file.size > 0);
            }
        }
        assert_eq!(REGISTRY[0].total_size(), 44_658_416);
        assert_eq!(REGISTRY[1].total_size(), 99_060_839);
        assert_eq!(REGISTRY[1].licence, "Apache-2.0");
        assert_eq!(REGISTRY[1].used_by, "Create depth map");
        assert!(REGISTRY[1].files[0].url.contains(
            "/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/"
        ));
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
