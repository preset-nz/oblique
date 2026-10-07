//! The object model's contracts, with no window: every write is a command, one undo step
//! each, and the domain rules (locks, labels, soft max) hold however the webview behaves.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use preset_app_kit::{edit_titles, Document as _, DocumentState, History as _, HistoryState};
use rhizome_core::{IdSource, On, Value};
use rhizome_pom::{Document, FileStore, Host, MemoryStore, Outcome, Pom};
use rhizome_pom_tauri::PomHost;
use serde_json::{json, Value as Json};
use tauri::test::{mock_app, MockRuntime};
use tauri::Listener as _;

use super::host::{DOCUMENT_OPENED, HISTORY_STEPPED, NOT_READY};
use super::{
    fit_replaced_transform, refit_attach_transform, Catalogue, DocumentHost, Oblique, Op, OpParam,
    Placement,
};

fn param(name: &str, kind: &str, default: Json, min: Option<f64>, max: Option<f64>) -> OpParam {
    OpParam {
        name: name.into(),
        kind: kind.into(),
        default,
        min,
        max,
        choices: if kind == "enum" {
            vec!["soft".into(), "hard".into()]
        } else {
            vec![]
        },
    }
}

/// What `list_ops` might report, with each param kind that has a kind of value in rhizome.
fn catalogue() -> Arc<Catalogue> {
    Arc::new(Catalogue(vec![Op {
        name: "blur".into(),
        params: vec![
            param("radius", "float", json!(5.0), Some(0.0), Some(100.0)),
            param("steps", "int", json!(3), Some(1.0), Some(10.0)),
            param("gain", "float", json!(1.0), None, None),
            param("mode", "enum", json!("soft"), None, None),
            param("tint", "color", json!("#ff0000"), None, None),
            param("on", "bool", json!(true), None, None),
        ],
    }]))
}

fn doc() -> Document<Oblique> {
    Document::new_in(catalogue(), MemoryStore::default(), IdSource::sequential()).unwrap()
}

fn pom(store: &MemoryStore) -> Pom<Oblique> {
    let store = store.clone();
    Pom::new_in(
        catalogue(),
        move || Box::new(store.clone()),
        IdSource::sequential,
    )
    .unwrap()
}

/// A `SceneNode` as TypeScript builds it (src/scene/types.ts).
fn node(id: &str, kind: &str) -> Json {
    let mut n = json!({
        "id": id,
        "type": kind,
        "label": "Layer",
        "state": "active",
        "output": "image",
        "visible": true,
        "blendMode": "normal",
        "opacity": 1.0,
        "modifiers": [],
    });
    let extra = match kind {
        "pixel" => json!({"sourcePath": "photo.png", "sourceSize": [640.0, 480.0]}),
        "vector" => json!({
            "paths": [{"anchors": [{"point": {"x": 1.0, "y": 2.0}}], "closed": false}],
            "fillRule": "nonzero",
        }),
        _ => json!({
            "content": "Hello",
            "label": "Hello",
            "font": {"family": "Inter", "style": "Regular", "postscriptName": "Inter-Regular",
                     "weight": 400.0, "italic": false, "category": "sans-serif"},
            "fontSize": 72.0,
            "tracking": 0.0,
            "kerning": 100.0,
            "lineHeight": 1.2,
            "align": "left",
            "fill": "#ffffff",
            "stroke": null,
            "position": {"x": 10.0, "y": 20.0},
        }),
    };
    n.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    n
}

fn add(d: &mut Document<Oblique>, n: Json) -> rhizome_pom::Result<Outcome> {
    d.run("layer.add", &json!({ "node": n }))
}

fn set(
    d: &mut Document<Oblique>,
    at: &str,
    key: &str,
    value: Json,
) -> rhizome_pom::Result<Outcome> {
    d.run(
        "values.set",
        &json!({"changes": [{"at": at, "key": key, "value": value}]}),
    )
}

fn text(d: &mut Document<Oblique>, at: &str, patch: Json) -> rhizome_pom::Result<Outcome> {
    d.run("text.set", &json!({"at": at, "patch": patch}))
}

fn value(d: &Document<Oblique>, at: &str, key: &str) -> Option<Value> {
    d.tree().at(at).and_then(|n| n.value(key))
}

fn stack(d: &Document<Oblique>) -> Vec<String> {
    d.tree()
        .at("/layers")
        .unwrap()
        .order("stack")
        .iter()
        .map(|n| n.name().to_string())
        .collect()
}

fn lock(d: &mut Document<Oblique>, at: &str) {
    // Locking has no command yet (Epic 21 story 6); the lock state is written directly.
    d.edit("Lock", |tx| {
        tx.set_value(at, "state", Value::Choice("locked".into()))
    })
    .unwrap();
}

// ---- seed ----

#[test]
fn a_new_document_has_its_document_node_with_oblique_defaults() {
    let d = doc();
    let at = "/document/document";
    assert_eq!(d.tree().at(at).unwrap().type_name(), "document");
    assert_eq!(value(&d, at, "documentSize"), Some(Value::Vec2([0.0, 0.0])));
    assert_eq!(
        value(&d, at, "resolution"),
        Some(Value::Choice("working".into()))
    );
    assert_eq!(value(&d, at, "note"), Some(Value::Text(String::new())));
    // the scene id is the node's own id
    let id = d.tree().at(at).unwrap().id().to_string();
    assert_eq!(value(&d, at, "sceneId"), Some(Value::Text(id)));
    assert!(d.tree().at("/layers").is_some());
}

#[test]
fn the_seed_is_not_an_undo_step_and_not_unsaved() {
    let mut d = doc();
    assert_eq!(d.tree().history_len(), 0);
    assert!(d.tree().undo_label().is_none());
    assert!(!d.is_unsaved());
    assert!(d.undo().unwrap().is_none());
    // the document node can't be removed or duplicated
    assert!(!d.policy("document").deletable);
    assert!(!d.policy("document").duplicable);
}

// ---- layer.add ----

#[test]
fn a_new_layer_goes_on_top_of_the_stack() {
    let mut d = doc();
    for id in ["a", "b", "c"] {
        add(&mut d, node(id, "pixel")).unwrap();
    }
    assert_eq!(stack(&d), ["c", "b", "a"]);
    assert_eq!(d.tree().at("/layers/c").unwrap().type_name(), "pixel");
}

#[test]
fn layer_add_stores_the_node_typescript_built() {
    let mut d = doc();
    let mut n = node("v", "vector");
    n["transform2d"] = json!({"x": 5.0, "y": 6.0, "scaleX": 2.0, "scaleY": 3.0, "rotation": 0.5});
    n["opacity"] = json!(0.25);
    add(&mut d, n).unwrap();
    assert_eq!(value(&d, "/layers/v", "opacity"), Some(Value::Float(0.25)));
    assert_eq!(
        value(&d, "/layers/v", "transform2d.position"),
        Some(Value::Vec2([5.0, 6.0]))
    );
    assert_eq!(
        value(&d, "/layers/v", "transform2d.scale"),
        Some(Value::Vec2([2.0, 3.0]))
    );
    assert_eq!(
        value(&d, "/layers/v", "transform2d.rotation"),
        Some(Value::Float(0.5))
    );
    // an absent transform2d reads as identity: the keys stay unset
    add(&mut d, node("p", "pixel")).unwrap();
    assert!(!d
        .tree()
        .at("/layers/p")
        .unwrap()
        .is_set("transform2d.position"));
    assert_eq!(
        value(&d, "/layers/p", "transform2d.scale"),
        Some(Value::Vec2([1.0, 1.0]))
    );
    // a text layer takes its text keys
    add(&mut d, node("t", "text")).unwrap();
    assert_eq!(
        value(&d, "/layers/t", "content"),
        Some(Value::Text("Hello".into()))
    );
}

#[test]
fn layer_add_refuses_a_duplicate_id_and_changes_nothing() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    assert!(add(&mut d, node("a", "vector")).is_err());
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
    assert_eq!(stack(&d), ["a"]);
}

#[test]
fn layer_add_is_one_undo_step_and_undo_removes_the_layer() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let mut n = node("b", "pixel");
    n["modifiers"] =
        json!([{"id": "m1", "type": "blur", "enabled": true, "params": {"radius": 12.0}}]);
    add(&mut d, n).unwrap();
    assert_eq!(d.tree().history_len(), 2);
    assert_eq!(d.tree().undo_label(), Some("New pixel"));
    d.undo().unwrap();
    assert_eq!(stack(&d), ["a"]);
    assert!(d.tree().at("/layers/b").is_none());
    d.undo().unwrap();
    assert!(stack(&d).is_empty());
    assert!(d.undo().unwrap().is_none());
    d.redo().unwrap();
    d.redo().unwrap();
    assert_eq!(stack(&d), ["b", "a"]);
    assert!(d.tree().at("/layers/b/m1").is_some());
}

