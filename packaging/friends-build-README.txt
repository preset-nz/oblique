{{PRODUCT_NAME}} — free, pre-release build. Apple Silicon (M-series) Macs only.

It isn't signed yet, so macOS will say "{{PRODUCT_NAME}}.app is damaged and can't be opened" — it isn't actually damaged, macOS just doesn't recognise the developer. Fix it once: open Terminal (Cmd+Space, type Terminal), type xattr -cr followed by a space, then drag {{PRODUCT_NAME}}.app into the Terminal window and press Return. Double-click the app again — it'll open normally from then on.

Found a bug or something looks wrong? Tell me on Bluesky, @preset.nz (bsky.app/profile/preset.nz) — a screenshot helps.
