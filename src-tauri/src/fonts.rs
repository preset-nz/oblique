//! Installed-font catalogue (Epic 20, story 1).
//!
//! The webview can't enumerate system fonts, and an unknown CSS family falls back
//! silently, so "installed or missing?" and "which face is closest?" need Rust.
//! `list_fonts` scans once (fontdb), caches the result for the process lifetime and
//! hands the frontend a flat, deterministically ordered list of faces. Faces are
//! addressed by PostScript name everywhere downstream.

use std::collections::HashSet;
use std::sync::OnceLock;

use ttf_parser::name_id;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFace {
    /// Typographic family (name ID 16), else family (ID 1).
    pub family: String,
    /// Typographic subfamily (ID 17), else subfamily (ID 2).
    pub style: String,
    pub postscript_name: String,
    /// OS/2 usWeightClass (fontdb's `Weight.0`).
    pub weight: u16,
    /// fontdb `Style::Italic | Style::Oblique`.
    pub italic: bool,
    /// "serif" | "sans" | "mono" | "script" | "display" | "symbol" | "unknown"
    pub category: String,
}

static CATALOGUE: OnceLock<Vec<FontFace>> = OnceLock::new();

#[tauri::command]
pub async fn list_fonts() -> Vec<FontFace> {
    if let Some(cached) = CATALOGUE.get() {
        return cached.clone();
    }
    tauri::async_runtime::spawn_blocking(|| CATALOGUE.get_or_init(scan_system_fonts).clone())
        .await
        .unwrap_or_default()
}

/// Maps the high byte of OS/2 `sFamilyClass` (and fontdb's monospaced flag) to a category.
fn category_from_family_class(class_hi: u8, monospaced: bool) -> &'static str {
    if monospaced {
        return "mono";
    }
    match class_hi {
        1 | 2 | 3 | 4 | 5 | 7 => "serif",
        8 => "sans",
        9 => "display",
        10 => "script",
        12 => "symbol",
        _ => "unknown",
    }
}

/// High byte of `sFamilyClass` (big-endian i16 at byte offset 30 of OS/2), if the table has it.
fn family_class_hi(face: &ttf_parser::Face) -> Option<u8> {
    let os2 = face
        .raw_face()
        .table(ttf_parser::Tag::from_bytes(b"OS/2"))?;
    os2.get(30).copied()
}

/// English (US) record for `id` if present, else the first decodable record with that ID.
fn name_string(face: &ttf_parser::Face, id: u16) -> Option<String> {
    let mut first: Option<String> = None;
    for name in face.names() {
        if name.name_id != id {
            continue;
        }
        let Some(s) = name.to_string() else { continue };
        if s.is_empty() {
            continue;
        }
        if name.language() == ttf_parser::Language::English_UnitedStates {
            return Some(s);
        }
        first.get_or_insert(s);
    }
    first
}

fn scan_system_fonts() -> Vec<FontFace> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let mut faces = Vec::with_capacity(db.len());
    for info in db.faces() {
        if info.post_script_name.is_empty() {
            continue;
        }
        let parsed = db.with_face_data(info.id, |data, index| {
            let face = ttf_parser::Face::parse(data, index).ok()?;
            let family = name_string(&face, name_id::TYPOGRAPHIC_FAMILY)
                .or_else(|| name_string(&face, name_id::FAMILY));
            let style = name_string(&face, name_id::TYPOGRAPHIC_SUBFAMILY)
                .or_else(|| name_string(&face, name_id::SUBFAMILY));
            Some((family, style, family_class_hi(&face)))
        });
        let (family, style, class_hi) = parsed.flatten().unwrap_or((None, None, None));
        let Some(family) = family.or_else(|| info.families.first().map(|(f, _)| f.clone())) else {
            continue;
        };
        faces.push(FontFace {
            family,
            style: style.unwrap_or_default(),
            postscript_name: info.post_script_name.clone(),
            weight: info.weight.0,
            italic: info.style != fontdb::Style::Normal,
            category: category_from_family_class(class_hi.unwrap_or(0), info.monospaced)
                .to_string(),
        });
    }
    finalise(faces)
}

/// Drops hidden faces (family starts with `.`), sorts deterministically, then removes
/// duplicate PostScript names (first in sort order wins, so the choice is stable
/// regardless of directory-scan order).
fn finalise(mut faces: Vec<FontFace>) -> Vec<FontFace> {
    faces.retain(|f| !f.family.starts_with('.'));
    faces.sort_by(|a, b| {
        a.family
            .to_lowercase()
            .cmp(&b.family.to_lowercase())
            .then(a.weight.cmp(&b.weight))
            .then(a.italic.cmp(&b.italic))
            .then_with(|| a.style.cmp(&b.style))
            .then_with(|| a.family.cmp(&b.family))
            .then_with(|| a.postscript_name.cmp(&b.postscript_name))
    });
    let mut seen = HashSet::new();
    faces.retain(|f| seen.insert(f.postscript_name.clone()));
    faces
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_class_decoding() {
        for hi in [1, 2, 3, 4, 5, 7] {
            assert_eq!(category_from_family_class(hi, false), "serif");
        }
        assert_eq!(category_from_family_class(8, false), "sans");
        assert_eq!(category_from_family_class(9, false), "display");
        assert_eq!(category_from_family_class(10, false), "script");
        assert_eq!(category_from_family_class(12, false), "symbol");
        for hi in [0, 6, 11, 13, 14, 255] {
            assert_eq!(category_from_family_class(hi, false), "unknown");
        }
    }

    #[test]
    fn monospaced_wins_over_class() {
        assert_eq!(category_from_family_class(2, true), "mono");
        assert_eq!(category_from_family_class(0, true), "mono");
    }

    fn face(family: &str, ps: &str, weight: u16, italic: bool) -> FontFace {
        FontFace {
            family: family.into(),
            style: String::new(),
            postscript_name: ps.into(),
            weight,
            italic,
            category: "sans".into(),
        }
    }

    #[test]
    fn finalise_filters_sorts_dedupes() {
        let out = finalise(vec![
            face(".SF NS", "SFNS", 400, false),
            face("beta", "Beta-Bold", 700, false),
            face("Alpha", "Alpha-Italic", 400, true),
            face("Alpha", "Alpha-Regular", 400, false),
            face("Alpha", "Alpha-Regular", 400, false),
        ]);
        let names: Vec<_> = out.iter().map(|f| f.postscript_name.as_str()).collect();
        assert_eq!(names, ["Alpha-Regular", "Alpha-Italic", "Beta-Bold"]);
    }

    /// Real scan of this machine's fonts. `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn macos_system_scan_smoke() {
        let faces = scan_system_fonts();
        println!("{} faces", faces.len());
        assert!(faces.len() > 200);
        assert!(faces.iter().all(|f| !f.family.starts_with('.')));
        let hn = faces
            .iter()
            .find(|f| f.postscript_name == "HelveticaNeue-CondensedBold")
            .expect("HelveticaNeue-CondensedBold");
        println!("{hn:?}");
        assert_eq!(hn.family, "Helvetica Neue");
        assert_eq!(hn.style, "Condensed Bold");
    }
}