#[test]
fn layer_add_refuses_what_isnt_a_layer_or_doesnt_fit() {
    let mut d = doc();
    assert!(add(&mut d, node("a", "camera")).is_err());
    assert!(add(&mut d, json!({"type": "pixel"})).is_err(), "no id");
    let mut bad = node("b", "pixel");
    bad["opacity"] = json!(7.0);
    assert!(add(&mut d, bad).is_err(), "opacity is hard-capped at 1");
    // a refused add leaves no half-made layer
    assert!(stack(&d).is_empty());
    assert!(d.tree().at("/layers/b").is_none());
    assert_eq!(d.tree().history_len(), 0);
    // the command isn't enabled without a node
    assert!(!d.is_enabled("layer.add", &json!({})).unwrap());
}

// ---- values.set ----

#[test]
fn values_set_writes_transform_and_layer_props_in_one_step() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let steps = d.tree().history_len();
    d.run(
        "values.set",
        &json!({"changes": [
            {"at": "/layers/a", "key": "transform2d.position", "value": [10.0, 20.0]},
            {"at": "/layers/a", "key": "transform2d.scale", "value": [2.0, 2.0]},
            {"at": "/layers/a", "key": "transform2d.rotation", "value": 1.5},
            {"at": "/layers/a", "key": "opacity", "value": 0.5},
            {"at": "/layers/a", "key": "blendMode", "value": "multiply"},
            {"at": "/layers/a", "key": "visible", "value": false},
            {"at": "/layers/a", "key": "label", "value": "Sky"},
        ]}),
    )
    .unwrap();
    assert_eq!(d.tree().history_len(), steps + 1);
    assert_eq!(
        value(&d, "/layers/a", "transform2d.position"),
        Some(Value::Vec2([10.0, 20.0]))
    );
    assert_eq!(value(&d, "/layers/a", "opacity"), Some(Value::Float(0.5)));
    assert_eq!(
        value(&d, "/layers/a", "blendMode"),
        Some(Value::Choice("multiply".into()))
    );
    assert_eq!(value(&d, "/layers/a", "visible"), Some(Value::Bool(false)));
    assert_eq!(
        value(&d, "/layers/a", "label"),
        Some(Value::Text("Sky".into()))
    );
    d.undo().unwrap();
    assert_eq!(value(&d, "/layers/a", "opacity"), Some(Value::Float(1.0)));
    assert_eq!(
        value(&d, "/layers/a", "label"),
        Some(Value::Text("Layer".into()))
    );
}

#[test]
fn values_set_refuses_keys_that_arent_moved_yet() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    let before = d.tree().serialise();
    for (at, key, v) in [
        ("/layers/a", "state", json!("locked")),
        ("/layers/a", "sourceSize", json!([1.0, 1.0])),
        ("/layers/a", "transform", json!(vec![0.0; 16])),
        ("/layers/t", "content", json!("sneaky")),
        ("/document/document", "documentSize", json!([10.0, 10.0])),
        ("/document/document", "note", json!("hi")),
    ] {
        let e = set(&mut d, at, key, v).unwrap_err();
        assert!(e.to_string().contains("isn't on rhizome yet"), "{key}: {e}");
    }
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), 2);
}

#[test]
fn values_set_is_all_or_nothing() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let before = d.tree().serialise();
    let r = d.run(
        "values.set",
        &json!({"changes": [
            {"at": "/layers/a", "key": "opacity", "value": 0.5},
            {"at": "/layers/a", "key": "opacity", "value": 3.0},
        ]}),
    );
    assert!(r.is_err());
    assert_eq!(d.tree().serialise(), before);
    assert!(set(&mut d, "/layers/nope", "opacity", json!(0.5)).is_err());
    assert!(set(&mut d, "/layers/a", "blendMode", json!("dissolve")).is_err());
    assert!(set(&mut d, "/layers/a", "visible", json!("yes")).is_err());
}

#[test]
fn a_drag_of_value_writes_is_one_undo_step() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let steps = d.tree().history_len();
    for x in 1..=20 {
        let payload = json!({"changes": [
            {"at": "/layers/a", "key": "transform2d.position", "value": [x as f64, 0.0]},
        ]});
        d.run_coalesced("values.set", &payload, "drag:a").unwrap();
    }
    assert_eq!(d.tree().history_len(), steps + 1);
    d.undo().unwrap();
    assert!(!d
        .tree()
        .at("/layers/a")
        .unwrap()
        .is_set("transform2d.position"));
}

// ---- locks ----

#[test]
fn a_locked_layer_refuses_transform_and_text_writes() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    lock(&mut d, "/layers/a");
    lock(&mut d, "/layers/t");
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    for (key, v) in [
        ("transform2d.position", json!([1.0, 1.0])),
        ("transform2d.scale", json!([2.0, 2.0])),
        ("transform2d.rotation", json!(1.0)),
    ] {
        let e = set(&mut d, "/layers/a", key, v).unwrap_err();
        assert!(e.to_string().contains("is locked"), "{key}: {e}");
    }
    // a batch with one guarded key is refused whole
    let e = d
        .run(
            "values.set",
            &json!({"changes": [
                {"at": "/layers/a", "key": "opacity", "value": 0.5},
                {"at": "/layers/a", "key": "transform2d.rotation", "value": 1.0},
            ]}),
        )
        .unwrap_err();
    assert!(e.to_string().contains("is locked"), "{e}");
    let e = text(&mut d, "/layers/t", json!({"content": "changed"})).unwrap_err();
    assert!(e.to_string().contains("is locked"), "{e}");
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

#[test]
fn compositing_props_stay_writable_on_a_locked_layer() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    lock(&mut d, "/layers/a");
    for (key, v) in [
        ("opacity", json!(0.5)),
        ("blendMode", json!("screen")),
        ("visible", json!(false)),
        ("label", json!("x")),
        ("output", json!("mask")),
    ] {
        set(&mut d, "/layers/a", key, v.clone()).unwrap_or_else(|e| panic!("{key}: {e}"));
        assert_eq!(
            d.tree()
                .at("/layers/a")
                .unwrap()
                .value(key)
                .unwrap()
                .to_json(),
            v,
            "{key}"
        );
    }
}

#[test]
fn locking_one_layer_leaves_the_others_writable() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("b", "pixel")).unwrap();
    lock(&mut d, "/layers/a");
    set(
        &mut d,
        "/layers/b",
        "transform2d.position",
        json!([1.0, 2.0]),
    )
    .unwrap();
    // unlocking (undo of the lock edit here) makes it writable again
    d.undo().unwrap(); // the move
    d.undo().unwrap(); // the lock
    set(
        &mut d,
        "/layers/a",
        "transform2d.position",
        json!([1.0, 2.0]),
    )
    .unwrap();
}

// ---- text.set ----

#[test]
fn the_label_follows_the_content_while_it_is_automatic() {
    let mut d = doc();
    add(&mut d, node("t", "text")).unwrap();
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("Hello".into()))
    );
    text(
        &mut d,
        "/layers/t",
        json!({"content": "  \n  World  \nsecond line"}),
    )
    .unwrap();
    assert_eq!(
        value(&d, "/layers/t", "content"),
        Some(Value::Text("  \n  World  \nsecond line".into()))
    );
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("World".into()))
    );
    text(&mut d, "/layers/t", json!({"content": ""})).unwrap();
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("Text".into()))
    );
    let long = "x".repeat(40);
    text(&mut d, "/layers/t", json!({"content": long})).unwrap();
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text(format!("{}…", "x".repeat(32))))
    );
}

#[test]
fn the_label_stops_following_once_set_explicitly() {
    let mut d = doc();
    add(&mut d, node("t", "text")).unwrap();
    set(&mut d, "/layers/t", "label", json!("My title")).unwrap();
    text(&mut d, "/layers/t", json!({"content": "Other"})).unwrap();
    assert_eq!(
        value(&d, "/layers/t", "content"),
        Some(Value::Text("Other".into()))
    );
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("My title".into()))
    );
}

#[test]
fn a_text_patch_without_content_leaves_the_label_alone() {
    let mut d = doc();
    add(&mut d, node("t", "text")).unwrap();
    text(
        &mut d,
        "/layers/t",
        json!({"fontSize": 40.0, "align": "center"}),
    )
    .unwrap();
    assert_eq!(value(&d, "/layers/t", "fontSize"), Some(Value::Float(40.0)));
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("Hello".into()))
    );
    // content and label are one undo step
    text(&mut d, "/layers/t", json!({"content": "Bye"})).unwrap();
    d.undo().unwrap();
    assert_eq!(
        value(&d, "/layers/t", "label"),
        Some(Value::Text("Hello".into()))
    );
    assert_eq!(
        value(&d, "/layers/t", "content"),
        Some(Value::Text("Hello".into()))
    );
}

