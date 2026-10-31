//! Window-check fixtures: projects a person opens in the running app to check what a story
//! built, since a window is the one thing `just check` can't be. Built here, through the same
//! commands the app sends, and saved as `tests/window/fixtures/<name>.oblique` with the picture
//! files each one needs beside it.
//!
//! `FIXTURES=<name>[,<name>…]` writes those fixtures instead of checking them, and
//! `FIXTURES=all` writes every one: `just fixtures depth-map`, or `just fixtures` for all. Without
//! it the test fails when a committed `.oblique` is stale, so a change to the document that the
//! fixture doesn't follow shows up in `just check`. The picture files are written with the
//! project and only checked to be there: their bytes belong to the encoder's version, not to
//! anything the app does.
//!
//! The pictures are synthetic (a near box, a mid sphere, far hills, sky and ground), so a depth
//! map reads and no personal photo is in the repo.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rhizome_core::IdSource;
use rhizome_pom::{Document, MemoryStore};
use serde_json::{json, Value as Json};

use super::{Catalogue, Oblique};

const SIZE: (u32, u32) = (640, 480);

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/window/fixtures")
}

/// Whether `FIXTURES` asks for `name` to be written.
fn wanted(name: &str) -> bool {
    std::env::var("FIXTURES")
        .is_ok_and(|v| v.split(',').any(|n| n.trim() == name || n.trim() == "all"))
}

/// Writes the fixture's text when `FIXTURES` names it; otherwise fails if the file isn't `text`.
fn check_or_write(name: &str, text: &str) {
    let path = fixtures_dir().join(format!("{name}.oblique"));
    if wanted(name) {
        std::fs::create_dir_all(fixtures_dir()).unwrap();
        std::fs::write(&path, text).unwrap();
        return;
    }
    let on_disk = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        on_disk == text,
        "tests/window/fixtures/{name}.oblique is stale: write it again with `just fixtures {name}`"
    );
}

// ---- the picture ----

/// What is at a pixel of the scene: its colour, how near it is (0 far, 1 near), and how much of
/// it is a solid object (the cut-out keeps those, with soft edges).
struct Sample {
    rgb: [f32; 3],
    depth: f32,
    object: f32,
}

