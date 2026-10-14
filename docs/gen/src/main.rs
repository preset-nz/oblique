//! `just docs`: one markdown page per Oblique node kind in `docs/nodes/`, from the words
//! the kinds carry (`document::kinds`). `--check` writes nothing and fails on a missing,
//! stale or orphaned page or a kind without a summary (`just docs-check`, part of
//! `just check` when preset-docs is checked out beside this repo).
//!
//! The op kinds come from the Python sidecar's `OPS`, read the way the `real_projects` test
//! reads them: through `uv`, or from the `list_ops` JSON file named by `OBLIQUE_OPS`.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use oblique_lib::{sidecar_catalogue, Oblique};
use rhizome_core::IdSource;
use rhizome_pom::{Document, MemoryStore, ObjectModel};

fn main() -> ExitCode {
    let check = std::env::args().any(|a| a == "--check");
    let catalogue = match sidecar_catalogue() {
        Ok(c) if !c.0.is_empty() => Arc::new(c),
        Ok(_) => {
            eprintln!("oblique-docs: the sidecar reported no ops");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("oblique-docs: {e}");
            return ExitCode::FAILURE;
        }
    };
    let doc = Document::<Oblique>::new_in(catalogue, MemoryStore::default(), IdSource::Ulid)
        .expect("Oblique's model builds");
    let mut schema = doc.tree().registry().schema();
    // rhizome-pom's own `preset` node is bookkeeping for saved presets, not
    // something a person adds; it carries no words and gets no page.
    schema.types.retain(|t| t.name != "preset");
    // `debug_`-prefixed ops are the protocol's own canaries, hidden from the Add Modifier
    // list (src/panels/stack/AddModifier.tsx), so they get no page either.
    schema.types.retain(|t| !t.name.starts_with("op.debug_"));

    let schema = preset_docs::Catalogue::from(&schema);

    let app = Oblique::NAME;
    let dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../nodes"));
    if !check {
        match preset_docs::write(&dir, &schema, app) {
            Ok(files) => {
                for f in files {
                    println!("wrote {f}");
                }
            }
            Err(e) => {
                eprintln!("oblique-docs: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
    let findings = match preset_docs::check(&dir, &schema, app) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("oblique-docs: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut failed = false;
    for f in &findings {
        // Without --check the pages were just written; what remains is for a person.
        let fails = check && !f.is_warning();
        failed |= fails;
        eprintln!("{}: {f}", if fails { "error" } else { "warning" });
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