#[test]
fn text_set_refuses_non_text_layers_unknown_props_and_missing_layers() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    let before = d.tree().serialise();
    assert!(text(&mut d, "/layers/a", json!({"content": "x"})).is_err());
    assert!(text(&mut d, "/layers/t", json!({"opacity": 0.5})).is_err());
    assert!(text(&mut d, "/layers/t", json!({"content": "x", "label": "y"})).is_err());
    assert!(text(&mut d, "/layers/nope", json!({"content": "x"})).is_err());
    assert_eq!(d.tree().serialise(), before);
}

#[test]
fn the_label_helper_matches_the_stores() {
    assert_eq!(super::text_label(""), "Text");
    assert_eq!(super::text_label("\n  \n"), "Text");
    assert_eq!(super::text_label("  hi  \nthere"), "hi");
    assert_eq!(
        super::text_label(&"é".repeat(33)),
        format!("{}…", "é".repeat(32))
    );
    assert_eq!(super::text_label(&"é".repeat(32)), "é".repeat(32));
}

// ---- op params ----

fn blur(d: &Document<Oblique>) -> rhizome_core::NodeType {
    d.tree().registry().node_type("op.blur").cloned().unwrap()
}

#[test]
fn an_ops_params_are_namespaced_so_they_never_meet_the_modifiers_own_values() {
    let d = doc();
    let t = blur(&d);
    let keys: Vec<&str> = t.values().iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys[0], "enabled");
    for k in [
        "params.radius",
        "params.steps",
        "params.gain",
        "params.mode",
        "params.tint",
        "params.on",
    ] {
        assert!(keys.contains(&k), "{k} in {keys:?}");
    }
    assert!(!keys.contains(&"radius"));
    assert_eq!(super::op_type("blur"), "op.blur");
    assert_eq!(super::param_key("radius"), "params.radius");
}

#[test]
fn an_op_param_named_enabled_cannot_clash_with_the_modifiers_switch() {
    let d = Document::<Oblique>::new_in(
        Arc::new(Catalogue(vec![Op {
            name: "odd".into(),
            params: vec![param("enabled", "bool", json!(false), None, None)],
        }])),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap();
    let t = d.tree().registry().node_type("op.odd").cloned().unwrap();
    let keys: Vec<&str> = t.values().iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys, ["enabled", "params.enabled"]);
}

#[test]
fn float_and_int_params_have_a_soft_max_and_a_hard_min() {
    let d = doc();
    let t = blur(&d);
    let spec = |k: &str| t.values().iter().find(|s| s.key == k).cloned().unwrap();
    let radius = spec("params.radius");
    assert_eq!(radius.range, Some((0.0, 100.0)));
    assert!(radius.soft_max);
    assert!(spec("params.steps").soft_max);
    // no range declared: unbounded
    let gain = spec("params.gain");
    assert_eq!(gain.range, None);
    assert_eq!(gain.default, Value::Float(1.0));
    // enum, colour and bool params
    assert_eq!(spec("params.mode").choices, ["soft", "hard"]);
    assert_eq!(spec("params.tint").default, Value::Text("#ff0000".into()));
    assert_eq!(spec("params.on").default, Value::Bool(true));
}

#[test]
fn a_param_may_go_past_its_max_but_never_under_its_min() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    // layer.add stores the modifiers TypeScript built; a typed value past the slider's end
    // (decision 53) is kept as written
    let mut n = node("b", "pixel");
    n["modifiers"] = json!([{"id": "m", "type": "blur", "enabled": true,
        "params": {"radius": 250.0, "steps": 99, "gain": -4.0, "mode": "hard", "tint": "#00ff00", "on": false}}]);
    add(&mut d, n).unwrap();
    let m = "/layers/b/m";
    assert_eq!(value(&d, m, "params.radius"), Some(Value::Float(250.0)));
    assert_eq!(value(&d, m, "params.steps"), Some(Value::Int(99)));
    assert_eq!(value(&d, m, "params.gain"), Some(Value::Float(-4.0)));
    assert_eq!(
        value(&d, m, "params.mode"),
        Some(Value::Choice("hard".into()))
    );
    assert_eq!(
        value(&d, m, "params.tint"),
        Some(Value::Text("#00ff00".into()))
    );
    assert_eq!(value(&d, m, "params.on"), Some(Value::Bool(false)));
    // an unset param reads as the op's default
    let mut n = node("c", "pixel");
    n["modifiers"] = json!([{"id": "m", "type": "blur", "enabled": true, "params": {}}]);
    add(&mut d, n).unwrap();
    assert_eq!(
        value(&d, "/layers/c/m", "params.radius"),
        Some(Value::Float(5.0))
    );
    assert_eq!(value(&d, "/layers/c/m", "enabled"), Some(Value::Bool(true)));
    // the min still holds, and refusing it takes the whole layer.add back
    let steps = d.tree().history_len();
    for bad in [
        json!({"radius": -0.5}),
        json!({"steps": 0}),
        json!({"mode": "medium"}),
    ] {
        let mut n = node("d", "pixel");
        n["modifiers"] = json!([{"id": "m", "type": "blur", "enabled": true, "params": bad}]);
        assert!(add(&mut d, n).is_err(), "{bad}");
    }
    assert!(d.tree().at("/layers/d").is_none());
    assert_eq!(d.tree().history_len(), steps);
    // an op the catalogue doesn't have is refused too
    let mut n = node("e", "pixel");
    n["modifiers"] = json!([{"id": "m", "type": "unknown", "enabled": true, "params": {}}]);
    assert!(add(&mut d, n).is_err());
}

#[test]
fn a_soft_max_holds_for_a_later_write_and_a_load_does_not_clamp_it() {
    let store = MemoryStore::default();
    let mut d =
        Document::<Oblique>::new_in(catalogue(), store.clone(), IdSource::sequential()).unwrap();
    let mut n = node("a", "pixel");
    n["modifiers"] =
        json!([{"id": "m", "type": "blur", "enabled": true, "params": {"radius": 10.0}}]);
    add(&mut d, n).unwrap();
    let m = "/layers/a/m";
    d.edit("Radius", |tx| {
        tx.set_value(m, "params.radius", Value::Float(1e6))
    })
    .unwrap();
    assert!(d
        .edit("Radius", |tx| tx.set_value(
            m,
            "params.radius",
            Value::Float(-1.0)
        ))
        .is_err());
    assert_eq!(value(&d, m, "params.radius"), Some(Value::Float(1e6)));
    // through a file: soft max values survive a load
    d.save_as("/mem/a.oblique").unwrap();
    let (back, report) =
        Document::<Oblique>::open_in(catalogue(), store, "/mem/a.oblique", IdSource::sequential())
            .unwrap();
    assert!(report.issues.is_empty(), "{:?}", report.issues);
    assert_eq!(value(&back, m, "params.radius"), Some(Value::Float(1e6)));
}

// ---- document.set_size ----

#[test]
fn set_size_writes_the_document_size_in_one_undo_step() {
    let mut d = doc();
    d.run("document.set_size", &json!({"size": [1920.0, 1080.0]}))
        .unwrap();
    assert_eq!(
        value(&d, "/document/document", "documentSize"),
        Some(Value::Vec2([1920.0, 1080.0]))
    );
    assert_eq!(d.tree().undo_label(), Some("Document Size"));
    assert!(d.is_unsaved());
    d.undo().unwrap();
    assert_eq!(
        value(&d, "/document/document", "documentSize"),
        Some(Value::Vec2([0.0, 0.0]))
    );
    assert!(!d.is_unsaved(), "undone back to what was saved");
    d.redo().unwrap();
    assert_eq!(
        value(&d, "/document/document", "documentSize"),
        Some(Value::Vec2([1920.0, 1080.0]))
    );
}

#[test]
fn set_size_refuses_what_isnt_a_size() {
    let mut d = doc();
    assert!(d.run("document.set_size", &json!({"size": [1.0]})).is_err());
    assert!(d.run("document.set_size", &json!({"size": "big"})).is_err());
    assert!(d
        .run("document.set_size", &json!({"size": [1.0, f64::NAN]}))
        .is_err());
    assert!(!d.is_enabled("document.set_size", &json!({})).unwrap());
    assert_eq!(d.tree().history_len(), 0);
}

// ---- undo / redo ----

#[test]
fn undo_and_redo_walk_each_step_down_to_the_empty_document_and_no_further() {
    let mut d = doc();
    let empty = d.tree().serialise();
    d.run("document.set_size", &json!({"size": [100.0, 100.0]}))
        .unwrap();
    add(&mut d, node("a", "pixel")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    set(&mut d, "/layers/a", "opacity", json!(0.5)).unwrap();
    text(&mut d, "/layers/t", json!({"content": "Bye"})).unwrap();
    let full = d.tree().serialise();
    let mut seen = vec![full.clone()];
    while d.undo().unwrap().is_some() {
        seen.push(d.tree().serialise());
    }
    assert_eq!(seen.len(), 6);
    assert_eq!(d.tree().serialise(), empty);
    assert!(!d.is_unsaved());
    assert!(d.undo().unwrap().is_none());
    // redo retraces the same states
    seen.reverse();
    for want in &seen[1..] {
        d.redo().unwrap().unwrap();
        assert_eq!(&d.tree().serialise(), want);
    }
    assert!(d.redo().unwrap().is_none());
    assert_eq!(d.tree().serialise(), full);
}

#[test]
fn a_new_edit_after_undo_drops_redo() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    d.undo().unwrap();
    assert!(d.tree().redo_label().is_some());
    add(&mut d, node("b", "pixel")).unwrap();
    assert!(d.tree().redo_label().is_none());
}

