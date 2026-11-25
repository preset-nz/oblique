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
//! - `levels-curve`: Levels' gamma as a curve over a histogram (Epic 27, levels-curve).
//! - `text-overflow`: text and vector layers keep what lies past the page (Epic 03,
//!   layer-overflow).
//! - `layers-left`: thirty layers, with the layer list on the left and the properties on the right
//!   (Epic 04, layers-left).
//! - `jpeg-corrupt`: an infection that only grows as Progress rises (Epic 28, jpeg-corrupt).

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

// ---- levels curve ----

const LEVELS_CURVE_NOTES: &str = "\
Levels curve window check (Epic 27, levels-curve, phase 1). `just fixtures levels-curve` writes this file again.

0. Open a fresh copy (`just window-check levels-curve`). Photo has two modifiers: Invert (switched off) and, above it in the stack, Levels with Black point 20, White point 230, Gamma 1.6, Output black 40, Output white 255. The Gamma field has a square curve under it, over a histogram, about as wide as the panel; Output black and Output white follow it. The curve starts at the left end at x = 20/255 and a height of 40/255 (lifted off the floor), runs up to the right end at x = 230/255 on the ceiling, and is flat outside them; the point sits halfway between the ends. The shadows of the picture are grey, not black.
a. The histogram is of the picture as it arrives at Levels: grey for brightness, with red, green and blue overlaid. The photo is mostly mid tones (sky, grass), so most of the histogram sits in the middle.
b. Drag the middle point up: the midtones lighten on the canvas as you drag, and the Gamma field climbs with it, live. Drag it down: the picture darkens and Gamma falls. The point only moves up and down; double-click on the curve adds no point. The other four fields don't change.
c. Drag the point as far up as it will go: Gamma stops at 5. As far down: it stops at 0.1.
d. Type 3 in the Gamma field and press Enter: the point jumps up to match. Scrub the Gamma label: the point follows the scrub. Put Gamma back to 1.6.
e. Type 100 in Black point and press Enter: the left end slides along to 100/255 and the point moves with it, staying halfway between the ends. Scrub the Black point label: the end follows live. Type 60 in White point: the right end slides in to 60/255 (the ends stay at least one level apart). Put them back to 20 and 230.
f. Drag the left end: it moves in both directions, Black point changing with its x and Output black with its height, both in whole numbers and live, and the point riding along halfway between with the same Gamma. Drag it straight down to the floor: Output black reaches 0 and the shadows go to black. Drag it up: the shadows lift to grey. It can't pass the right end in either direction (it stops one level short in x and in height). Drag the right end the same way: White point with its x, Output white with its height, and dragging it down dulls the highlights to grey. Gamma doesn't change while an end moves.
g. Type 120 in Output black and press Enter: the left end jumps up to that height and the shadows lift to a flat grey. Scrub the Output black label: the end follows live. Type 180 in Output white: the right end drops, the highlights dull. Type a number lower than Output black into Output white (try 10): the curve draws the ends one level apart and the picture never inverts, because the op holds Output white one above Output black. Put them back to 40 and 255.
h. The drawn line is the remap Levels does: flat at Output black up to Black point, the power curve between the ends, flat at Output white from White point on. At Gamma 1 the middle is a straight slope between the ends; at 0.1 it hugs the lower end and then jumps; at 5 it leaps up and then flattens, with no kinks.
i. One drag of the point or of an end (an end drag changes two fields), then undo (Cmd+Z): both fields go back to where they were before the drag, in one step. The Edit menu names the step after the field that changed first (Gamma, Black point or Output black and so on). Redo puts it back.
j. Start a drag of the point, or of an end, and press Escape without letting go: the curve and every number field go back to where they were, the picture too, and there is nothing to undo from that drag.
k. Tick Invert (the lower row) on: the picture goes negative and the histogram flips left to right, because a modifier below Levels changed what reaches it. Untick it: it flips back. The curve doesn't move.
l. Lock the layer: the curve greys and can't be dragged. Unlock it.
m. Collapse the Levels row and open it again: the curve and histogram are there at once. Save, close and reopen the file: all five numbers are as you left them.";