fn smooth(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn scene(x: u32, y: u32) -> Sample {
    let (xf, yf) = (x as f32, y as f32);
    let horizon = SIZE.1 as f32 * 0.52;

    // sky, then ground, with a far ridge between
    let mut rgb;
    let mut depth;
    if yf < horizon {
        let t = yf / horizon;
        rgb = mix([0.40, 0.58, 0.86], [0.80, 0.86, 0.93], t);
        depth = 0.02 * t;
    } else {
        let t = (yf - horizon) / (SIZE.1 as f32 - horizon);
        rgb = mix([0.36, 0.52, 0.28], [0.56, 0.44, 0.28], t);
        depth = 0.25 + 0.5 * t;
        // faint mown stripes, so the ground has something to read against
        rgb = mix(
            rgb,
            [rgb[0] * 0.9, rgb[1] * 0.92, rgb[2] * 0.9],
            0.5 + 0.5 * (yf * 0.35).sin(),
        );
    }
    let ridge = horizon - 28.0 + 22.0 * (xf / 70.0).sin() + 11.0 * (xf / 29.0).sin();
    if yf >= ridge && yf < horizon + 14.0 {
        rgb = mix([0.26, 0.38, 0.36], [0.34, 0.46, 0.40], (yf - ridge) / 60.0);
        depth = 0.18;
    }

    let mut object: f32 = 0.0;

    // a mid sphere, lit from the upper left
    let (cx, cy, r) = (SIZE.0 as f32 * 0.70, SIZE.1 as f32 * 0.66, 92.0);
    let (dx, dy) = ((xf - cx) / r, (yf - cy) / r);
    let d2 = dx * dx + dy * dy;
    if d2 < 1.0 {
        let cover = smooth(1.0, 0.97, d2.sqrt());
        let nz = (1.0 - d2).sqrt();
        let light = (-0.45 * dx - 0.5 * dy + 0.75 * nz).clamp(0.0, 1.0);
        let sphere = mix([0.12, 0.10, 0.30], [0.80, 0.78, 0.95], light);
        rgb = mix(rgb, sphere, cover);
        depth = depth + (0.62 + 0.18 * nz - depth) * cover;
        object = object.max(cover);
    }

    // a near box, with a top edge and stripes down the front
    let (x0, x1, y0, y1) = (
        SIZE.0 as f32 * 0.10,
        SIZE.0 as f32 * 0.46,
        SIZE.1 as f32 * 0.40,
        SIZE.1 as f32 * 0.96,
    );
    if xf >= x0 && xf < x1 && yf >= y0 && yf < y1 {
        let cover = smooth(x0, x0 + 1.5, xf) * smooth(x1, x1 - 1.5, xf) * smooth(y0, y0 + 1.5, yf);
        let stripe = 0.5 + 0.5 * ((xf - x0) * 0.22).sin();
        let mut face = mix([0.78, 0.26, 0.22], [0.88, 0.40, 0.30], stripe);
        if yf < y0 + 14.0 {
            face = mix(face, [0.95, 0.85, 0.70], 0.6);
        }
        rgb = mix(rgb, face, cover);
        depth = depth + (0.93 - depth) * cover;
        object = object.max(cover);
    }

    Sample { rgb, depth, object }
}

fn byte(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn encode(
    path: &Path,
    colour: png::ColorType,
    depth: png::BitDepth,
    data: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(path.parent().unwrap())?;
    let mut encoder = png::Encoder::new(BufWriter::new(File::create(path)?), SIZE.0, SIZE.1);
    encoder.set_color(colour);
    encoder.set_depth(depth);
    encoder.write_header()?.write_image_data(data)?;
    Ok(())
}

/// The scene, flat, with no alpha.
fn photo() -> Vec<u8> {
    let mut data = Vec::with_capacity((SIZE.0 * SIZE.1 * 3) as usize);
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            data.extend(scene(x, y).rgb.map(byte));
        }
    }
    data
}

/// The sphere and the box alone, on nothing: transparent all round, with soft edges.
fn cutout() -> Vec<u8> {
    let mut data = Vec::with_capacity((SIZE.0 * SIZE.1 * 4) as usize);
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            let s = scene(x, y);
            if s.object > 0.0 {
                data.extend(s.rgb.map(byte));
                data.push(byte(s.object));
            } else {
                data.extend([0, 0, 0, 0]);
            }
        }
    }
    data
}

/// The scene's depth as a 16-bit grey and alpha PNG, big-endian, fully opaque: what Create Depth
/// Map's 16-bit writer makes, so the window shows whether WebKit decodes one.
fn depth16() -> Vec<u8> {
    let mut data = Vec::with_capacity((SIZE.0 * SIZE.1 * 4) as usize);
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            let grey = (scene(x, y).depth.clamp(0.0, 1.0) * 65535.0).round() as u16;
            data.extend(grey.to_be_bytes());
            data.extend(0xffff_u16.to_be_bytes());
        }
    }
    data
}

// ---- the project ----

const NOTES: &str = "\
Depth map window check. `just fixtures depth-map` writes this file again.

0. Copy depth-map.oblique, depth-map.assets and depth-map.oblique.depth to a scratch folder and open the copy. The checks write files beside it.
a. Settings > Models: remove Depth Anything V2 Small. Select Photo, then Layer > Create Depth Map. The download prompt shows. Not now adds nothing.
b. Run it again and choose Download. One grey layer sits directly above Photo, near is white, same size as the photo. One undo removes it.
c. Show Cut-out and select it, then Create Depth Map. The new map is cut out too: nothing outside the shapes.
d. Show Depth 16-bit. It renders as a smooth grey picture, no errors.
e. Save As into another folder, quit, remove the model, go offline and reopen the new file. The depth layers are all there. (Photo and Cut-out show as missing: their files stay beside the original.)
f. New Untitled document: import any image, run Create Depth Map, then Save. Quit and reopen: the layer is still there.";