#[test]
fn a_gesture_is_one_undo_step_and_cancel_takes_it_back() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    let g = d.begin("Move").unwrap();
    for x in 1..=5 {
        set(
            &mut d,
            "/layers/a",
            "transform2d.position",
            json!([x as f64, 0.0]),
        )
        .unwrap();
    }
    d.end(g).unwrap();
    assert_eq!(d.tree().history_len(), 2);
    let g = d.begin("Move").unwrap();
    set(
        &mut d,
        "/layers/a",
        "transform2d.position",
        json!([99.0, 0.0]),
    )
    .unwrap();
    d.cancel(g).unwrap();
    assert_eq!(
        value(&d, "/layers/a", "transform2d.position"),
        Some(Value::Vec2([5.0, 0.0]))
    );
    assert_eq!(d.tree().history_len(), 2);
}

// ---- files ----

fn busy(d: &mut Document<Oblique>) {
    d.run("document.set_size", &json!({"size": [800.0, 600.0]}))
        .unwrap();
    add(d, node("a", "pixel")).unwrap();
    let mut v = node("v", "vector");
    v["modifiers"] = json!([
        {"id": "m1", "type": "blur", "enabled": true, "params": {"radius": 250.0, "mode": "hard"}},
        {"id": "m2", "type": "blur", "enabled": false, "params": {}},
    ]);
    add(d, v).unwrap();
    add(d, node("t", "text")).unwrap();
    set(d, "/layers/a", "transform2d.position", json!([3.0, 4.5])).unwrap();
    set(d, "/layers/v", "opacity", json!(0.4)).unwrap();
    text(d, "/layers/t", json!({"content": "Réunion"})).unwrap();
}

#[test]
fn a_save_and_open_round_trip_reproduces_the_tree_exactly() {
    let store = MemoryStore::default();
    let mut d =
        Document::<Oblique>::new_in(catalogue(), store.clone(), IdSource::sequential()).unwrap();
    busy(&mut d);
    assert!(d.is_unsaved());
    d.save_as("/mem/work").unwrap();
    // the extension is added
    assert_eq!(d.path().unwrap().extension().unwrap(), "oblique");
    assert!(!d.is_unsaved());
    let saved = d.tree().serialise();
    assert_eq!(
        store.get("/mem/work.oblique").as_deref(),
        Some(saved.as_str())
    );

    let (back, report) = Document::<Oblique>::open_in(
        catalogue(),
        store.clone(),
        "/mem/work.oblique",
        IdSource::sequential(),
    )
    .unwrap();
    assert!(report.issues.is_empty(), "{:?}", report.issues);
    assert_eq!(back.tree().serialise(), saved);
    assert!(!back.is_unsaved());
    assert_eq!(stack(&back), ["t", "v", "a"]);
    // order of modifiers, ref and values all survive
    assert_eq!(
        value(&back, "/layers/a", "transform2d.position"),
        Some(Value::Vec2([3.0, 4.5]))
    );
    assert_eq!(
        value(&back, "/layers/v/m1", "params.radius"),
        Some(Value::Float(250.0))
    );
    let order: Vec<String> = back
        .tree()
        .at("/layers/v")
        .unwrap()
        .order("modifiers")
        .iter()
        .map(|n| n.name().to_string())
        .collect();
    assert_eq!(order, ["m1", "m2"]);
    assert_eq!(
        back.tree()
            .at("/layers/a")
            .unwrap()
            .reference("source")
            .cloned(),
        d.tree()
            .at("/layers/a")
            .unwrap()
            .reference("source")
            .cloned(),
    );
    // history starts empty after an open
    assert_eq!(back.tree().history_len(), 0);
}

#[test]
fn a_file_that_isnt_rhizomes_is_refused_with_its_own_error() {
    let store = MemoryStore::default();
    store.put(
        "/mem/old.oblique",
        r#"{"scene": {"nodes": []}, "version": 3}"#,
    );
    assert!(Document::<Oblique>::open_in(
        catalogue(),
        store.clone(),
        "/mem/old.oblique",
        IdSource::sequential()
    )
    .is_err());
    assert!(Document::<Oblique>::open_in(
        catalogue(),
        store,
        "/mem/missing.oblique",
        IdSource::sequential()
    )
    .is_err());
}

#[test]
fn the_host_saves_opens_and_reports_unsaved_through_its_status() {
    let store = MemoryStore::default();
    let pom = pom(&store);
    let s = pom.status();
    assert!(!s.unsaved && s.undo.is_none() && s.path.is_none());
    assert_eq!(s.title, "Untitled");

    let (_, events) = pom
        .run("layer.add", &json!({"node": node("a", "pixel")}), None)
        .unwrap();
    assert!(!events.is_empty());
    let s = pom.status();
    assert!(s.unsaved);
    assert_eq!(s.undo.as_deref(), Some("New pixel"));
    assert_eq!(s.title, "Untitled — Edited");

    pom.save_as(std::path::Path::new("/mem/h.oblique")).unwrap();
    let saved = pom.tree();
    assert!(!pom.status().unsaved);
    assert_eq!(pom.status().title, "h.oblique");

    // a new document replaces it, no undo, not unsaved, and the generation moves
    let gen = pom.status().generation;
    pom.new_document().unwrap();
    let s = pom.status();
    assert!(!s.unsaved && s.undo.is_none());
    assert!(s.generation > gen);
    assert_eq!(pom.read(stack), Vec::<String>::new());

    let (issues, _) = pom.open(std::path::Path::new("/mem/h.oblique")).unwrap();
    assert!(issues.is_empty());
    assert_eq!(pom.tree(), saved);
    assert!(!pom.status().unsaved);
    assert!(pom.status().undo.is_none());
    assert_eq!(pom.read(stack), ["a"]);
}

#[test]
fn the_host_refuses_a_write_to_a_missing_layer_and_names_it() {
    let store = MemoryStore::default();
    let pom = pom(&store);
    pom.run("layer.add", &json!({"node": node("a", "pixel")}), None)
        .unwrap();
    let before = pom.tree();
    let e = pom
        .run(
            "values.set",
            &json!({"changes": [{"at": "/layers/zzz", "key": "opacity", "value": 0.5}]}),
            None,
        )
        .unwrap_err();
    assert!(e.to_string().contains("/layers/zzz"), "{e}");
    assert_eq!(pom.tree(), before);
}

// ---- layer.set_source ----

fn set_source(
    d: &mut Document<Oblique>,
    at: &str,
    path: &str,
    size: Option<[f64; 2]>,
) -> rhizome_pom::Result<Outcome> {
    let mut p = json!({"at": at, "sourcePath": path});
    if let Some(size) = size {
        p["sourceSize"] = json!(size);
    }
    d.run("layer.set_source", &p)
}

/// A pixel layer as the TypeScript replace-source tests build it: 512x512, moved, flipped
/// horizontally and turned.
fn placed(id: &str) -> Json {
    let mut n = node(id, "pixel");
    n["sourcePath"] = json!("/old/a.png");
    n["sourceSize"] = json!([512.0, 512.0]);
    n["transform2d"] =
        json!({"x": 100.0, "y": 40.0, "scaleX": -1.0, "scaleY": 1.0, "rotation": 0.3});
    n
}

fn placement(d: &Document<Oblique>, at: &str) -> Placement {
    let f = |key: &str| match value(d, at, key) {
        Some(Value::Vec2(v)) => v,
        other => panic!("{key}: {other:?}"),
    };
    let Some(Value::Float(rotation)) = value(d, at, "transform2d.rotation") else {
        panic!("no rotation");
    };
    Placement {
        x: f("transform2d.position")[0],
        y: f("transform2d.position")[1],
        scale_x: f("transform2d.scale")[0],
        scale_y: f("transform2d.scale")[1],
        rotation,
    }
}

fn source_of(d: &Document<Oblique>, at: &str) -> String {
    d.tree()
        .at(at)
        .unwrap()
        .reference("source")
        .and_then(|r| r.file.clone())
        .unwrap_or_default()
}