/// `list_ops`' `levels` and `invert` as the sidecar declares them (sidecar/ops/levels.py,
/// invert.py), so the fixture's modifiers are the ones the app makes.
fn levels_catalogue() -> Catalogue {
    let float = |name: &str, label: &str, default: f64, min: f64, max: f64| OpParam {
        name: name.into(),
        label: Some(label.into()),
        description: None,
        kind: "float".into(),
        default: json!(default),
        min: Some(min),
        max: Some(max),
        choices: vec![],
        choice_labels: Default::default(),
    };
    Catalogue(vec![
        Op {
            name: "levels".into(),
            label: Some("Levels".into()),
            description: None,
            category: Some("colour".into()),
            drivers: vec![],
            params: vec![
                float("black", "Black point", 0.0, 0.0, 255.0),
                float("white", "White point", 255.0, 0.0, 255.0),
                float("gamma", "Gamma", 1.0, 0.1, 5.0),
                float("out_black", "Output black", 0.0, 0.0, 255.0),
                float("out_white", "Output white", 255.0, 0.0, 255.0),
            ],
        },
        Op {
            name: "invert".into(),
            label: Some("Invert".into()),
            description: None,
            category: Some("colour".into()),
            drivers: vec![],
            params: vec![],
        },
    ])
}

fn levels_curve_project() -> String {
    let mut d = Document::<Oblique>::new_in(
        Arc::new(levels_catalogue()),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap();
    d.run(
        "document.set_size",
        &json!({"size": [SIZE.0 as f64, SIZE.1 as f64]}),
    )
    .unwrap();
    d.run("document.set_note", &json!({"note": LEVELS_CURVE_NOTES}))
        .unwrap();
    let mut photo = layer("photo", "Photo", "levels-curve.assets/photo.png", true);
    // application order: Invert (off) first, then Levels, which the stack shows on top
    photo["modifiers"] = json!([
        {"id": "invert", "type": "invert", "enabled": false, "params": {}},
        {"id": "levels", "type": "levels", "enabled": true,
         "params": {"black": 20.0, "white": 230.0, "gamma": 1.6,
                    "out_black": 40.0, "out_white": 255.0}}
    ]);
    d.run("layer.add", &json!({ "node": photo })).unwrap();
    d.tree().serialise()
}

fn write_levels_curve_pictures() {
    encode(
        &fixtures_dir().join("levels-curve.assets/photo.png"),
        png::ColorType::Rgb,
        png::BitDepth::Eight,
        &photo(),
    )
    .unwrap();
}

#[test]
fn levels_curve_fixture() {
    let text = levels_curve_project();
    check_or_write("levels-curve", &text);
    if wanted("levels-curve") {
        write_levels_curve_pictures();
    }
    assert!(
        fixtures_dir().join("levels-curve.assets/photo.png").is_file(),
        "tests/window/fixtures/levels-curve.assets/photo.png is missing: write it with `just fixtures levels-curve`"
    );
}

// ---- jpeg corrupt ----

const JPEG_CORRUPT_NOTES: &str = "\
JPEG Corrupt window check (Epic 28, jpeg-corrupt). `just fixtures jpeg-corrupt` writes this file again.

0. Open a fresh copy (`just window-check jpeg-corrupt`). One 640 x 480 picture, Photo, with a JPEG Corrupt modifier at its defaults (Progress 0.35, Colonies 3, Spores 0.15, Irregularity 0.6, Smear 4, Severity 3, Damage Shift bytes, Quality 40, Colour blocks Coarse, Block size 16, Variant 0, Seed 0). Patches of blocks are broken (smeared colour, slipped rows, garbage blocks) in a few clumps, with some single blocks away from them; the rest of the picture is untouched.
a. Scrub Progress from 0 up to 1 slowly. At 0 the picture is exactly as it was. Blocks are only ever added: nothing that was broken heals or changes as you go up, and the clumps grow outward from where they started, with single blocks appearing ahead of them. At 1 every block is broken. Scrub back down: the damage retreats the way it came, the same blocks each time.
b. Put Progress at 0.5 and scrub Variant: the damage inside the broken blocks changes every step (it boils), but the same blocks are broken and the clumps stay where they are.
c. Change Seed: the clumps and the single blocks land somewhere else.
d. Colonies up to 8: more clumps start. Back to 3: the first ones are where they were.
e. Spores to 0: no single blocks ahead of the clumps. To 1: the infection is scattered blocks with no clumps to speak of.
f. Irregularity to 0: each clump grows as a clean round patch. To 1: ragged edges.
g. Smear to 1: each break stays in its own block. To 32: breaks run on along the row in long smears.
h. Severity 1 to 16: the broken blocks get more broken.
i. Damage: Flip bits is gentle (mostly colour and detail errors), Replace bytes is rougher, Shift bytes slips the rest of the run.
j. Quality 5: the broken blocks are coarse and blocky; 95: they keep much more of the picture's detail.
k. Colour blocks Fine (4:4:4): smaller, sharper breaks than Coarse (4:2:0)'s chunky colour smears.
l. Block size 64: big blocks; 4: fine grit. While you scrub (the blurry draft) the same blocks are broken as in the sharp picture after you let go.
m. Undo after a scrub: one step takes the whole scrub back. Turn the modifier off and on again: the picture goes clean and the same damage comes back. Save, close and reopen the file: the same picture, the same damage.";

/// `list_ops`' `jpeg_corrupt` as the sidecar declares it (sidecar/ops/jpeg_corrupt.py), so the
/// fixture's modifier is the one the app makes.
fn jpeg_corrupt_catalogue() -> Catalogue {
    let number = |name: &str, label: &str, kind: &str, default: Json, min: f64, max: f64| OpParam {
        name: name.into(),
        label: Some(label.into()),
        description: None,
        kind: kind.into(),
        default,
        min: Some(min),
        max: Some(max),
        choices: vec![],
        choice_labels: Default::default(),
    };
    let choice = |name: &str, label: &str, default: &str, labels: &[(&str, &str)]| OpParam {
        name: name.into(),
        label: Some(label.into()),
        description: None,
        kind: "enum".into(),
        default: json!(default),
        min: None,
        max: None,
        choices: labels.iter().map(|(c, _)| c.to_string()).collect(),
        choice_labels: labels
            .iter()
            .map(|(c, l)| (c.to_string(), l.to_string()))
            .collect(),
    };
    Catalogue(vec![Op {
        name: "jpeg_corrupt".into(),
        label: Some("JPEG Corrupt".into()),
        description: None,
        category: Some("distort".into()),
        drivers: vec![],
        params: vec![
            number("progress", "Progress", "float", json!(0.35), 0.0, 1.0),
            number("colonies", "Colonies", "int", json!(3), 1.0, 12.0),
            number("spores", "Spores", "float", json!(0.15), 0.0, 1.0),
            number("irregularity", "Irregularity", "float", json!(0.6), 0.0, 1.0),
            number("smear", "Smear", "int", json!(4), 1.0, 64.0),
            number("severity", "Severity", "int", json!(3), 1.0, 16.0),
            choice(
                "mode",
                "Damage",
                "shift",
                &[
                    ("flip", "Flip bits"),
                    ("replace", "Replace bytes"),
                    ("shift", "Shift bytes"),
                ],
            ),
            number("quality", "Quality", "int", json!(40), 5.0, 95.0),
            choice(
                "chroma",
                "Colour blocks",
                "420",
                &[("420", "Coarse (4:2:0)"), ("444", "Fine (4:4:4)")],
            ),
            number("block", "Block size", "float", json!(16.0), 4.0, 128.0),
            number("variant", "Variant", "int", json!(0), 0.0, 9999.0),
            number("seed", "Seed", "int", json!(0), 0.0, 9999.0),
        ],
    }])
}

fn jpeg_corrupt_project() -> String {
    let mut d = Document::<Oblique>::new_in(
        Arc::new(jpeg_corrupt_catalogue()),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap();
    d.run(
        "document.set_size",
        &json!({"size": [SIZE.0 as f64, SIZE.1 as f64]}),
    )
    .unwrap();
    d.run("document.set_note", &json!({"note": JPEG_CORRUPT_NOTES}))
        .unwrap();
    let mut photo = layer("photo", "Photo", "jpeg-corrupt.assets/photo.png", true);
    photo["modifiers"] = json!([
        {"id": "corrupt", "type": "jpeg_corrupt", "enabled": true,
         "params": {"progress": 0.35, "colonies": 3, "spores": 0.15, "irregularity": 0.6,
                    "smear": 4, "severity": 3, "mode": "shift", "quality": 40,
                    "chroma": "420", "block": 16.0, "variant": 0, "seed": 0}}
    ]);
    d.run("layer.add", &json!({ "node": photo })).unwrap();
    d.tree().serialise()
}

fn write_jpeg_corrupt_pictures() {
    encode(
        &fixtures_dir().join("jpeg-corrupt.assets/photo.png"),
        png::ColorType::Rgb,
        png::BitDepth::Eight,
        &photo(),
    )
    .unwrap();
}

#[test]
fn jpeg_corrupt_fixture() {
    let text = jpeg_corrupt_project();
    check_or_write("jpeg-corrupt", &text);
    if wanted("jpeg-corrupt") {
        write_jpeg_corrupt_pictures();
    }
    assert!(
        fixtures_dir().join("jpeg-corrupt.assets/photo.png").is_file(),
        "tests/window/fixtures/jpeg-corrupt.assets/photo.png is missing: write it with `just fixtures jpeg-corrupt`"
    );
}

// ---- text overflow ----

const TEXT_OVERFLOW_NOTES: &str = "\
Layer overflow window check (Epic 03, layer-overflow). `just fixtures text-overflow` writes this file again.

0. Open a fresh copy (`just window-check text-overflow`). A 1280 x 960 page, dark grey, with four layers: Right, a yellow line of text running off the right edge; Left, a blue line starting past the left edge; Drop, a white triangle reaching past the bottom; Turned, a white square turned about 30 degrees, on the page.
a. Move tool: drag Right left until the whole line is on the page. Every letter is whole, with no cut where the page edge was: while dragging (blurry draft) and after letting go (sharp).
b. Drag Left right until it is on the page: its first letters are whole. Drag Drop up: its point is whole.
c. Undo back to the start, then click the part of Right that lies off the page: Right is selected.
d. Text tool: click into Right and type more letters at its end, so it runs further past the edge. Move tool: drag it back on. The new letters are whole too.
e. File > Export PNG with the layers moved on: the PNG shows every letter and the triangle's point whole.
f. Lock Right (its padlock), save, close and reopen the file: Right shows whole where you left it. Unlock it, drag it further right and back: still whole.
g. Drag Left fully onto the page, then Use as mask in its row: the layers below it show only through its letters, all of them whole. Use as image to put it back.
h. Give Turned an Invert modifier and choose Mask from vector or text layer, then Right: Turned inverts only where Right's letters cover it. Drag Right across Turned: the inverted letters are whole.
i. File > Document Settings…: switch Orientation to Portrait. Nothing moves on the page: each layer keeps its place, and Turned keeps its angle and its place (the parts outside the new page are simply off it). Switch back to Landscape: all as before. One undo takes the orientation back with everything in place. The same for a different aspect (1:1) and a different size. Then lock Turned and Right and switch again: the locked layers keep their place and angle too, and stay locked.
j. After the switch in i, drag each layer around the new page: nothing is cut that was there before.";

fn helvetica() -> Json {
    json!({"family": "Helvetica", "style": "Regular", "postscriptName": "Helvetica",
           "weight": 400.0, "italic": false, "category": "sans-serif"})
}

fn text_layer(id: &str, label: &str, content: &str, fill: &str, x: f64, y: f64) -> Json {
    json!({
        "id": id, "type": "text", "label": label, "state": "active", "output": "image",
        "visible": true, "blendMode": "normal", "opacity": 1.0, "modifiers": [],
        "content": content, "font": helvetica(), "fontSize": 140.0, "tracking": 0.0,
        "kerning": 100.0, "lineHeight": 1.2, "align": "left", "fill": fill, "stroke": null,
        "position": {"x": x, "y": y},
    })
}

fn vector_layer(id: &str, label: &str, points: &[(f64, f64)]) -> Json {
    let anchors: Vec<Json> = points
        .iter()
        .map(|(x, y)| json!({"point": {"x": x, "y": y}}))
        .collect();
    json!({
        "id": id, "type": "vector", "label": label, "state": "active", "output": "image",
        "visible": true, "blendMode": "normal", "opacity": 1.0, "modifiers": [],
        "paths": [{"anchors": anchors, "closed": true}], "fillRule": "nonzero",
    })
}

fn text_overflow_project() -> String {
    let mut d = Document::<Oblique>::new_in(
        Arc::new(Catalogue(vec![])),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap();
    d.run("document.set_size", &json!({"size": [1280.0, 960.0]}))
        .unwrap();
    d.run("document.set_note", &json!({"note": TEXT_OVERFLOW_NOTES}))
        .unwrap();
    d.run(
        "document.set_background",
        &json!({"background": {"type": "color", "color": "#262a33"}}),
    )
    .unwrap();
    let mut turned = vector_layer(
        "turned",
        "Turned",
        &[(820.0, 520.0), (1060.0, 520.0), (1060.0, 760.0), (820.0, 760.0)],
    );
    turned["transform2d"] =
        json!({"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.52});
    // each new layer lands on top, so the bottom one is added first
    for node in [
        turned,
        vector_layer(
            "drop",
            "Drop",
            &[(180.0, 700.0), (460.0, 700.0), (320.0, 1180.0)],
        ),
        text_layer("left", "Left", "Starts off the page", "#7fb7ff", -420.0, 640.0),
        text_layer("right", "Right", "Runs off the right edge", "#f4d35e", 520.0, 260.0),
    ] {
        d.run("layer.add", &json!({ "node": node })).unwrap();
    }
    d.tree().serialise()
}

#[test]
fn text_overflow_fixture() {
    check_or_write("text-overflow", &text_overflow_project());
}

// ---- layers on the left ----

const LAYERS_LEFT_NOTES: &str = "\
Layers-left window check (Epic 04, layers-left). `just fixtures layers-left` writes this file again.

0. Open a fresh copy (`just window-check layers-left`). A 1280 x 960 page with thirty layers: Layer 01 at the bottom to Layer 30 at the top (every third one is text, the rest are white boxes), and two saved selections. The layers are on the left, in a panel with Layers and Selections tabs; the 48 px tool rail is at the window's far left, outside it. Properties, Vectors, History and Notes are on the right. There is no title strip with the app name above them.
a. Click Layer 05 in the list: its modifier stack (Invert, then Levels above it) shows at the top of Properties, with no scrolling and no layer list above it. Click Layer 20, then Layer 03: the same, each with its own stack. Layer 12 has no modifiers: Properties shows its name and Add Modifier only.
b. The layer list scrolls on its own, inside the left panel; Properties doesn't move while it does.
c. Press Escape on the canvas to deselect (or click empty page): Properties reads Nothing selected.
d. Cmd+[ collapses the layer panel to a rail on the left of the canvas, with the tool rail still at the window edge; press it again and the panel comes back on the tab you left. View > Show Left Panel is ticked while it shows. Cmd+] does the same for the right panel and Show Right Panel. Click a collapsed panel's rail icon to reopen it.
e. Drag the layer panel's inner (right) edge: it stops at 200 px and 420 px. Drag the right panel's inner (left) edge: it stops at 280 px and 520 px. Double-click an edge: the panel goes back to its default width (240 and 320). Leave the left one wide and the right one narrow, collapse the right one, quit and relaunch the app: both come back at those widths, the right one still collapsed, and the document starts Untitled as usual (reopen your copy from File > Open Recent if you want it back).
f. Collapse the right panel, switch to the Move tool and double-click Layer 03 (a text layer) on the canvas: the right panel opens on Properties with the Text field focused. Do it again with the Vectors tab showing: it comes back to Properties.
g. Drag a layer by its grip in the list and drop it elsewhere: the order changes (the canvas follows). In Properties, drag a modifier row on Layer 05 by its grip: Invert and Levels swap.
h. Selections tab: two saved selections. Click a row: it becomes the active selection (outline and tint on the canvas); click it again to clear. Double-click a name to rename it, press Enter. Click the pencil (Edit Shape): the Move tool is chosen and the shape's anchors show.";

fn layers_left_project() -> String {
    let mut d = Document::<Oblique>::new_in(
        Arc::new(levels_catalogue()),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap();
    d.run("document.set_size", &json!({"size": [1280.0, 960.0]}))
        .unwrap();
    d.run("document.set_note", &json!({"note": LAYERS_LEFT_NOTES}))
        .unwrap();
    d.run(
        "document.set_background",
        &json!({"background": {"type": "color", "color": "#262a33"}}),
    )
    .unwrap();
    // each new layer lands on top, so the bottom one is added first: Layer 01 .. Layer 30
    for n in 1..=30_u32 {
        let id = format!("layer-{n:02}");
        let label = format!("Layer {n:02}");
        // a grid of six columns by five rows, so the layers read apart on the page
        let (col, row) = (f64::from((n - 1) % 6), f64::from((n - 1) / 6));
        let (x, y) = (60.0 + col * 200.0, 60.0 + row * 180.0);
        let mut node = if n % 3 == 0 {
            text_layer(&id, &label, &format!("Text {n:02}"), "#f4d35e", x, y)
        } else {
            vector_layer(
                &id,
                &label,
                &[(x, y), (x + 150.0, y), (x + 150.0, y + 120.0), (x, y + 120.0)],
            )
        };
        if let Some(size) = node.get_mut("fontSize") {
            *size = json!(48.0);
        }
        // application order: Invert first, then Levels, which the stack shows on top
        if n == 5 || n == 20 {
            node["modifiers"] = json!([
                {"id": format!("invert-{n:02}"), "type": "invert", "enabled": true, "params": {}},
                {"id": format!("levels-{n:02}"), "type": "levels", "enabled": true,
                 "params": {"black": 20.0, "white": 230.0, "gamma": 1.4,
                            "out_black": 0.0, "out_white": 255.0}}
            ]);
        }
        d.run("layer.add", &json!({ "node": node })).unwrap();
    }
    for (id, label, x) in [("sel-a", "Selection A", 100.0), ("sel-b", "Selection B", 600.0)] {
        let mut node = vector_layer(
            id,
            label,
            &[(x, 820.0), (x + 300.0, 820.0), (x + 300.0, 920.0), (x, 920.0)],
        );
        node["role"] = json!("selection");
        node["visible"] = json!(false);
        d.run("layer.add", &json!({ "node": node })).unwrap();
    }
    d.tree().serialise()
}

#[test]
fn layers_left_fixture() {
    check_or_write("layers-left", &layers_left_project());
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
    assert_eq!(levels_curve_project(), levels_curve_project());
    assert_eq!(jpeg_corrupt_project(), jpeg_corrupt_project());
    assert_eq!(text_overflow_project(), text_overflow_project());
    assert_eq!(layers_left_project(), layers_left_project());
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
