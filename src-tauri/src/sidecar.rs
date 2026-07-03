//! Supervises the Python ops sidecar as a long-lived child process.
//!
//! Rust is a **dumb relay**: it never parses the framed-stdio protocol.
//! `sidecar_send` writes raw bytes verbatim to the child's stdin; the
//! stdout reader thread emits whatever byte chunks it reads as
//! `sidecar-frame` events. Frame reassembly (the length-prefixed header
//! format) happens entirely in the TypeScript client — Rust just moves
//! bytes.
//!
//! See guidance/projects/oblique/design/architecture.md
//! Section "Python sidecar protocol" for the frame format Rust
//! deliberately does not look inside.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const CRASH_WINDOW: Duration = Duration::from_secs(30);
const CRASH_GIVEUP_COUNT: usize = 5;
const RESPAWN_DELAY: Duration = Duration::from_secs(1);
const STDOUT_CHUNK_SIZE: usize = 64 * 1024;

/// Shared handle to the running child's stdin. `None` while the sidecar is down.
#[derive(Default)]
pub struct SidecarState {
    stdin: Mutex<Option<ChildStdin>>,
}

#[derive(Clone, Serialize)]
struct SidecarStatus {
    up: bool,
    error: Option<String>,
}

/// Resolve the sidecar project directory.
///
/// Dev mode: `OBLIQUE_SIDECAR_DIR` env override, else `<repo>/sidecar`
/// derived from this crate's manifest dir (src-tauri sits next to
/// sidecar/ in the repo root).
///
/// TODO(release bundling): once the sidecar ships as a bundled Tauri
/// sidecar binary (PyInstaller or uv-managed install), this needs a
/// release-mode branch that resolves the bundled resource path instead.
/// Deferred to end of Milestone A per the story's open questions.
fn sidecar_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("OBLIQUE_SIDECAR_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent directory")
        .join("sidecar")
}

fn spawn_child(dir: &PathBuf) -> std::io::Result<Child> {
    Command::new("uv")
        .args(["run", "python", "main.py"])
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

fn emit_status(app: &AppHandle, up: bool, error: Option<String>) {
    let _ = app.emit("sidecar-status", SidecarStatus { up, error });
}

/// Spawn the sidecar and supervise it for the lifetime of the app.
/// Runs its own thread; call once from `setup`.
pub fn start(app: AppHandle) {
    thread::spawn(move || supervise(app));
}

fn supervise(app: AppHandle) {
    let dir = sidecar_dir();
    let mut crash_times: Vec<Instant> = Vec::new();

    loop {
        let mut child = match spawn_child(&dir) {
            Ok(child) => child,
            Err(err) => {
                let msg = format!("failed to spawn sidecar: {err}");
                emit_status(&app, false, Some(msg));
                if record_crash_and_check_giveup(&mut crash_times) {
                    return;
                }
                thread::sleep(RESPAWN_DELAY);
                continue;
            }
        };

        let stdin = child.stdin.take().expect("child spawned with piped stdin");
        let stdout = child.stdout.take().expect("child spawned with piped stdout");
        let stderr = child.stderr.take().expect("child spawned with piped stderr");

        if let Some(state) = app.try_state::<SidecarState>() {
            *state.stdin.lock().expect("sidecar stdin mutex poisoned") = Some(stdin);
        }

        let last_stderr = Arc::new(Mutex::new(String::new()));
        spawn_stderr_reader(stderr, Arc::clone(&last_stderr));
        spawn_stdout_reader(app.clone(), stdout);

        emit_status(&app, true, None);

        // Blocks until the child exits (killed externally, crashed, or quit).
        let exit_status = child.wait();

        if let Some(state) = app.try_state::<SidecarState>() {
            *state.stdin.lock().expect("sidecar stdin mutex poisoned") = None;
        }

        let error = match exit_status {
            Ok(status) => Some(format!("sidecar exited: {status}")),
            Err(err) => Some(format!("sidecar wait() failed: {err}")),
        };
        let stderr_tail = last_stderr.lock().expect("last_stderr mutex poisoned").clone();
        let combined = if stderr_tail.is_empty() {
            error
        } else {
            Some(format!("{}\n{}", error.unwrap_or_default(), stderr_tail))
        };

        if record_crash_and_check_giveup(&mut crash_times) {
            emit_status(&app, false, combined);
            return;
        }

        emit_status(&app, false, combined);
        thread::sleep(RESPAWN_DELAY);
    }
}

/// Records a crash and returns true if the supervisor should give up
/// (5+ crashes within the trailing 30 s window).
fn record_crash_and_check_giveup(crash_times: &mut Vec<Instant>) -> bool {
    let now = Instant::now();
    crash_times.retain(|t| now.duration_since(*t) <= CRASH_WINDOW);
    crash_times.push(now);
    crash_times.len() >= CRASH_GIVEUP_COUNT
}

fn spawn_stdout_reader(app: AppHandle, mut stdout: impl Read + Send + 'static) {
    thread::spawn(move || {
        let mut buf = vec![0u8; STDOUT_CHUNK_SIZE];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break, // EOF: child closed stdout
                Ok(n) => {
                    let _ = app.emit("sidecar-frame", buf[..n].to_vec());
                }
                Err(_) => break,
            }
        }
    });
}

fn spawn_stderr_reader(stderr: impl Read + Send + 'static, last_line: Arc<Mutex<String>>) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    // Python tracebacks surface here — never swallow them.
                    eprintln!("[sidecar] {line}");
                    *last_line.lock().expect("last_stderr mutex poisoned") = line;
                }
                Err(_) => break,
            }
        }
    });
}

#[tauri::command]
pub fn sidecar_send(state: tauri::State<SidecarState>, bytes: Vec<u8>) -> Result<(), String> {
    let mut guard = state.stdin.lock().map_err(|_| "sidecar stdin mutex poisoned".to_string())?;
    match guard.as_mut() {
        Some(stdin) => stdin
            .write_all(&bytes)
            .and_then(|_| stdin.flush())
            .map_err(|err| format!("failed to write to sidecar stdin: {err}")),
        None => Err("sidecar is not running".to_string()),
    }
}