/// A modifier named `id` with a mask on `layer`: a vector layer `v` bound onto its mask slot.
fn with_masks(d: &mut Document<Oblique>, layer: Json, masks: &[(&str, Json)]) {
    let mut layer = layer;
    layer["modifiers"] = json!(masks
        .iter()
        .enumerate()
        .map(|(i, _)| json!({"id": format!("m{}", i + 1), "type": "blur", "enabled": true, "params": {}}))
        .collect::<Vec<_>>());
    add(d, layer.clone()).unwrap();
    add(d, node("v", "vector")).unwrap();
    let id = layer["id"].as_str().unwrap().to_string();
    for (i, (mask, attach)) in masks.iter().enumerate() {
        let space = if attach.is_null() {
            Json::Null
        } else {
            json!("node")
        };
        d.edit("Mask", |tx| {
            tx.bind(
                format!("/layers/{id}/m{}", i + 1).as_str(),
                On::slot("mask"),
                "/layers/v",
                [
                    ("refId", Value::Text(mask.to_string())),
                    ("featherPx", Value::Float(0.0)),
                    ("expand", Value::Float(0.0)),
                    ("invert", Value::Bool(false)),
                    ("space", Value::Shaped(space)),
                    ("attachTransform", Value::Shaped(attach.clone())),
                ],
            )
        })
        .unwrap();
    }
}

fn mask_value(d: &Document<Oblique>, modifier: &str, key: &str) -> Json {
    d.tree().at(modifier).unwrap().bindings()[0]
        .value(key)
        .unwrap()
        .to_json()
}

fn attach_of(d: &Document<Oblique>, modifier: &str) -> Placement {
    Placement::from_json(&mask_value(d, modifier, "attachTransform")).unwrap()
}

/// Node-local -> document space for a node with transform `t` and source `w`x`h`: scale and
/// rotate about the box centre (src/scene/maskRasterize.ts `localToDocMatrix`).
fn local_to_doc(t: Placement, w: f64, h: f64, px: f64, py: f64) -> (f64, f64) {
    let (cos, sin) = (t.rotation.cos(), t.rotation.sin());
    let (cx, cy) = (t.x + w / 2.0, t.y + h / 2.0);
    let (a, b, c, d) = (
        cos * t.scale_x,
        sin * t.scale_x,
        -sin * t.scale_y,
        cos * t.scale_y,
    );
    let e = cx - (a * (w / 2.0) + c * (h / 2.0));
    let f = cy - (b * (w / 2.0) + d * (h / 2.0));
    (a * px + c * py + e, b * px + d * py + f)
}

/// Its inverse (`docToLocalMatrix`).
fn doc_to_local(t: Placement, w: f64, h: f64, px: f64, py: f64) -> (f64, f64) {
    let (cos, sin) = (t.rotation.cos(), t.rotation.sin());
    let sx = if t.scale_x == 0.0 {
        0.0
    } else {
        1.0 / t.scale_x
    };
    let sy = if t.scale_y == 0.0 {
        0.0
    } else {
        1.0 / t.scale_y
    };
    let (cx, cy) = (t.x + w / 2.0, t.y + h / 2.0);
    let (a, c, b, d) = (cos * sx, sin * sx, -sin * sy, cos * sy);
    let e = w / 2.0 - (a * cx + c * cy);
    let f = h / 2.0 - (b * cx + d * cy);
    (a * px + c * py + e, b * px + d * py + f)
}

fn near(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "{a} vs {b}");
}

fn near_placement(a: Placement, b: Placement) {
    near(a.x, b.x);
    near(a.y, b.y);
    near(a.scale_x, b.scale_x);
    near(a.scale_y, b.scale_y);
    near(a.rotation, b.rotation);
}

fn identity() -> Placement {
    Placement {
        x: 0.0,
        y: 0.0,
        scale_x: 1.0,
        scale_y: 1.0,
        rotation: 0.0,
    }
}

#[test]
fn set_source_without_a_size_changes_only_the_path() {
    let mut d = doc();
    add(&mut d, placed("a")).unwrap();
    let before = placement(&d, "/layers/a");
    set_source(&mut d, "/layers/a", "/elsewhere.png", None).unwrap();
    assert_eq!(source_of(&d, "/layers/a"), "/elsewhere.png");
    assert_eq!(
        value(&d, "/layers/a", "sourceSize"),
        Some(Value::Vec2([512.0, 512.0]))
    );
    assert_eq!(placement(&d, "/layers/a"), before);
    // the same size is a path-only change too: nothing to fit
    set_source(&mut d, "/layers/a", "/same.png", Some([512.0, 512.0])).unwrap();
    assert_eq!(source_of(&d, "/layers/a"), "/same.png");
    assert_eq!(placement(&d, "/layers/a"), before);
}

#[test]
fn set_source_with_nothing_new_is_not_a_step() {
    let mut d = doc();
    add(&mut d, placed("a")).unwrap();
    let steps = d.tree().history_len();
    let before = d.tree().serialise();
    set_source(&mut d, "/layers/a", "/old/a.png", Some([512.0, 512.0])).unwrap();
    set_source(&mut d, "/layers/a", "/old/a.png", None).unwrap();
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

#[test]
fn set_source_is_one_undo_step_named_replace_image() {
    let mut d = doc();
    add(&mut d, placed("a")).unwrap();
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    set_source(&mut d, "/layers/a", "/new/b.png", Some([4000.0, 2000.0])).unwrap();
    assert_eq!(d.tree().history_len(), steps + 1);
    assert_eq!(d.tree().undo_label().as_deref(), Some("Replace Image"));
    d.undo().unwrap();
    assert_eq!(d.tree().serialise(), before);
    d.redo().unwrap();
    assert_eq!(source_of(&d, "/layers/a"), "/new/b.png");
}

#[test]
fn set_source_with_a_new_size_fits_the_old_footprint() {
    let mut d = doc();
    add(&mut d, placed("a")).unwrap();
    set_source(&mut d, "/layers/a", "/new/b.png", Some([4000.0, 2000.0])).unwrap();
    assert_eq!(source_of(&d, "/layers/a"), "/new/b.png");
    assert_eq!(
        value(&d, "/layers/a", "sourceSize"),
        Some(Value::Vec2([4000.0, 2000.0]))
    );
    let t = placement(&d, "/layers/a");
    // the box stays 512 wide and becomes 256 tall, centred where it was
    near(4000.0 * t.scale_x.abs(), 512.0);
    near(2000.0 * t.scale_y.abs(), 256.0);
    near(t.rotation, 0.3);
    assert!(t.scale_x < 0.0 && t.scale_y > 0.0, "flip survives: {t:?}");
    let old = Placement {
        x: 100.0,
        y: 40.0,
        scale_x: -1.0,
        scale_y: 1.0,
        rotation: 0.3,
    };
    let (bx, by) = local_to_doc(old, 512.0, 512.0, 256.0, 256.0);
    let (ax, ay) = local_to_doc(t, 4000.0, 2000.0, 2000.0, 1000.0);
    near(ax, bx);
    near(ay, by);
    // everything else about the layer is untouched
    assert_eq!(value(&d, "/layers/a", "opacity"), Some(Value::Float(1.0)));
    assert_eq!(
        value(&d, "/layers/a", "label"),
        Some(Value::Text("Layer".into()))
    );
}

#[test]
fn set_source_fits_a_layer_that_was_never_moved() {
    let mut d = doc();
    let mut n = node("a", "pixel");
    n["sourceSize"] = json!([100.0, 100.0]);
    add(&mut d, n).unwrap();
    set_source(&mut d, "/layers/a", "/new.png", Some([50.0, 25.0])).unwrap();
    let t = placement(&d, "/layers/a");
    near(t.scale_x, 2.0);
    near(t.scale_y, 2.0);
    let (cx, cy) = local_to_doc(t, 50.0, 25.0, 25.0, 12.5);
    near(cx, 50.0);
    near(cy, 50.0);
}

#[test]
fn fit_replaced_transform_cases() {
    // 512x512 -> 4000x2000 from {100, 40}
    let t = fit_replaced_transform(
        Placement {
            x: 100.0,
            y: 40.0,
            ..identity()
        },
        [512.0, 512.0],
        [4000.0, 2000.0],
    );
    near(4000.0 * t.scale_x.abs(), 512.0);
    near(2000.0 * t.scale_y.abs(), 256.0);

    // rotated, h-flipped, moved, non-uniformly scaled: centre, rotation and flip kept, uniform fit
    let old = Placement {
        x: -37.0,
        y: 211.0,
        scale_x: -1.5,
        scale_y: 0.75,
        rotation: 0.6,
    };
    let (w0, h0, w1, h1) = (640.0, 480.0, 300.0, 900.0);
    let next = fit_replaced_transform(old, [w0, h0], [w1, h1]);
    assert_eq!(next.rotation, old.rotation);
    assert!(next.scale_x < 0.0 && next.scale_y > 0.0);
    near(next.scale_x.abs(), next.scale_y.abs());
    let (c0, c1) = (
        local_to_doc(old, w0, h0, w0 / 2.0, h0 / 2.0),
        local_to_doc(next, w1, h1, w1 / 2.0, h1 / 2.0),
    );
    near(c1.0, c0.0);
    near(c1.1, c0.1);
    // the new image's corners, in the old node's local frame, sit inside the old box and touch it
    let corners: Vec<(f64, f64)> = [(0.0, 0.0), (w1, 0.0), (w1, h1), (0.0, h1)]
        .iter()
        .map(|(x, y)| {
            let (dx, dy) = local_to_doc(next, w1, h1, *x, *y);
            doc_to_local(old, w0, h0, dx, dy)
        })
        .collect();
    for (x, y) in &corners {
        assert!(
            *x > -1e-6 && *x < w0 + 1e-6 && *y > -1e-6 && *y < h0 + 1e-6,
            "{x},{y}"
        );
    }
    let (min_x, max_x) = corners.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| {
        (lo.min(p.0), hi.max(p.0))
    });
    let (min_y, max_y) = corners.iter().fold((f64::MAX, f64::MIN), |(lo, hi), p| {
        (lo.min(p.1), hi.max(p.1))
    });
    assert!((min_x < 1e-6 && max_x > w0 - 1e-6) || (min_y < 1e-6 && max_y > h0 - 1e-6));

    // a collapsed old footprint keeps its scale and still preserves the centre
    let collapsed = fit_replaced_transform(
        Placement {
            x: 10.0,
            y: 10.0,
            scale_x: 0.0,
            scale_y: 1.0,
            rotation: 0.0,
        },
        [100.0, 100.0],
        [40.0, 40.0],
    );
    assert_eq!((collapsed.scale_x, collapsed.scale_y), (0.0, 1.0));
    near(collapsed.x + 20.0, 10.0 + 50.0);
}

