//! Golden renders: rasterised coverage checks for the text engine (Epic 20, golden-renders).
//!
//! `rasterise` is a deliberately tiny test helper that mirrors `vectorRasterize.ts`
//! (`pathCommandsFor` + a nonzero fill). It is not a product feature, but it is the seed of the
//! headless rasteriser (design/headless-processing.md, option c). The assertions are coverage
//! facts, not image diffs, so a macOS font update can't break them. Each one skips with a note
//! when its font is missing. Set `OBLIQUE_WRITE_GOLDENS=1` to write PNGs to `target/goldens/`.

use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Transform};

use super::outline::{Anchor, Contour, Point};
use super::*;

const HELVETICA: &str = "Helvetica";
const CONDENSED: &str = "HelveticaNeue-CondensedBold";

fn font_db(postscript_name: &str) -> Option<&'static fontdb::Database> {
    let db = crate::fonts::database();
    if db.faces().any(|f| f.post_script_name == postscript_name) {
        Some(db)
    } else {
        eprintln!("skipping: {postscript_name} is not installed");
        None
    }
}

fn spec(font: &str, content: &str, size: f32, tracking: f32, kerning: f32) -> TextSpec {
    TextSpec {
        content: content.to_string(),
        postscript_name: font.to_string(),
        font_size: size,
        tracking,
        kerning,
        line_height: 1.2,
        align: Align::Left,
    }
}

