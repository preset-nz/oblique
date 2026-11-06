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
//!
//! - `depth-map`: Create Depth Map (Epic 17 story 5).
//! - `layer-as-driver`: a depth layer drives a blur on the photo (Epic 17 story 6).
//! - `blur-radius`: the same scene twice, masked and driven (Epic 27 story 1).

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rhizome_core::IdSource;
use rhizome_pom::{Document, MemoryStore};
use serde_json::{json, Value as Json};

use super::{Catalogue, Oblique, Op, OpDriver, OpParam};

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

/// The scene's depth as an 8-bit grey PNG, near white: what a driver is read at.
fn depth8() -> Vec<u8> {
    let mut data = Vec::with_capacity((SIZE.0 * SIZE.1) as usize);
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            data.push(byte(scene(x, y).depth));
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

// ---- layer as driver ----

const DRIVER_NOTES: &str = "\
Layer as driver window check (Epic 17 story 6). `just fixtures layer-as-driver` writes this file again.

0. Open a fresh copy (`just window-check layer-as-driver`). Photo has a Gaussian Blur (radius 12) whose mask is driven by Depth, a hidden depth map, near white. The mask reads Depth's luminance, inverted, so far is blurred.
a. The sky, the hills and the far ground are blurred; the red box at the front is sharp and the sphere nearly so. The ground softens gradually as it recedes.
b. Open the blur's options (the three dots). It reads Driven by “Depth”, Luminance, Low 0, High 1, Invert on. Scrub Low up: more of the far scene blurs fully. Scrub High down: more of the near scene goes fully sharp. Untick Invert: the box blurs and the sky goes sharp. One undo takes back each scrub whole. Put them back (Low 0, High 1, Invert on).
c. Select Depth and add an Invert modifier to it, with Depth still hidden. Photo's blur flips (the box blurs, the sky sharpens) with no change to Photo's own stack. Remove the Invert modifier: it flips back.
d. Show Depth, move it right by a good distance, hide it again. The sharp box region on Photo moves right with it. Undo the move: it comes back.
e. Hide and show Depth a few times: the blur and its mask stay as they are.
f. Delete Depth: the blur now covers the whole photo, and the blur's options no longer show a layer mask. One undo brings back Depth and the mask together.
g. On Photo's blur, choose Mask from layer: Photo is listed but greyed, with the reason (a layer can't drive its own modifiers); Depth is listed and works. Add a Gaussian Blur to Depth and choose Mask from layer on that: Photo is greyed there, with the reason (it already takes a mask from Depth). Remove Depth's blur.
h. Save, close and reopen the file: the blur, the mask and its numbers are as they were.";

/// `list_ops`' `gaussian_blur` as the sidecar declares it (sidecar/ops/gaussian_blur.py), so
/// the fixture's modifier is the one the app makes.
fn blur_catalogue() -> Catalogue {
    Catalogue(vec![Op {
        name: "gaussian_blur".into(),
        label: Some("Gaussian Blur".into()),
        description: None,
        category: Some("distort".into()),
        drivers: vec![],
        params: vec![OpParam {
            name: "radius".into(),
            label: Some("Radius".into()),
            description: None,
            kind: "float".into(),
            default: json!(4.0),
            min: Some(0.0),
            max: Some(100.0),
            choices: vec![],
            choice_labels: Default::default(),
        }],
    }])
}