#[test]
fn set_source_refits_a_node_space_mask_and_leaves_a_document_space_one() {
    let mut d = doc();
    let attach = json!({"x": 100.0, "y": 40.0, "scaleX": -1.0, "scaleY": 1.0, "rotation": 0.3});
    with_masks(
        &mut d,
        placed("a"),
        &[("mask1", attach.clone()), ("mask2", Json::Null)],
    );
    let doc_space = mask_value(&d, "/layers/a/m2", "attachTransform");
    set_source(&mut d, "/layers/a", "/new/b.png", Some([1024.0, 256.0])).unwrap();
    let next = placement(&d, "/layers/a");
    // the same node frame at attach time as now: the refitted snapshot IS the new transform
    let refit = attach_of(&d, "/layers/a/m1");
    assert_ne!(refit, Placement::from_json(&attach).unwrap());
    near_placement(refit, next);
    // the rest of the binding survives, and the document-space mask is untouched
    assert_eq!(mask_value(&d, "/layers/a/m1", "refId"), json!("mask1"));
    assert_eq!(mask_value(&d, "/layers/a/m1", "space"), json!("node"));
    assert_eq!(mask_value(&d, "/layers/a/m2", "attachTransform"), doc_space);
    assert_eq!(mask_value(&d, "/layers/a/m2", "space"), Json::Null);
    assert_eq!(mask_value(&d, "/layers/a/m2", "refId"), json!("mask2"));
    // one step, and undo puts the snapshot back too
    assert_eq!(d.tree().undo_label().as_deref(), Some("Replace Image"));
    d.undo().unwrap();
    assert_eq!(
        Placement::from_json(&mask_value(&d, "/layers/a/m1", "attachTransform")).unwrap(),
        Placement::from_json(&attach).unwrap()
    );
}

#[test]
fn a_node_space_mask_covers_the_same_canvas_region_after_the_replace() {
    let mut d = doc();
    let mut n = node("a", "pixel");
    n["sourceSize"] = json!([800.0, 600.0]);
    n["transform2d"] =
        json!({"x": 50.0, "y": -20.0, "scaleX": -1.25, "scaleY": 0.8, "rotation": 0.4});
    let attach = json!({"x": 10.0, "y": 30.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.1});
    with_masks(&mut d, n, &[("mask1", attach.clone())]);
    let old = placement(&d, "/layers/a");
    let attach0 = Placement::from_json(&attach).unwrap();
    set_source(&mut d, "/layers/a", "/new.png", Some([1200.0, 500.0])).unwrap();
    let next = placement(&d, "/layers/a");
    let attach1 = attach_of(&d, "/layers/a/m1");
    for (px, py) in [(0.0, 0.0), (123.0, 456.0), (-50.0, 700.0), (900.0, 90.0)] {
        // a shape point (document space) goes into the mask buffer through the snapshot, then
        // out through the node's placement
        let (lx, ly) = doc_to_local(attach0, 800.0, 600.0, px, py);
        let (bx, by) = local_to_doc(old, 800.0, 600.0, lx, ly);
        let (lx, ly) = doc_to_local(attach1, 1200.0, 500.0, px, py);
        let (ax, ay) = local_to_doc(next, 1200.0, 500.0, lx, ly);
        near(ax, bx);
        near(ay, by);
    }
    // without the refit the mask would have moved
    let (lx, ly) = doc_to_local(attach0, 1200.0, 500.0, 100.0, 100.0);
    let (ax, ay) = local_to_doc(next, 1200.0, 500.0, lx, ly);
    let (lx, ly) = doc_to_local(attach0, 800.0, 600.0, 100.0, 100.0);
    let (bx, by) = local_to_doc(old, 800.0, 600.0, lx, ly);
    assert!((ax - bx).hypot(ay - by) > 1.0);
    // and the pure rule agrees with what the command wrote
    near_placement(
        refit_attach_transform(attach0, old, next, [800.0, 600.0], [1200.0, 500.0]),
        attach1,
    );
}

