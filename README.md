# zpic Image Upload — Obsidian plugin

> Paste or drop an image into your note and let [zpic][zpic] upload it to
> the host of your choice (GitHub, S3, OSS, local, ...).

The plugin is a thin client. All upload logic — including uploader
selection, retry, history, and diagnostics — lives in the `zpic` server.
The plugin only speaks the PicGo-compatible HTTP contract documented in
[`specs/api-specification.md`][api-spec].

## Features

- Auto-upload on **paste** (clipboard images, screenshots).
- Auto-upload on **drag-and-drop** (image files from the OS).
- Manual upload via command palette or ribbon icon.
- Settings tab to configure the server URL, behaviour, and timeout.
- Per-note opt-out via YAML frontmatter (`zpic-upload: false`).
- Health-check button in the settings tab.
- Works on **desktop** (macOS, Windows, Linux) and **mobile**
  (iOS, Android).

## Requirements

- [zpic][zpic] v0.1.0 or newer, installed and on your `PATH`.
- A configured uploader (`zpic config init` + `zpic set uploader ...`).
- The zpic server reachable from Obsidian — see the [server setup
  guide][zpic-server] in the main repo.

## Installation

### From a GitHub release (recommended)

1. Download the latest `zpic-image-upload-X.Y.Z.zip` from
   [GitHub Releases](https://github.com/xtcel/zpic/releases).
2. Extract the zip — it contains `main.js`, `manifest.json`, and
   `styles.css`.
3. Copy those files to:
   ```
   <YourVault>/.obsidian/plugins/zpic/
   ```
4. Restart Obsidian, then enable the plugin under
   **Settings → Community plugins → Zpic Image Upload**.

### Manual / development install

```bash
git clone https://github.com/xtcel/zpic
cd zpic/extensions/obsidian
npm install
npm run build
# Then symlink the directory into your vault:
ln -s "$(pwd)" "<YourVault>/.obsidian/plugins/zpic"
```

Enable the plugin in Obsidian (you may need to toggle "Community
plugins → Restricted mode" off the first time).

## Configuration

Open **Settings → Community plugins → Zpic Image Upload** to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| Server URL | `http://127.0.0.1:36677` | zpic server base URL. |
| Request timeout | `30000` ms | Max time to wait for a single upload. |
| Upload on paste | ✅ | Auto-upload clipboard images. |
| Upload on drop | ✅ | Auto-upload dropped image files. |
| Image description | `origin` | Use the original filename as alt text, or empty. |
| Delete local after upload | ❌ | Reserved for future clipboard-only delete. |

Click **Check server** to confirm the server is reachable and to see
which uploader is active.

## Usage

### Paste an image

1. Copy an image to your clipboard (screenshot, browser, etc.).
2. Press `Cmd/Ctrl + V` in the editor.
3. A `![Uploading …]()` row is inserted and immediately replaced by
   the uploaded URL once zpic returns.

### Drag and drop

1. Drag an image file from Finder / Explorer / Files.
2. Drop it into the editor.
3. The plugin uploads it and inserts the resulting markdown.

Hold `Ctrl` / `Cmd` while dropping to skip the upload and use Obsidian's
default "attach file" behaviour.

### Per-note opt-out

Add the following to a note's YAML frontmatter to disable auto-upload
for that note:

```yaml
---
zpic-upload: false
---
```

### Commands

- **Upload image from clipboard** — same as pressing the ribbon icon.
- **Upload current image attachment** — re-uploads the image referenced
  by the current selection (useful for migrating existing notes).

## Architecture

```
┌────────────────────────────────────────────────┐
│         Obsidian plugin (this repo)             │
│  • editor-paste / editor-drop listeners        │
│  • Obsidian requestUrl HTTP client              │
│  • placeholder → final URL replacement         │
└──────────────────┬─────────────────────────────┘
                   │ HTTP (JSON or multipart)
                   ▼
┌────────────────────────────────────────────────┐
│        zpic HTTP server (Rust / axum)          │
│  POST /upload  · GET /health  · GET /config    │
└──────────────────┬─────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────┐
│          zpic uploaders (Rust)                 │
│  github · s3 · oss · local · ...                │
└────────────────────────────────────────────────┘
```

The server speaks the same wire format as PicGo, so any PicGo client
that targets `127.0.0.1:36677` works against zpic unchanged.

## Development

```bash
# Install dependencies
npm install

# Type-check only
npm run typecheck

# Build once
npm run build

# Rebuild on file changes
npm run dev
```

The build emits `main.js` (and an inline source map in dev) at the
project root — the layout Obsidian expects inside a plugin folder.

### Project layout

```
extensions/obsidian/
├── src/
│   ├── main.ts        # Plugin entry point, event wiring, upload pipeline
│   ├── settings.ts    # Settings tab UI and validation
│   ├── uploader.ts    # HTTP client (requestUrl-based, mobile-friendly)
│   ├── utils.ts       # Pure helpers (image detection, placeholder ids)
│   └── types.ts       # TypeScript types + defaults
├── manifest.json
├── package.json
├── rollup.config.js
├── styles.css
├── tsconfig.json
├── LICENSE
└── README.md
```

## Troubleshooting

### "Cannot connect to zpic server"

The plugin couldn't reach the server URL. Check:

1. The server is running: `zpic server status` (or `zpic server start`).
2. The **Server URL** in the plugin settings matches the bound address.
3. On mobile, use the computer's LAN IP (e.g. `http://192.168.1.10:36677`)
   and ensure the firewall allows inbound traffic on that port.

### Upload times out

Increase the **Request timeout** in the settings tab. The default
30 seconds is enough for most images, but very large files (10 MB+)
on slow links may need more.

### "Upload failed: authentication error"

The plugin only forwards bytes — the actual uploader credentials live
in zpic. Run `zpic config show` to verify and `zpic set uploader ...`
to update them.

### Mobile uploads fail

The mobile Obsidian build has stricter CORS handling. Make sure the
server is bound to a reachable address (not just `127.0.0.1`) and that
your phone is on the same network.

## Releasing

1. Bump `version` in `package.json` and `manifest.json` (keep them in
   sync).
2. Run `npm run build` and verify `main.js` is regenerated.
3. Tag the release: `git tag obsidian-v0.1.0`.
4. Create a GitHub release attaching `main.js`, `manifest.json`, and
   `styles.css` zipped as `zpic-image-upload-<version>.zip`.

## License

[MIT](./LICENSE)

[zpic]: https://github.com/xtcel/zpic
[api-spec]: ../../openspec/changes/add-http-server-for-obsidian/specs/api-specification.md
[zpic-server]: ../../docs/http-server.md