fn layer_as_driver_project() -> String {
    let mut d = Document::<Oblique>::new_in(
        Arc::new(blur_catalogue()),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap();
    d.run(
        "document.set_size",
        &json!({"size": [SIZE.0 as f64, SIZE.1 as f64]}),
    )
    .unwrap();
    d.run("document.set_note", &json!({"note": DRIVER_NOTES}))
        .unwrap();
    let mut photo = layer("photo", "Photo", "layer-as-driver.assets/photo.png", true);
    photo["modifiers"] = json!([{
        "id": "blur", "type": "gaussian_blur", "enabled": true, "params": {"radius": 12.0}
    }]);
    let depth = layer("depth", "Depth", "layer-as-driver.assets/depth.png", false);
    for node in [photo, depth] {
        d.run("layer.add", &json!({ "node": node })).unwrap();
    }
    d.run(
        "mask.attach_layer",
        &json!({"at": "/layers/photo/blur", "source": "/layers/depth",
                "channel": "luminance", "low": 0.0, "high": 1.0, "invert": true}),
    )
    .unwrap();
    d.tree().serialise()
}

fn write_layer_as_driver_pictures() {
    let dir = fixtures_dir();
    encode(
        &dir.join("layer-as-driver.assets/photo.png"),
        png::ColorType::Rgb,
        png::BitDepth::Eight,
        &photo(),
    )
    .unwrap();
    encode(
        &dir.join("layer-as-driver.assets/depth.png"),
        png::ColorType::Grayscale,
        png::BitDepth::Eight,
        &depth8(),
    )
    .unwrap();
}

#[test]
fn layer_as_driver_fixture() {
    let text = layer_as_driver_project();
    check_or_write("layer-as-driver", &text);
    if wanted("layer-as-driver") {
        write_layer_as_driver_pictures();
    }
    for file in [
        "layer-as-driver.assets/photo.png",
        "layer-as-driver.assets/depth.png",
    ] {
        assert!(
            fixtures_dir().join(file).is_file(),
            "tests/window/fixtures/{file} is missing: write it with `just fixtures layer-as-driver`"
        );
    }
}

// ---- blur radius ----

const BLUR_RADIUS_NOTES: &str = "\
Blur radius window check (Epic 27 story 1). `just fixtures blur-radius` writes this file again.

0. Open a fresh copy (`just window-check blur-radius`). The scene is there twice, 640 px each. On the left, Photo (masked) has a Gaussian Blur (radius 24) with its mask from Depth (masked): the old way, one blurred copy faded in. On the right, Photo (driven) has the same blur, but its radius follows Depth (driven) (Blur follows a layer). Both depth layers are hidden, near white, and both have Invert on.
a. Compare the hills behind the sphere. On the left the middle distance is half sharp and half blurred, a ghost. On the right the radius grows smoothly with distance: the hills are less blurred than the sky, with no sharp-plus-ghost double.
b. Look at the red box at the front on each side. On the right its edge is crisp against the blurred ground behind it, with no halo of background spreading over it.
c. Open the options (the three dots) of the right blur. Its Blur follows a layer section reads Following “Depth (driven)”, Luminance, Low 0, High 1, Invert on. Scrub Low up: more of the far scene gets the full radius, live. Scrub High down: more of the near scene goes fully sharp. Untick Invert: the box blurs and the sky goes sharp. One undo takes back each scrub whole. Put them back (Low 0, High 1, Invert on).
d. Select Depth (driven) and add an Invert modifier to it, with it still hidden. The right picture flips (box blurred, sky sharp) with no change to Photo (driven)'s own stack. Remove the Invert modifier: it flips back.
e. Show Depth (driven), move it right a good distance, hide it again. The sharp region on the right moves with it. Undo the move: it comes back.
f. Change the right blur's Radius: the radius scales the whole result, and a mask on it (Mask from layer, from any layer) blends the driven result.
g. In the options, Blur follows a layer lists Photo (driven) greyed, with the reason (a layer can't drive its own modifiers). Add a Gaussian Blur to Depth (driven) and choose Blur follows a layer on it: Photo (driven) is greyed there, with the reason (it already takes its look from Depth (driven)). Remove Depth (driven)'s blur.
h. Choose Stop following in the right blur's options: the whole right picture takes the full radius. One undo brings the driver back.
i. Delete Depth (driven): the right picture takes the full radius and the blur's options no longer show a followed layer. One undo brings back Depth (driven) and the driver together.
j. Save, close and reopen the file: both pictures, the driver and its numbers are as they were.";

/// `list_ops`' `gaussian_blur` as the sidecar declares it now, drivers and all
/// (sidecar/ops/gaussian_blur.py). `blur_catalogue` stays as it was, so `layer-as-driver.oblique`
/// does not change.
fn driven_blur_catalogue() -> Catalogue {
    let mut op = blur_catalogue().0.remove(0);
    op.drivers = vec![OpDriver {
        kind: "radius".into(),
        label: Some("Blur follows a layer".into()),
        description: None,
    }];
    Catalogue(vec![op])
}

/// A layer `x` px to the right of the origin.
fn layer_at(id: &str, label: &str, source: &str, visible: bool, x: f64) -> Json {
    let mut l = layer(id, label, source, visible);
    l["transform2d"] = json!({"x": x, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0});
    l
}

fn blur_radius_project() -> String {
    let mut d = Document::<Oblique>::new_in(
        Arc::new(driven_blur_catalogue()),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap();
    d.run(
        "document.set_size",
        &json!({"size": [(SIZE.0 * 2) as f64, SIZE.1 as f64]}),
    )
    .unwrap();
    d.run("document.set_note", &json!({"note": BLUR_RADIUS_NOTES}))
        .unwrap();
    let photo_path = "blur-radius.assets/photo.png";
    let depth_path = "blur-radius.assets/depth.png";
    let blur = |id: &str| {
        json!([{"id": id, "type": "gaussian_blur", "enabled": true, "params": {"radius": 24.0}}])
    };
    let mut masked = layer_at("photo-masked", "Photo (masked)", photo_path, true, 0.0);
    masked["modifiers"] = blur("blur-masked");
    let mut driven = layer_at(
        "photo-driven",
        "Photo (driven)",
        photo_path,
        true,
        SIZE.0 as f64,
    );
    driven["modifiers"] = blur("blur-driven");
    // each new layer lands on top, so the bottom one is added first
    for node in [
        masked,
        layer_at("depth-masked", "Depth (masked)", depth_path, false, 0.0),
        driven,
        layer_at(
            "depth-driven",
            "Depth (driven)",
            depth_path,
            false,
            SIZE.0 as f64,
        ),
    ] {
        d.run("layer.add", &json!({ "node": node })).unwrap();
    }
    d.run(
        "mask.attach_layer",
        &json!({"at": "/layers/photo-masked/blur-masked", "source": "/layers/depth-masked",
                "channel": "luminance", "low": 0.0, "high": 1.0, "invert": true}),
    )
    .unwrap();
    d.run(
        "driver.attach",
        &json!({"at": "/layers/photo-driven/blur-driven", "kind": "radius",
                "source": "/layers/depth-driven",
                "channel": "luminance", "low": 0.0, "high": 1.0, "invert": true}),
    )
    .unwrap();
    d.tree().serialise()
}

fn write_blur_radius_pictures() {
    let dir = fixtures_dir();
    encode(
        &dir.join("blur-radius.assets/photo.png"),
        png::ColorType::Rgb,
        png::BitDepth::Eight,
        &photo(),
    )
    .unwrap();
    encode(
        &dir.join("blur-radius.assets/depth.png"),
        png::ColorType::Grayscale,
        png::BitDepth::Eight,
        &depth8(),
    )
    .unwrap();
}

#[test]
fn blur_radius_fixture() {
    let text = blur_radius_project();
    check_or_write("blur-radius", &text);
    if wanted("blur-radius") {
        write_blur_radius_pictures();
    }
    for file in ["blur-radius.assets/photo.png", "blur-radius.assets/depth.png"] {
        assert!(
            fixtures_dir().join(file).is_file(),
            "tests/window/fixtures/{file} is missing: write it with `just fixtures blur-radius`"
        );
    }
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
    assert_eq!(layer_as_driver_project(), layer_as_driver_project());
    assert_eq!(blur_radius_project(), blur_radius_project());
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