/// Fills every contour as one nonzero, anti-aliased, opaque-white path, shifted by `origin`.
/// Segment rules mirror TS `pathCommandsFor`: `line_to` when neither side has a handle, else a
/// `cubic_to` falling back to the anchor for a missing handle, then `close` if the contour is closed.
fn rasterise(geometry: &TextGeometry, w: u32, h: u32, origin: (f32, f32)) -> Pixmap {
    let at = |p: Point| (p.x + origin.0, p.y + origin.1);
    let seg = |pb: &mut PathBuilder, from: &Anchor, to: &Anchor| {
        if from.handle_out.is_none() && to.handle_in.is_none() {
            let (x, y) = at(to.point);
            pb.line_to(x, y);
        } else {
            let (x1, y1) = at(from.handle_out.unwrap_or(from.point));
            let (x2, y2) = at(to.handle_in.unwrap_or(to.point));
            let (x, y) = at(to.point);
            pb.cubic_to(x1, y1, x2, y2, x, y);
        }
    };
    let mut pb = PathBuilder::new();
    for c in geometry.paths.iter().filter(|c| !c.anchors.is_empty()) {
        let (x, y) = at(c.anchors[0].point);
        pb.move_to(x, y);
        for pair in c.anchors.windows(2) {
            seg(&mut pb, &pair[0], &pair[1]);
        }
        if c.closed && c.anchors.len() > 1 {
            seg(&mut pb, c.anchors.last().unwrap(), &c.anchors[0]);
        }
        if c.closed {
            pb.close();
        }
    }
    let mut pixmap = Pixmap::new(w, h).expect("pixmap");
    if let Some(path) = pb.finish() {
        let mut paint = Paint::default();
        paint.set_color_rgba8(255, 255, 255, 255);
        paint.anti_alias = true;
        pixmap.fill_path(
            &path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
    pixmap
}

fn alpha_at(pixmap: &Pixmap, x: u32, y: u32) -> u8 {
    pixmap.pixel(x, y).map_or(0, |p| p.alpha())
}

/// Horizontal ink extent: the first and last columns holding a pixel at least half covered.
fn ink_columns(pixmap: &Pixmap) -> (u32, u32) {
    let covered = |x| (0..pixmap.height()).any(|y| alpha_at(pixmap, x, y) >= 128);
    let min_x = (0..pixmap.width()).find(|&x| covered(x)).expect("ink");
    let max_x = (0..pixmap.width())
        .rev()
        .find(|&x| covered(x))
        .expect("ink");
    (min_x, max_x)
}

fn ink_width(pixmap: &Pixmap) -> u32 {
    let (a, b) = ink_columns(pixmap);
    b - a
}

/// Counts pixels fully covered (alpha 255) in `region` (a w*h alpha mask) that are not fully
/// covered in `pixmap`: the holes in the combined fill that no single glyph has.
fn holes_inside(pixmap: &Pixmap, region: &[u8]) -> usize {
    let w = pixmap.width();
    region
        .iter()
        .enumerate()
        .filter(|&(i, &a)| a == 255 && alpha_at(pixmap, i as u32 % w, i as u32 / w) < 255)
        .count()
}

/// Mirrors `documentPathsFor` in `src/scene/textGeometryCache.ts`: anchor-space paths translated
/// by the node's position. Handles are absolute coordinates, so they shift like points.
fn document_paths_for(position: (f32, f32), geometry: &TextGeometry) -> Vec<Contour> {
    let shift = |p: Point| Point {
        x: p.x + position.0,
        y: p.y + position.1,
    };
    geometry
        .paths
        .iter()
        .map(|c| Contour {
            closed: c.closed,
            anchors: c
                .anchors
                .iter()
                .map(|a| Anchor {
                    point: shift(a.point),
                    handle_in: a.handle_in.map(shift),
                    handle_out: a.handle_out.map(shift),
                })
                .collect(),
        })
        .collect()
}

/// Rasterises each glyph of a single-line spec on its own. The contours of the combined layout
/// are in glyph order, and each glyph's contour count comes from laying out that character alone.
fn per_glyph_union(
    db: &fontdb::Database,
    s: &TextSpec,
    w: u32,
    h: u32,
    origin: (f32, f32),
) -> Vec<u8> {
    let combined = layout(db, s).expect("layout");
    let mut union = vec![0u8; (w * h) as usize];
    let mut next = 0;
    for ch in s.content.chars() {
        let single = layout(
            db,
            &TextSpec {
                content: ch.to_string(),
                ..s.clone()
            },
        )
        .expect("layout");
        let paths = combined.paths[next..next + single.paths.len()].to_vec();
        next += single.paths.len();
        let glyph = TextGeometry {
            paths,
            ..combined.clone()
        };
        let pixmap = rasterise(&glyph, w, h, origin);
        for (i, px) in pixmap.pixels().iter().enumerate() {
            union[i] = union[i].max(px.alpha());
        }
    }
    assert_eq!(
        next,
        combined.paths.len(),
        "every contour belongs to a glyph"
    );
    union
}

fn write_golden(name: &str, pixmap: &Pixmap) {
    if std::env::var("OBLIQUE_WRITE_GOLDENS").as_deref() != Ok("1") {
        return;
    }
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/goldens");
    std::fs::create_dir_all(&dir).expect("goldens dir");
    pixmap
        .save_png(dir.join(format!("{name}.png")))
        .expect("write png");
}

fn ink_width_of(db: &fontdb::Database, s: &TextSpec, name: &str) -> u32 {
    let pixmap = rasterise(&layout(db, s).expect("layout"), 1000, 320, (50.0, 220.0));
    write_golden(name, &pixmap);
    ink_width(&pixmap)
}

#[test]
fn tight_tracking_leaves_no_holes() {
    let Some(db) = font_db(CONDENSED) else { return };
    let s = spec(CONDENSED, "HAVE", 200.0, -150.0, 100.0);
    let (w, h, origin) = (700, 320, (50.0, 220.0));
    let combined = rasterise(&layout(db, &s).expect("layout"), w, h, origin);
    write_golden("have_tight", &combined);
    let union = per_glyph_union(db, &s, w, h, origin);
    assert!(union.iter().any(|&a| a == 255), "the union has solid ink");
    assert_eq!(holes_inside(&combined, &union), 0);
}

#[test]
fn kerning_shrinks_the_ink() {
    let Some(db) = font_db(HELVETICA) else { return };
    let ink = |k| {
        ink_width_of(
            db,
            &spec(HELVETICA, "AV", 200.0, 0.0, k),
            &format!("av_kern{k}"),
        )
    };
    let (k0, k100, k200) = (ink(0.0), ink(100.0), ink(200.0));
    assert!(
        k0 > k100 && k100 > k200,
        "ink widths {k0} > {k100} > {k200}"
    );
}

#[test]
fn tracking_adds_ink_width() {
    let Some(db) = font_db(HELVETICA) else { return };
    let ink = |t| {
        ink_width_of(
            db,
            &spec(HELVETICA, "ABC", 200.0, t, 100.0),
            &format!("abc_track{t}"),
        )
    };
    let grown = ink(200.0) as f32 - ink(0.0) as f32;
    let expected = 2.0 * 200.0 * 200.0 / 1000.0;
    assert!(
        (grown - expected).abs() <= 2.0,
        "grew {grown}px, expected {expected}px"
    );
}

#[test]
fn outlines_match_the_live_text() {
    let Some(db) = font_db(HELVETICA) else { return };
    let geometry =
        layout(db, &spec(HELVETICA, "Oblique\nType", 120.0, 20.0, 100.0)).expect("layout");
    let position = (37.25, 142.5);
    let live = rasterise(&geometry, 900, 400, position);
    let moved = TextGeometry {
        paths: document_paths_for(position, &geometry),
        ..geometry.clone()
    };
    let outlines = rasterise(&moved, 900, 400, (0.0, 0.0));
    write_golden("outlines", &live);
    assert!(ink_width(&live) > 100, "the text drew something");
    assert_eq!(live.data(), outlines.data());
}

#[test]
fn o_has_an_unfilled_counter() {
    let Some(db) = font_db(HELVETICA) else { return };
    let geometry = layout(db, &spec(HELVETICA, "O", 200.0, 0.0, 100.0)).expect("layout");
    let origin = (50.0, 220.0);
    let pixmap = rasterise(&geometry, 400, 320, origin);
    write_golden("o", &pixmap);
    let b = geometry.bounds.expect("bounds");
    let (cx, cy) = (origin.0 + b.x + b.w / 2.0, origin.1 + b.y + b.h / 2.0);
    assert_eq!(
        alpha_at(&pixmap, cx as u32, cy as u32),
        0,
        "counter centre is empty"
    );
    assert_eq!(
        alpha_at(&pixmap, (origin.0 + b.x + 6.0) as u32, cy as u32),
        255,
        "stroke is solid"
    );
}