#[test]
fn set_source_on_a_locked_layer_is_refused_and_changes_nothing() {
    let mut d = doc();
    add(&mut d, placed("a")).unwrap();
    lock(&mut d, "/layers/a");
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    for size in [None, Some([4000.0, 2000.0])] {
        let e = set_source(&mut d, "/layers/a", "/new/b.png", size).unwrap_err();
        assert!(e.to_string().contains("is locked"), "{e}");
    }
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

#[test]
fn set_source_on_a_layer_that_is_not_a_pixel_layer_is_refused() {
    let mut d = doc();
    add(&mut d, node("v", "vector")).unwrap();
    add(&mut d, node("t", "text")).unwrap();
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    for at in ["/layers/v", "/layers/t"] {
        let e = set_source(&mut d, at, "/new/b.png", Some([10.0, 10.0])).unwrap_err();
        assert!(e.to_string().contains("isn't a pixel layer"), "{at}: {e}");
    }
    let e = set_source(&mut d, "/layers/zzz", "/new/b.png", None).unwrap_err();
    assert!(e.to_string().contains("/layers/zzz"), "{e}");
    assert_eq!(d.tree().serialise(), before);
    assert_eq!(d.tree().history_len(), steps);
}

// ---- POM built-ins that write the tree ----

#[test]
fn pom_builtins_that_write_the_tree_refuse_and_change_nothing() {
    let mut d = doc();
    add(&mut d, node("a", "pixel")).unwrap();
    lock(&mut d, "/layers/a");
    let before = d.tree().serialise();
    let steps = d.tree().history_len();
    let args = json!({
        "at": "/layers/a", "key": "transform2d.rotation", "value": 1.0,
        "parent": "/layers", "type": "pixel", "name": "b",
        "fragment": "", "label": "x", "to": "y", "text": "",
    });
    for id in [
        "value.set",
        "node.add",
        "edit.delete",
        "edit.duplicate",
        "edit.paste",
        "preset.apply",
        "preset.save",
        "preset.update",
        "preset.rename",
        "preset.delete",
        "preset.import",
    ] {
        let e = d.run(id, &args).unwrap_err();
        assert!(e.to_string().contains("isn't on rhizome yet"), "{id}: {e}");
        assert_eq!(d.tree().serialise(), before, "{id}");
        assert_eq!(d.tree().history_len(), steps, "{id}");
    }
    // undo, redo and the read-only built-ins still work
    assert!(d.is_enabled("edit.undo", &json!({})).unwrap());
    d.undo().unwrap();
    d.redo().unwrap();
    assert!(matches!(
        d.run("edit.copy", &json!({"at": "/layers/a"})).unwrap(),
        Outcome::Text(_)
    ));
}

// ---- param ranges with one end ----

#[test]
fn a_param_with_only_a_min_keeps_it_and_is_unbounded_above() {
    let ops = Op {
        name: "one_sided".into(),
        params: vec![
            param("floor", "float", json!(2.0), Some(1.0), None),
            param("ceiling", "float", json!(2.0), None, Some(10.0)),
            param("count", "int", json!(2), Some(1.0), None),
        ],
    };
    let mut d = Document::<Oblique>::new_in(
        Arc::new(Catalogue(vec![ops])),
        MemoryStore::default(),
        IdSource::sequential(),
    )
    .unwrap();
    let mut n = node("a", "pixel");
    let m =
        |params: Json| json!([{"id": "m", "type": "one_sided", "enabled": true, "params": params}]);
    n["modifiers"] = m(json!({"floor": 1e9, "ceiling": -1e9, "count": 5000}));
    add(&mut d, n).unwrap();
    assert_eq!(
        value(&d, "/layers/a/m", "params.floor"),
        Some(Value::Float(1e9))
    );
    assert_eq!(
        value(&d, "/layers/a/m", "params.ceiling"),
        Some(Value::Float(-1e9))
    );
    assert_eq!(
        value(&d, "/layers/a/m", "params.count"),
        Some(Value::Int(5000))
    );
    for bad in [json!({"floor": 0.5}), json!({"count": 0})] {
        let mut n = node("b", "pixel");
        n["modifiers"] = m(bad.clone());
        assert!(add(&mut d, n).is_err(), "{bad}");
    }
    let t = d
        .tree()
        .registry()
        .node_type("op.one_sided")
        .cloned()
        .unwrap();
    let floor = t.values().iter().find(|s| s.key == "params.floor").unwrap();
    assert!(floor.soft_max);
    assert_eq!(floor.range.map(|r| r.0), Some(1.0));
}

// ---- the document host as app-kit's History and Document (Epic 22, slice a) ----

/// What the mock app heard: (event name, payload JSON), in order.
type Heard = Arc<Mutex<Vec<(String, String)>>>;

/// A mock app, listening to everything the host and rhizome's transport emit.
fn app_hearing() -> (tauri::App<MockRuntime>, Heard) {
    let app = mock_app();
    let heard = Heard::default();
    for name in [
        "pom://commit",
        "pom://status",
        HISTORY_STEPPED,
        DOCUMENT_OPENED,
    ] {
        let heard = heard.clone();
        app.listen_any(name, move |e| {
            heard
                .lock()
                .unwrap()
                .push((name.to_string(), e.payload().to_string()));
        });
    }
    (app, heard)
}

fn names(heard: &Heard) -> Vec<String> {
    heard
        .lock()
        .unwrap()
        .iter()
        .map(|(n, _)| n.clone())
        .collect()
}

/// The payload of the one event called `name`.
fn payload(heard: &Heard, name: &str) -> Json {
    let all = heard.lock().unwrap();
    let mut it = all.iter().filter(|(n, _)| n == name);
    let (_, p) = it.next().unwrap_or_else(|| panic!("no {name} event"));
    assert!(it.next().is_none(), "more than one {name} event");
    serde_json::from_str(p).unwrap()
}

/// A host with its document, over a store.
fn ready(store: &MemoryStore) -> (DocumentHost, PomHost) {
    let host = DocumentHost::new();
    let transport = host.init(pom(store)).expect("first init");
    (host, transport)
}

fn has_layer(transport: &PomHost, id: &str) -> bool {
    let at = format!("/layers/{id}");
    transport
        .host()
        .view()
        .rows
        .iter()
        .any(|r| r.path.to_string() == at)
}

fn add_layer(transport: &PomHost, id: &str) {
    transport
        .host()
        .run("layer.add", &json!({ "node": node(id, "pixel") }), None)
        .unwrap();
}

#[test]
fn the_document_host_shares_its_pom_with_the_transports_host() {
    let (document, transport) = ready(&MemoryStore::default());
    let told = Arc::new(AtomicU32::new(0));
    let seen = told.clone();
    document.on_change(move || {
        seen.fetch_add(1, Ordering::SeqCst);
    });

    // a command through the transport's host (what `pom_run` calls) ...
    add_layer(&transport, "a");

    // ... is in the document the host reads, and the hook heard of it
    assert!(has_layer(&transport, "a"));
    assert_eq!(told.load(Ordering::SeqCst), 1);
}

#[test]
fn before_init_the_document_is_untitled_and_saved_with_nothing_to_undo() {
    let (app, heard) = app_hearing();
    let host = DocumentHost::new();
    assert!(!host.is_ready());
    assert_eq!(host.untitled_number(), 1);
    assert_eq!(host.path(), None);
    assert!(!host.is_unsaved());
    assert_eq!(
        (host.undo_label(), host.redo_label()),
        (None, None),
        "nothing to undo or redo"
    );
    assert!(host.undo_labels().is_empty() && host.redo_labels().is_empty());
    let state = DocumentState::of(&host);
    assert_eq!(
        (state.name.as_str(), state.title.as_str()),
        ("Untitled-1", "Untitled-1")
    );
    let titles = edit_titles(&HistoryState::of(&host), false);
    assert_eq!((titles.undo.as_str(), titles.undo_enabled), ("Undo", false));
    assert_eq!((titles.redo.as_str(), titles.redo_enabled), ("Redo", false));

    // undo and redo have nothing to do, and say nothing
    host.undo(app.handle()).unwrap();
    host.redo(app.handle()).unwrap();
    // save and new say the document isn't ready, and change nothing
    assert_eq!(
        host.save(app.handle(), Path::new("/a.oblique")),
        Err(NOT_READY.into())
    );
    assert_eq!(host.new_document(app.handle(), 2), Err(NOT_READY.into()));
    assert_eq!(host.untitled_number(), 1);
    assert!(names(&heard).is_empty());
}

#[test]
fn an_open_before_init_is_held_and_applied_after_it() {
    let store = MemoryStore::default();
    {
        // a saved document to open: one layer, written through a Pom of its own
        let (_, transport) = ready(&store);
        add_layer(&transport, "kept");
        transport
            .host()
            .save_as(Path::new("/held.oblique"))
            .unwrap();
    }
    let (app, heard) = app_hearing();
    let host = DocumentHost::new();

    // before the catalogue: held (the newest request wins), nothing opens, nothing is heard
    host.open(app.handle(), Path::new("/older.oblique"))
        .unwrap();
    host.open(app.handle(), Path::new("/held.oblique")).unwrap();
    assert!(!host.is_ready() && host.path().is_none());
    assert!(names(&heard).is_empty());

    // init alone does not apply it (the transport isn't managed yet) ...
    let transport = host.init(pom(&store)).expect("first init");
    assert!(host.is_ready() && host.path().is_none());
    assert!(names(&heard).is_empty());

    // ... apply_held does, and emits as any open does
    assert_eq!(host.apply_held(app.handle()), Ok(true));
    assert_eq!(host.path(), Some(PathBuf::from("/held.oblique")));
    assert!(!host.is_unsaved());
    assert!(has_layer(&transport, "kept"));
    let heard_names = names(&heard);
    assert!(heard_names.contains(&"pom://status".to_string()));
    assert_eq!(
        heard_names.last().map(String::as_str),
        Some(DOCUMENT_OPENED),
        "document-opened comes after the transport's events"
    );
    assert_eq!(payload(&heard, DOCUMENT_OPENED), json!({"issues": []}));

    // it was held once
    assert_eq!(host.apply_held(app.handle()), Ok(false));
}

#[test]
fn a_held_open_that_fails_leaves_an_untitled_document() {
    let (app, heard) = app_hearing();
    let host = DocumentHost::new();
    host.open(app.handle(), Path::new("/missing.oblique"))
        .unwrap();
    host.init(pom(&MemoryStore::default())).unwrap();
    assert!(host.apply_held(app.handle()).is_err());
    assert!(host.is_ready());
    assert_eq!(host.path(), None);
    assert!(!names(&heard).contains(&DOCUMENT_OPENED.to_string()));
    // and it is not held again
    assert_eq!(host.apply_held(app.handle()), Ok(false));
}

#[test]
fn init_fills_the_host_once() {
    let host = DocumentHost::new();
    assert!(host.init(pom(&MemoryStore::default())).is_some());
    assert!(host.init(pom(&MemoryStore::default())).is_none());
}

#[test]
fn an_open_after_init_opens_at_once() {
    let store = MemoryStore::default();
    let (app, heard) = app_hearing();
    let (host, transport) = ready(&store);
    add_layer(&transport, "a");
    host.save(app.handle(), Path::new("/doc.oblique")).unwrap();
    add_layer(&transport, "b");
    assert!(host.is_unsaved());
    heard.lock().unwrap().clear();

    host.open(app.handle(), Path::new("/doc.oblique")).unwrap();
    assert_eq!(host.path(), Some(PathBuf::from("/doc.oblique")));
    assert!(!host.is_unsaved(), "a fresh open is saved");
    assert!(host.undo_labels().is_empty(), "with an empty history");
    assert_eq!(payload(&heard, DOCUMENT_OPENED), json!({"issues": []}));
}

#[test]
fn undo_and_redo_titles_come_from_the_status() {
    let (app, heard) = app_hearing();
    let (host, transport) = ready(&MemoryStore::default());
    add_layer(&transport, "a");
    let step = transport.host().status().undo.expect("a step to undo");

    // app-kit's menu titles, read through History from POM's status
    assert_eq!(host.undo_label().as_deref(), Some(step.as_str()));
    assert_eq!(host.undo_labels(), vec![step.clone()]);
    let titles = edit_titles(&HistoryState::of(&host), false);
    assert_eq!(titles.undo, format!("Undo {step}"));
    assert!(titles.undo_enabled);
    assert_eq!((titles.redo.as_str(), titles.redo_enabled), ("Redo", false));

    heard.lock().unwrap().clear();
    host.undo(app.handle()).unwrap();
    assert!(!has_layer(&transport, "a"));
    assert_eq!(host.undo_label(), None);
    assert_eq!(host.redo_label().as_deref(), Some(step.as_str()));
    assert_eq!(host.redo_labels(), vec![step.clone()]);
    let titles = edit_titles(&HistoryState::of(&host), false);
    assert_eq!(titles.redo, format!("Redo {step}"));
    assert!(titles.redo_enabled && !titles.undo_enabled);

    // rhizome's commit reaches the webview's mirror, then history-stepped, with the bare label
    let heard_names = names(&heard);
    assert_eq!(
        heard_names.last().map(String::as_str),
        Some(HISTORY_STEPPED),
        "{heard_names:?}"
    );
    assert!(heard_names.contains(&"pom://commit".to_string()));
    assert_eq!(
        payload(&heard, HISTORY_STEPPED),
        json!({"undid": true, "label": step})
    );

    heard.lock().unwrap().clear();
    host.redo(app.handle()).unwrap();
    assert!(has_layer(&transport, "a"));
    assert_eq!(host.redo_label(), None);
    assert_eq!(
        payload(&heard, HISTORY_STEPPED),
        json!({"undid": false, "label": step})
    );
}

#[test]
fn undo_with_nothing_to_undo_is_quiet() {
    let (app, heard) = app_hearing();
    let (host, _transport) = ready(&MemoryStore::default());
    host.undo(app.handle()).unwrap();
    host.redo(app.handle()).unwrap();
    assert!(!names(&heard).contains(&HISTORY_STEPPED.to_string()));
}

#[test]
fn unsaved_is_derived_not_flagged() {
    let (app, _heard) = app_hearing();
    let (host, transport) = ready(&MemoryStore::default());
    assert!(!host.is_unsaved());

    add_layer(&transport, "a");
    assert!(host.is_unsaved());
    host.save(app.handle(), Path::new("/doc.oblique")).unwrap();
    assert!(!host.is_unsaved());
    assert_eq!(host.path(), Some(PathBuf::from("/doc.oblique")));

    add_layer(&transport, "b");
    assert!(host.is_unsaved());
    // back to what is on disk: saved again, without a save
    host.undo(app.handle()).unwrap();
    assert!(!host.is_unsaved());
    host.redo(app.handle()).unwrap();
    assert!(host.is_unsaved());
}

#[test]
fn new_replaces_the_document_and_takes_app_kits_number() {
    let (app, heard) = app_hearing();
    let (host, transport) = ready(&MemoryStore::default());
    add_layer(&transport, "a");
    host.save(app.handle(), Path::new("/doc.oblique")).unwrap();
    heard.lock().unwrap().clear();

    host.new_document(app.handle(), 2).unwrap();
    assert_eq!(host.untitled_number(), 2);
    assert_eq!(host.path(), None);
    assert!(!host.is_unsaved());
    assert!(host.undo_labels().is_empty());
    let state = DocumentState::of(&host);
    assert_eq!(state.name, "Untitled-2");
    assert_eq!(payload(&heard, DOCUMENT_OPENED), json!({"issues": []}));
}

#[test]
fn the_change_hook_may_be_scheduled_while_the_document_is_locked() {
    // `refresh_on_change` sets the hook; a command runs it under the Pom's lock. It must only
    // queue the refresh, so the command returns (a refresh run inline would lock the Pom
    // again from inside its own lock and hang here).
    let app = mock_app();
    let (host, transport) = ready(&MemoryStore::default());
    host.refresh_on_change(app.handle().clone());
    for id in ["a", "b", "c"] {
        add_layer(&transport, id);
    }
    assert!(host.is_unsaved());
}

// ---- real projects (opt-in) ----

/// The sidecar's op catalogue, as `list_ops` reports it: the JSON file named by
/// `OBLIQUE_OPS` if set, else read from the sidecar's own `OPS` through `uv`. The object model
/// needs it to know the `op.*` kinds a real project holds; an empty one would let those load as
/// unknown nodes and round-trip without proving anything.
fn real_catalogue() -> Arc<Catalogue> {
    let text = match std::env::var("OBLIQUE_OPS") {
        Ok(path) => std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}")),
        Err(_) => {
            let sidecar = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar");
            let out = std::process::Command::new("uv")
                .arg("run")
                .arg("--project")
                .arg(&sidecar)
                .args(["python", "-I", "-c"])
                .arg(
                    "import json, sys\nsys.path.insert(0, sys.argv[1])\nfrom ops import OPS\n\
                     print(json.dumps([o.to_dict() for o in OPS.values()]))",
                )
                .arg(&sidecar)
                .output()
                .expect("uv: set OBLIQUE_OPS to a list_ops JSON file instead");
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8(out.stdout).unwrap()
        }
    };
    let ops: Vec<Op> = serde_json::from_str(&text).expect("the op catalogue as list_ops JSON");
    assert!(!ops.is_empty(), "an empty op catalogue proves nothing");
    Arc::new(Catalogue(ops))
}

