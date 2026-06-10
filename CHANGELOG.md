# Changelog

All notable changes to the **Zpic Uploader** Obsidian plugin are
documented here. The format follows [Keep a Changelog][keep-a-changelog]
and the project adheres to [Semantic Versioning][semver].

[keep-a-changelog]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

## [0.1.2] — 2026-06-10

### Fixed

- **Mobile / clipboard uploads still failed with `Server returned HTTP 400`**
  after the 0.1.1 release. The plugin hand-builds the multipart envelope
  as a `Uint8Array` (`buildMultipartBody` in `src/uploader.ts`), but
  `RequestUrlParam.body` is typed as `string | ArrayBuffer`. Casting the
  `Uint8Array` to `string` caused Obsidian's `requestUrl` to UTF-8 decode
  the binary payload, replacing every invalid byte sequence (i.e. almost
  all image bytes after the ASCII headers) with `U+FFFD`. The server
  then saw a malformed envelope and replied with
  `multipart error: incomplete multipart stream`.

  The plugin now slices the underlying `ArrayBuffer` and ships it as
  binary, so every byte survives the round-trip. JSON path-list uploads
  (desktop, file-on-disk) were not affected and continue to work
  unchanged.

### Changed

- **Renamed the plugin to Zpic Uploader.** The plugin identifier
  (manifest `id`) changed from `zpic-image-upload` to `zpic uploader`,
  and the display name from `Zpic Image Upload` to `Zpic Uploader`.
  This is a one-time rename so the plugin is recognisably the official
  uploader client for the zpic ecosystem. **Existing installs must be
  re-added from BRAT**, which will create a new plugin folder named
  `zpic uploader`; the old `zpic-image-upload` folder can be removed
  manually.

## [0.1.1] — 2026-06-09

### Fixed

- **Drag-and-drop uploads were rejected with `unsupported content type`**
  on Obsidian desktop and mobile. Obsidian's `requestUrl` does not
  reliably set the `Content-Type: multipart/form-data; boundary=…`
  header when handed a `FormData` body, so the server had no way to
  tell which parser to dispatch to.

  The plugin now serialises the multipart envelope by hand
  (`buildMultipartBody` in `src/uploader.ts`) and sets the
  `Content-Type` header explicitly. As a defence-in-depth measure,
  the Rust server has also been taught to **sniff the body** when the
  `Content-Type` header is missing and dispatch to multipart or JSON
  based on the leading bytes — see the server `CHANGELOG.md` for the
  matching change.

## [0.1.0] — 2026-06-09

### Added

- Initial release.
- Auto-upload on **paste** from the clipboard.
- Auto-upload on **drag-and-drop** of image files.
- Manual upload via the ribbon icon and the command palette
  (`Upload image from clipboard`, `Upload current image attachment`).
- Settings tab with **Server URL**, **Request timeout**,
  **Upload on paste**, **Upload on drop**, **Image description**,
  and **Delete local after upload** controls.
- **Check server** button in the settings tab — verifies reachability
  and reports the active uploader.
- Per-note opt-out via `zpic-upload: false` frontmatter.
- Server URL validation in the settings tab.
- Multipart upload path used by mobile Obsidian and clipboard blobs.
- JSON path-list upload path used by desktop Obsidian with native
  files.
- Health-check + config-probe helpers used by the settings tab and
  before every upload.
- PicGo-compatible request / response model matching the spec in
  `openspec/changes/add-http-server-for-obsidian/specs/api-specification.md`.
- `styles.css` with the status block styling for the settings tab.