fn layer(id: &str, label: &str, source: &str, visible: bool) -> Json {
    json!({
        "id": id,
        "type": "pixel",
        "label": label,
        "state": "active",
        "output": "image",
        "visible": visible,
        "blendMode": "normal",
        "opacity": 1.0,
        "modifiers": [],
        "sourcePath": source,
        "sourceSize": [SIZE.0 as f64, SIZE.1 as f64],
    })
}

fn depth_map_project() -> String {
    let mut d = Document::<Oblique>::new_in(
        Arc::new(Catalogue(vec![])),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap();
    d.run(
        "document.set_size",
        &json!({"size": [SIZE.0 as f64, SIZE.1 as f64]}),
    )
    .unwrap();
    d.run("document.set_note", &json!({"note": NOTES})).unwrap();
    // each new layer lands on top, so the bottom one is added first
    for node in [
        layer("photo", "Photo", "depth-map.assets/photo.png", true),
        layer("cutout", "Cut-out", "depth-map.assets/cutout.png", false),
        layer(
            "depth16",
            "Depth 16-bit",
            "depth-map.oblique.depth/depth16.png",
            false,
        ),
    ] {
        d.run("layer.add", &json!({ "node": node })).unwrap();
    }
    d.tree().serialise()
}

/// The pictures `depth-map.oblique` names, next to it: the photo and the cut-out in
/// `depth-map.assets/`, and the 16-bit depth layer where Create Depth Map keeps its maps.
fn write_depth_map_pictures() {
    let dir = fixtures_dir();
    let photo_path = dir.join("depth-map.assets/photo.png");
    let cutout_path = dir.join("depth-map.assets/cutout.png");
    let depth_path = dir.join("depth-map.oblique.depth/depth16.png");
    encode(
        &photo_path,
        png::ColorType::Rgb,
        png::BitDepth::Eight,
        &photo(),
    )
    .unwrap();
    encode(
        &cutout_path,
        png::ColorType::Rgba,
        png::BitDepth::Eight,
        &cutout(),
    )
    .unwrap();
    encode(
        &depth_path,
        png::ColorType::GrayscaleAlpha,
        png::BitDepth::Sixteen,
        &depth16(),
    )
    .unwrap();
}

#[test]
fn depth_map_fixture() {
    let text = depth_map_project();
    check_or_write("depth-map", &text);
    if wanted("depth-map") {
        write_depth_map_pictures();
    }
    for file in [
        "depth-map.assets/photo.png",
        "depth-map.assets/cutout.png",
        "depth-map.oblique.depth/depth16.png",
    ] {
        assert!(
            fixtures_dir().join(file).is_file(),
            "tests/window/fixtures/{file} is missing: write it with `just fixtures depth-map`"
        );
    }
}

#[test]
fn the_fixtures_are_built_the_same_every_time() {
    assert_eq!(depth_map_project(), depth_map_project());
}

#[test]
fn the_depth_picture_is_near_white_and_the_cut_out_is_cut_out() {
    // near box vs far sky, from the scene itself
    let near = scene((SIZE.0 as f32 * 0.25) as u32, (SIZE.1 as f32 * 0.7) as u32);
    let far = scene(10, 10);
    assert!(near.depth > 0.9 && far.depth < 0.1);
    assert_eq!(far.object, 0.0);
    // the cut-out's corner is transparent, and a point inside the box is solid
    let cut = cutout();
    assert_eq!(&cut[..4], &[0, 0, 0, 0]);
    let inside = ((SIZE.1 as f32 * 0.7) as u32 * SIZE.0 + (SIZE.0 as f32 * 0.25) as u32) * 4;
    assert_eq!(cut[inside as usize + 3], 255);
}