/// The first place two JSON values differ, as a path and both sides.
fn first_difference(a: &Json, b: &Json, at: &str) -> String {
    match (a, b) {
        (Json::Object(x), Json::Object(y)) => {
            for k in x.keys().chain(y.keys()) {
                if x.get(k) != y.get(k) {
                    return match (x.get(k), y.get(k)) {
                        (Some(p), Some(q)) => first_difference(p, q, &format!("{at}.{k}")),
                        (p, q) => format!("{at}.{k}: {p:?} vs {q:?}"),
                    };
                }
            }
            format!("{at}: objects differ")
        }
        (Json::Array(x), Json::Array(y)) if x.len() == y.len() => {
            match x.iter().zip(y).position(|(p, q)| p != q) {
                Some(i) => first_difference(&x[i], &y[i], &format!("{at}[{i}]")),
                None => format!("{at}: lists differ"),
            }
        }
        (Json::Array(x), Json::Array(y)) => format!("{at}: {} vs {} items", x.len(), y.len()),
        _ => format!("{at}: {a} vs {b}"),
    }
}

/// Opens `path` through POM's file store (reading only), saves it to memory, reopens that, and
/// returns the first difference between the two trees. Load issues on either side count.
fn round_trip(cx: &Arc<Catalogue>, path: &str) -> Result<usize, String> {
    let (first, report) = Document::<Oblique>::open_in(cx.clone(), FileStore, path, IdSource::Ulid)
        .map_err(|e| e.to_string())?;
    if !report.issues.is_empty() {
        return Err(format!("open: {:?}", report.issues));
    }
    // what `save_as` would write, kept in memory so the file is never touched
    let memory = MemoryStore::default();
    memory.put("/saved.oblique", &first.tree().serialise());
    let (again, report) =
        Document::<Oblique>::open_in(cx.clone(), memory, "/saved.oblique", IdSource::Ulid)
            .map_err(|e| format!("reopen: {e}"))?;
    if !report.issues.is_empty() {
        return Err(format!("reopen: {:?}", report.issues));
    }
    let rows = |d: &Document<Oblique>| serde_json::to_value(d.tree().rows()).unwrap();
    let (want, got) = (rows(&first), rows(&again));
    if want != got {
        return Err(first_difference(&want, &got, ""));
    }
    if first.tree().serialise() != again.tree().serialise() {
        return Err("the saved text differs after a reopen".into());
    }
    Ok(first.tree().rows().len())
}

/// Every real project opens, saves and reopens to the same tree. Opt-in:
/// `OBLIQUE_FILES="a.oblique:b.oblique" cargo test --lib real_projects -- --ignored --nocapture`
/// (`just coverage "<files>"`). Reads the files and never writes them.
#[test]
#[ignore = "needs OBLIQUE_FILES (colon-separated .oblique files)"]
fn real_projects() {
    let files = std::env::var("OBLIQUE_FILES").expect("OBLIQUE_FILES");
    let files: Vec<&str> = files.split(':').filter(|f| !f.is_empty()).collect();
    assert!(!files.is_empty(), "OBLIQUE_FILES names no files");
    let cx = real_catalogue();
    let mut failed = vec![];
    for f in &files {
        match round_trip(&cx, f) {
            Ok(rows) => eprintln!("ok    {f} ({rows} nodes)"),
            Err(e) => {
                eprintln!("FAIL  {f}: {e}");
                failed.push(f.to_string());
            }
        }
    }
    assert!(failed.is_empty(), "{failed:?}");
}

#[test]
fn the_round_trip_check_reports_the_first_difference() {
    assert_eq!(
        first_difference(
            &json!({"a": [1, {"b": 2}]}),
            &json!({"a": [1, {"b": 3}]}),
            ""
        ),
        ".a[1].b: 2 vs 3"
    );
    assert_eq!(
        first_difference(&json!({"a": 1}), &json!({"a": 1, "c": 2}), ""),
        ".c: None vs Some(Number(2))"
    );
    assert_eq!(
        first_difference(&json!([1]), &json!([1, 2]), ""),
        ": 1 vs 2 items"
    );
}
