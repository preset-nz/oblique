//! Engine tests against the real system font database (macOS dev machines). They skip
//! with a note when Helvetica is missing.

use super::*;

const FONT: &str = "Helvetica";

fn db() -> Option<&'static fontdb::Database> {
    let db = crate::fonts::database();
    if db.faces().any(|f| f.post_script_name == FONT) {
        Some(db)
    } else {
        eprintln!("skipping: {FONT} is not installed");
        None
    }
}

fn spec(content: &str) -> TextSpec {
    TextSpec {
        content: content.to_string(),
        postscript_name: FONT.to_string(),
        font_size: 100.0,
        tracking: 0.0,
        kerning: true,
        line_height: 1.2,
        align: Align::Left,
    }
}

fn width(db: &fontdb::Database, s: &TextSpec) -> f32 {
    layout(db, s).expect("layout").lines[0].width
}

#[test]
fn kerning_narrows_av() {
    let Some(db) = db() else { return };
    let on = width(db, &spec("AV"));
    let off = width(
        db,
        &TextSpec {
            kerning: false,
            ..spec("AV")
        },
    );
    assert!(on < off, "kerned {on} should be < unkerned {off}");
}

#[test]
fn tracking_adds_after_every_cluster() {
    let Some(db) = db() else { return };
    let base = width(db, &spec("ABC"));
    let tracked = width(
        db,
        &TextSpec {
            tracking: 100.0,
            ..spec("ABC")
        },
    );
    assert!((tracked - base - 30.0).abs() < 0.01, "{tracked} vs {base}");
}

#[test]
fn alignment_anchors() {
    let Some(db) = db() else { return };
    let left = layout(db, &spec("Hello")).unwrap().lines[0];
    assert_eq!(left.x_start, 0.0);
    let centre = layout(
        db,
        &TextSpec {
            align: Align::Center,
            ..spec("Hello")
        },
    )
    .unwrap()
    .lines[0];
    assert_eq!(centre.x_start, -centre.width / 2.0);
    let right = layout(
        db,
        &TextSpec {
            align: Align::Right,
            ..spec("Hello")
        },
    )
    .unwrap()
    .lines[0];
    assert_eq!(right.x_start, -right.width);
}

#[test]
fn empty_lines_still_take_a_line() {
    let Some(db) = db() else { return };
    let g = layout(db, &spec("A\n\nB")).unwrap();
    assert_eq!(g.lines.len(), 3);
    assert_eq!(g.lines[1].width, 0.0);
    assert_eq!(g.lines[2].baseline_y, 2.0 * 1.2 * 100.0);
    assert_eq!(g.lines[0].baseline_y, 0.0);
}

#[test]
fn empty_content_has_no_ink() {
    let Some(db) = db() else { return };
    let g = layout(db, &spec("")).unwrap();
    assert!(g.paths.is_empty());
    assert_eq!(g.lines.len(), 1);
    assert_eq!(g.lines[0].width, 0.0);
    assert!(g.bounds.is_none());
}

#[test]
fn unknown_postscript_name_is_font_not_found() {
    let Some(db) = db() else { return };
    let r = layout(
        db,
        &TextSpec {
            postscript_name: "No-Such-Font".into(),
            ..spec("A")
        },
    );
    assert!(matches!(r, Err(TextError::FontNotFound(n)) if n == "No-Such-Font"));
}

#[test]
fn layout_is_deterministic() {
    let Some(db) = db() else { return };
    let s = TextSpec {
        tracking: 25.0,
        align: Align::Center,
        ..spec("Hello\nWorld AV")
    };
    let a = serde_json::to_string(&layout(db, &s).unwrap()).unwrap();
    let b = serde_json::to_string(&layout(db, &s).unwrap()).unwrap();
    assert_eq!(a, b);
}

#[test]
fn o_is_two_closed_contours() {
    let Some(db) = db() else { return };
    let g = layout(db, &spec("O")).unwrap();
    assert_eq!(g.paths.len(), 2);
    assert!(g.paths.iter().all(|c| c.closed));
    // No contour keeps a zero-length closing segment.
    for c in &g.paths {
        let (f, l) = (c.anchors[0].point, c.anchors[c.anchors.len() - 1].point);
        assert!((f.x - l.x).abs() > 1e-3 || (f.y - l.y).abs() > 1e-3);
    }
}

#[test]
fn bounds_and_metrics_are_sane() {
    let Some(db) = db() else { return };
    let g = layout(db, &spec("H")).unwrap();
    let b = g.bounds.expect("ink");
    // Cap height sits above the baseline (negative y), within ascent.
    assert!(b.y < 0.0 && b.y + b.h <= 1.0);
    assert!(-b.y <= g.ascent + 1.0);
    assert!(g.ascent > 0.0 && g.descent > 0.0);
    // Every anchor lies inside the reported bounds.
    for a in g.paths.iter().flat_map(|c| &c.anchors) {
        assert!(a.point.x >= b.x - 0.01 && a.point.x <= b.x + b.w + 0.01);
        assert!(a.point.y >= b.y - 0.01 && a.point.y <= b.y + b.h + 0.01);
    }
}


/// Glyphs in some fonts wind in opposite directions (HelveticaNeue-CondensedBold:
/// H's outer is anticlockwise, A's clockwise), so tight tracking punched holes
/// where letters overlapped under nonzero fill. Every glyph's largest contour
/// must come out with the same orientation (Epic 20 dogfood, 2026-10-01).
#[test]
fn every_glyph_outer_has_the_same_orientation() {
    let db = crate::fonts::database();
    for ps in ["Helvetica", "HelveticaNeue-CondensedBold"] {
        if !db.faces().any(|f| f.post_script_name == ps) {
            eprintln!("skipping: {ps} is not installed");
            continue;
        }
        for ch in ["H", "O", "A", "V", "e", "B"] {
            let mut s = spec(ch);
            s.postscript_name = ps.into();
            let g = layout(db, &s).unwrap();
            let largest = g
                .paths
                .iter()
                .map(outline::signed_area)
                .max_by(|a, b| a.abs().total_cmp(&b.abs()))
                .unwrap();
            assert!(largest > 0.0, "{ps} {ch}: outer contour area {largest}");
        }
    }
}
