"use strict";

var obsidian = require("obsidian");

/**
 * Utility helpers shared across the plugin.
 *
 * Keep this module dependency-free (other than the type-only `obsidian`
 * import) so it can be exercised from tests in the future.
 */
/** Lower-case image extensions accepted by the plugin and zpic server. */
const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".svg",
  ".avif",
];
/**
 * Check whether a file (browser `File` or Obsidian `TFile`) is an image
 * by looking at its extension. The MIME type on `File` objects is not
 * reliable across mobile platforms, so we fall back to the extension.
 */
function isImageFile(file) {
  if (!file || !file.name) return false;
  const fileName = file.name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}
/**
 * Generate a short, unique placeholder id used inside the inserted
 * `![Uploading...{id}]()` markdown. Cryptographic strength is not needed
 * here; we just want to avoid clashes between concurrent uploads.
 */
function generatePlaceholderId() {
  return Math.random().toString(36).slice(2, 9);
}
/**
 * Build the markdown image tag for an uploaded URL. The `desc` mode
 * controls whether the original filename is preserved as alt text.
 */
function formatImageMarkdown(url, name, desc) {
  const altText = desc === "origin" ? name : "";
  return `![${altText}](${url})`;
}
/**
 * Build the placeholder markdown inserted while an upload is in flight.
 * The id is embedded so the post-upload replacement can locate the row.
 */
function getPlaceholderText(id) {
  return `![Uploading ${id}…]()`;
}
/**
 * Normalize a user-provided server URL: trim whitespace and strip a
 * trailing slash so we can safely concatenate `/upload`, `/health`, etc.
 */
function normalizeServerUrl(url) {
  return url.trim().replace(/\/+$/, "");
}
/**
 * Heuristic MIME guess from a filename. Used as a fallback when the
 * platform-provided `File.type` is empty (common on iOS).
 */
function guessMimeType(fileName) {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "tif":
    case "tiff":
      return "image/tiff";
    default:
      return "application/octet-stream";
  }
}

/**
 * HTTP client for the zpic server.
 *
 * Communicates with the PicGo-compatible API documented in
 * `openspec/changes/add-http-server-for-obsidian/specs/api-specification.md`.
 *
 * Obsidian ships its own `requestUrl` helper which works on desktop
 * (Electron) and mobile (iOS / Android) without going through the
 * browser fetch stack, so it is the preferred transport.
 */
class ZpicUploader {
  constructor(settings) {
    this.serverUrl = normalizeServerUrl(settings.serverUrl);
    this.timeout = settings.timeout;
  }
  /**
   * Update the uploader when the user changes the server URL or timeout
   * from the settings tab.
   */
  updateSettings(settings) {
    this.serverUrl = normalizeServerUrl(settings.serverUrl);
    this.timeout = settings.timeout;
  }
  /**
   * Upload one or more files. Dispatches to the JSON path-list mode
   * when given strings (file paths) and to the multipart mode when
   * given `File` objects.
   */
  async upload(input) {
    if (input.length === 0) {
      return { success: false, msg: "No files to upload" };
    }
    try {
      if (typeof input[0] === "string") {
        return await this.uploadPaths(input);
      }
      return await this.uploadMultipart(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[zpic] upload error:", message);
      return {
        success: false,
        msg: `Upload failed: ${message}`,
        code: "SERVER_ERROR",
      };
    }
  }
  /**
   * JSON path-list upload mode. Used on desktop Obsidian when the
   * dropped / pasted image is backed by a real file on disk.
   */
  async uploadPaths(paths) {
    const params = {
      url: `${this.serverUrl}/upload`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list: paths }),
      throw: false,
    };
    const response = await this.sendWithTimeout(params);
    return this.handleResponse(response);
  }
  /**
   * Multipart upload mode. Used on mobile and for clipboard images
   * that are not yet on disk.
   */
  async uploadMultipart(files) {
    // Obsidian's `requestUrl` does *not* reliably set the
    // `Content-Type: multipart/form-data; boundary=...` header when
    // handed a `FormData` body — on some platforms the header is
    // dropped entirely, and the server then rejects the request as
    // an unsupported content type. To avoid relying on that
    // behaviour, we build the multipart body by hand, set the
    // boundary explicitly, and ship the raw bytes with the matching
    // header.
    const { body, contentType } = await buildMultipartBody(files);
    // `RequestUrlParam.body` is typed as `string | ArrayBuffer`, not
    // `Uint8Array`. Passing a `Uint8Array` cast as `string` corrupts
    // the binary payload: `requestUrl` UTF-8 decodes it on the way
    // out, replacing every invalid byte sequence (i.e. almost all
    // image bytes after the ASCII headers) with U+FFFD. The server
    // then sees a malformed multipart envelope and replies with HTTP
    // 400 "incomplete multipart stream". Slicing the underlying
    // `ArrayBuffer` and shipping it as binary preserves every byte
    // on the wire.
    const bodyBuffer = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    );
    const params = {
      url: `${this.serverUrl}/upload`,
      method: "POST",
      headers: { "Content-Type": contentType },
      body: bodyBuffer,
      throw: false,
    };
    const response = await this.sendWithTimeout(params);
    return this.handleResponse(response);
  }
  /**
   * Race a `requestUrl` call against a timeout. We can't cancel the
   * underlying request from inside Obsidian, but rejecting early lets
   * the UI show a useful error rather than hanging.
   */
  async sendWithTimeout(params) {
    const send = obsidian.requestUrl(params);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Request timed out after ${this.timeout}ms`));
      }, this.timeout);
    });
    try {
      return await Promise.race([send, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** Parse the server response and surface structured errors. */
  handleResponse(response) {
    if (response.status < 200 || response.status >= 300) {
      return {
        success: false,
        msg: `Server returned HTTP ${response.status}`,
        code: "SERVER_ERROR",
      };
    }
    const data = response.json ?? {};
    if (!data || typeof data !== "object") {
      return {
        success: false,
        msg: "Server returned an invalid response",
        code: "SERVER_ERROR",
      };
    }
    if (!data.success) {
      return {
        success: false,
        msg: data.msg ?? "Upload failed",
        code: data.code ?? "UPLOAD_FAILED",
      };
    }
    return data;
  }
  /**
   * Lightweight reachability check used before kicking off a real
   * upload. Returns `true` only when the server responds with HTTP 200
   * and a valid `HealthResponse` payload.
   */
  async checkHealth() {
    try {
      const params = {
        url: `${this.serverUrl}/health`,
        method: "GET",
        throw: false,
      };
      const response = await this.sendWithTimeout(params);
      if (response.status !== 200) return false;
      const data = response.json ?? {};
      return data.status === "ok";
    } catch {
      return false;
    }
  }
  /**
   * Fetch the non-sensitive server configuration. Currently used for
   * diagnostics, exposed in the settings tab so users can confirm
   * which uploader is active.
   */
  async getConfig() {
    try {
      const params = {
        url: `${this.serverUrl}/config`,
        method: "GET",
        throw: false,
      };
      const response = await this.sendWithTimeout(params);
      if (response.status !== 200) return null;
      return response.json ?? null;
    } catch {
      return null;
    }
  }
}
/**
 * Show a user-visible notice with a default 5s timeout. Centralising
 * this keeps the message style consistent across the plugin.
 */
function showNotice(message, timeout = 5000) {
  new obsidian.Notice(message, timeout);
}
/**
 * Build a `multipart/form-data` envelope around the given files and
 * return the body as a `Uint8Array` plus the matching Content-Type
 * header (with a freshly-generated boundary). The boundary is
 * chosen at request time so concurrent uploads never collide.
 *
 * We do this by hand because Obsidian's `requestUrl` does not
 * reliably set the Content-Type when given a `FormData` body. The
 * resulting bytes are RFC 7578 compliant: ASCII headers around
 * each part, CRLF separators, and a `--<boundary>--` terminator.
 */
async function buildMultipartBody(files) {
  // Boundary rule: 1-70 chars, no spaces, no special characters
  // that would require quoting. We mix a timestamp and two random
  // base-36 segments to keep the boundary unique per request.
  const boundary =
    `----zpic-${Date.now().toString(36)}` +
    `-${Math.random().toString(36).slice(2, 10)}`;
  const encoder = new TextEncoder();
  const parts = [];
  for (const file of files) {
    const safeName = file.name.replace(/[\r\n"]/g, "_");
    const fileType = file.type || guessMimeType(file.name);
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="list"; filename="${safeName}"\r\n` +
      `Content-Type: ${fileType}\r\n\r\n`;
    parts.push(encoder.encode(header));
    parts.push(new Uint8Array(await file.arrayBuffer()));
    parts.push(encoder.encode("\r\n"));
  }
  // Closing boundary: same prefix as the part delimiter, then
  // an extra `--`.
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  // Concatenate every chunk into one buffer. Using `set` in a
  // single pass is roughly O(total) and avoids a quadratic copy.
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Type definitions for the zpic Obsidian plugin.
 */
/**
 * Frontmatter keys that allow disabling per-note uploads.
 * `zpic-upload: false` in the YAML frontmatter disables auto-upload.
 */
const FRONTMATTER_DISABLE_KEY = "zpic-upload";
const DEFAULT_SETTINGS = {
  serverUrl: "http://127.0.0.1:36677",
  uploadOnPaste: true,
  uploadOnDrop: true,
  imageDesc: "origin",
  deleteLocalAfterUpload: false,
  timeout: 30000,
};

/**
 * Settings tab for the zpic plugin.
 *
 * The plugin settings and the `ZpicSettingTab` class live in their own
 * module so that `main.ts` stays focused on event handling. The tab
 * uses the standard Obsidian `Setting` builder to render inputs that
 * match the look and feel of the rest of the settings panel.
 */
const SERVER_URL_PATTERN = /^https?:\/\/.+/i;
class ZpicSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    /** Reused probe to validate the server URL without leaking state. */
    this.probe = null;
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Zpic image upload" });
    containerEl.createEl("p", {
      text:
        "zpic uploads images to your configured host (GitHub, S3, OSS, " +
        "local, ...) and inserts the resulting URL into the current note. " +
        "Make sure the zpic server is running before using the plugin.",
      cls: "setting-item-description",
    });
    this.renderServerSection(containerEl);
    this.renderBehaviorSection(containerEl);
    this.renderDiagnosticsSection(containerEl);
  }
  /** Server URL + timeout. */
  renderServerSection(containerEl) {
    containerEl.createEl("h3", { text: "Server" });
    new obsidian.Setting(containerEl)
      .setName("Server URL")
      .setDesc(
        "Base URL of the running zpic server (default: http://127.0.0.1:36677).",
      )
      .addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:36677")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed && !SERVER_URL_PATTERN.test(trimmed)) {
              showNotice("Server URL must start with http:// or https://");
              return;
            }
            this.plugin.settings.serverUrl =
              trimmed || DEFAULT_SETTINGS.serverUrl;
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = "100%";
      });
    new obsidian.Setting(containerEl)
      .setName("Request timeout")
      .setDesc("Maximum time to wait for a single upload (milliseconds).")
      .addText((text) => {
        text
          .setPlaceholder("30000")
          .setValue(String(this.plugin.settings.timeout))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isNaN(parsed) || parsed <= 0) {
              showNotice("Timeout must be a positive number");
              return;
            }
            this.plugin.settings.timeout = parsed;
            await this.plugin.saveSettings();
          });
      });
  }
  /** Paste / drop behaviour + markdown formatting. */
  renderBehaviorSection(containerEl) {
    containerEl.createEl("h3", { text: "Behaviour" });
    new obsidian.Setting(containerEl)
      .setName("Upload on paste")
      .setDesc("Automatically upload images pasted from the clipboard.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.uploadOnPaste)
          .onChange(async (value) => {
            this.plugin.settings.uploadOnPaste = value;
            await this.plugin.saveSettings();
          }),
      );
    new obsidian.Setting(containerEl)
      .setName("Upload on drop")
      .setDesc(
        "Automatically upload image files dragged into the editor. " +
          "Hold Ctrl/Cmd while dropping to keep Obsidian's default behaviour.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.uploadOnDrop)
          .onChange(async (value) => {
            this.plugin.settings.uploadOnDrop = value;
            await this.plugin.saveSettings();
          }),
      );
    new obsidian.Setting(containerEl)
      .setName("Image description")
      .setDesc("How to render alt text in the inserted markdown.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("origin", "Original filename")
          .addOption("none", "Empty alt text")
          .setValue(this.plugin.settings.imageDesc)
          .onChange(async (value) => {
            this.plugin.settings.imageDesc = value;
            await this.plugin.saveSettings();
          }),
      );
    new obsidian.Setting(containerEl)
      .setName("Delete local file after upload")
      .setDesc(
        "Remove the local source file once the upload completes. " +
          "Only applies to files the plugin is responsible for (e.g. clipboard pastes).",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteLocalAfterUpload)
          .onChange(async (value) => {
            this.plugin.settings.deleteLocalAfterUpload = value;
            await this.plugin.saveSettings();
          }),
      );
  }
  /** Health probe + config dump for sanity-checking the server. */
  renderDiagnosticsSection(containerEl) {
    containerEl.createEl("h3", { text: "Diagnostics" });
    const statusEl = containerEl.createEl("div", {
      cls: "zpic-status",
      text: 'Click "Check server" to test the connection.',
    });
    new obsidian.Setting(containerEl)
      .setName("Check server")
      .setDesc("Verify the server is reachable and report the active uploader.")
      .addButton((button) =>
        button
          .setButtonText("Check server")
          .setCta()
          .onClick(async () => {
            statusEl.setText("Checking…");
            const probe = this.probe ?? new ZpicUploader(this.plugin.settings);
            this.probe = probe;
            probe.updateSettings(this.plugin.settings);
            const healthy = await probe.checkHealth();
            if (!healthy) {
              statusEl.setText(
                "Server is unreachable. Run `zpic server start` in a terminal.",
              );
              new obsidian.Notice("Cannot connect to zpic server", 5000);
              return;
            }
            const config = await probe.getConfig();
            if (!config) {
              statusEl.setText("Server is healthy but /config is unavailable.");
              return;
            }
            statusEl.setText(
              `OK · uploader: ${config.currentUploader} ` +
                `(${config.uploaders.length} available) · zpic v${config.version}`,
            );
          }),
      );
  }
}
/** Persisted-shape validation for loaded settings. */
function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  if (typeof merged.serverUrl !== "string" || merged.serverUrl.length === 0) {
    merged.serverUrl = DEFAULT_SETTINGS.serverUrl;
  }
  if (merged.imageDesc !== "origin" && merged.imageDesc !== "none") {
    merged.imageDesc = DEFAULT_SETTINGS.imageDesc;
  }
  if (typeof merged.timeout !== "number" || merged.timeout <= 0) {
    merged.timeout = DEFAULT_SETTINGS.timeout;
  }
  return merged;
}

/**
 * zpic Image Upload — Obsidian plugin entry point.
 *
 * Listens for editor paste and drop events, sends any image files to the
 * running zpic server, and replaces a temporary `![Uploading…]()` row in
 * the document with the final uploaded URL.
 *
 * The plugin is intentionally thin: the heavy lifting (network, retry,
 * uploader selection, history) lives inside the zpic server itself. See
 * `openspec/changes/add-http-server-for-obsidian` for the full design.
 */
const COMMAND_UPLOAD_FROM_CLIPBOARD = "upload-image-from-clipboard";
const COMMAND_UPLOAD_FROM_VAULT = "upload-image-from-vault";
class ZpicPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.uploader = new ZpicUploader(this.settings);
    this.addSettingTab(new ZpicSettingTab(this.app, this));
    // Paste handler — auto-uploads images coming from the OS clipboard.
    this.registerEvent(
      this.app.workspace.on("editor-paste", (evt, editor, view) => {
        void this.handlePaste(evt, editor, view);
      }),
    );
    // Drop handler — auto-uploads images dropped from the file system.
    this.registerEvent(
      this.app.workspace.on("editor-drop", (evt, editor, view) => {
        void this.handleDrop(evt, editor, view);
      }),
    );
    // Ribbon icon for users who prefer clicking over pasting/dropping.
    this.addRibbonIcon(
      "upload-glyph",
      "zpic: upload image from clipboard",
      () => {
        void this.uploadFromClipboard();
      },
    );
    this.addCommand({
      id: COMMAND_UPLOAD_FROM_CLIPBOARD,
      name: "Upload image from clipboard",
      editorCallback: (editor) => {
        void this.uploadFromClipboard(editor);
      },
    });
    this.addCommand({
      id: COMMAND_UPLOAD_FROM_VAULT,
      name: "Upload current image attachment",
      editorCheckCallback: (checking, editor, ctx) => {
        // Quick lookup: a candidate image is reachable via the current
        // selection without reading any bytes. The actual upload is
        // kicked off in the non-checking branch. `ctx` may be a
        // `MarkdownView` (editor commands) or a `MarkdownFileInfo`
        // (file-menu commands); we only need the view for the editor
        // selection.
        const view = ctx instanceof obsidian.MarkdownView ? ctx : null;
        const candidate = this.findImageReference(view, editor);
        if (checking) return candidate !== null;
        if (candidate) {
          void this.uploadReferencedImage(editor, candidate);
        }
        return true;
      },
    });
    console.info("[zpic] plugin loaded");
  }
  onunload() {
    console.info("[zpic] plugin unloaded");
  }
  async loadSettings() {
    const raw = await this.loadData();
    this.settings = normalizeSettings(raw ?? DEFAULT_SETTINGS);
  }
  async saveSettings() {
    await this.saveData(this.settings);
    // Keep the uploader in sync with the latest settings so subsequent
    // uploads don't have to wait for the next onload cycle.
    this.uploader?.updateSettings(this.settings);
  }
  // ------------------------------------------------------------------
  // Event handlers
  // ------------------------------------------------------------------
  async handlePaste(evt, editor, _view) {
    if (!this.settings.uploadOnPaste) return;
    if (this.isUploadDisabledInFrontmatter()) return;
    const files = evt.clipboardData?.files;
    if (!files || files.length === 0) return;
    const imageFiles = Array.from(files).filter(isImageFile);
    if (imageFiles.length === 0) return;
    // Only intercept the paste once we are sure there is an image to
    // upload, so pasting plain text still works.
    evt.preventDefault();
    evt.stopPropagation();
    await this.uploadAndInsert(editor, imageFiles);
  }
  async handleDrop(evt, editor, _view) {
    if (!this.settings.uploadOnDrop) return;
    if (this.isUploadDisabledInFrontmatter()) return;
    // Preserve Obsidian's default drag-to-attach behaviour when the
    // user explicitly opts out via modifier key.
    if (evt.ctrlKey || evt.metaKey) return;
    const files = evt.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const imageFiles = Array.from(files).filter(isImageFile);
    if (imageFiles.length === 0) return;
    evt.preventDefault();
    evt.stopPropagation();
    await this.uploadAndInsert(editor, imageFiles);
  }
  // ------------------------------------------------------------------
  // Core upload pipeline
  // ------------------------------------------------------------------
  /**
   * Insert placeholders for each file, kick off the upload, and then
   * replace the placeholders with the returned URLs (or an error row
   * on failure).
   */
  async uploadAndInsert(editor, files) {
    if (files.length === 0) return null;
    const healthy = await this.uploader.checkHealth();
    if (!healthy) {
      showNotice(
        "Cannot connect to zpic server. Run `zpic server start` in a terminal.",
        6000,
      );
      return null;
    }
    // One placeholder per file keeps the visual order stable and lets
    // us map the response array back to the inserted rows.
    const placeholders = files.map((file) => ({
      id: generatePlaceholderId(),
      name: file.name,
    }));
    const placeholderText = placeholders
      .map((p) => getPlaceholderText(p.id))
      .join("\n");
    editor.replaceSelection(`${placeholderText}\n`);
    try {
      const response = await this.uploader.upload(files);
      if (!response.success) {
        this.replacePlaceholders(editor, placeholders, {
          success: false,
          msg: response.msg ?? "Upload failed",
        });
        showNotice(`Upload failed: ${response.msg ?? "unknown error"}`);
        return response;
      }
      const urls = response.result ?? [];
      placeholders.forEach((placeholder, index) => {
        const url = urls[index];
        if (!url) {
          this.replacePlaceholder(editor, placeholder.id, "⚠️ Missing URL");
          return;
        }
        const markdown = formatImageMarkdown(
          url,
          placeholder.name,
          this.settings.imageDesc,
        );
        this.replacePlaceholder(editor, placeholder.id, markdown);
      });
      const okCount = placeholders.filter((_, i) => urls[i]).length;
      if (okCount > 0) {
        showNotice(`Uploaded ${okCount} of ${placeholders.length} image(s)`);
      }
      // The `deleteLocalAfterUpload` setting is a no-op for now: we
      // can't reliably tell a clipboard blob from a dragged file on
      // every platform, so deleting the source might destroy user
      // data. The setting is wired through to the UI to reserve the
      // contract — see CHANGELOG 0.1.0.
      void this.settings.deleteLocalAfterUpload;
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[zpic] unexpected error during upload:", message);
      this.replacePlaceholders(editor, placeholders, {
        success: false,
        msg: message,
      });
      showNotice(`Upload error: ${message}`);
      return null;
    }
  }
  /**
   * Locate the first occurrence of a placeholder in the editor and
   * swap it for `replacement`. The search is anchored on the unique id
   * embedded in the alt text so multi-image batches don't collide.
   */
  replacePlaceholder(editor, id, replacement) {
    const target = getPlaceholderText(id);
    const content = editor.getValue();
    const idx = content.indexOf(target);
    if (idx === -1) return;
    const pos = editor.offsetToPos(idx);
    const end = editor.offsetToPos(idx + target.length);
    editor.replaceRange(replacement, pos, end);
  }
  /** Bulk-replace placeholders with a single error row. */
  replacePlaceholders(editor, placeholders, response) {
    for (const placeholder of placeholders) {
      this.replacePlaceholder(
        editor,
        placeholder.id,
        `⚠️ Upload failed: ${response.msg}`,
      );
    }
  }
  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------
  async uploadFromClipboard(editor) {
    if (typeof navigator === "undefined" || !navigator.clipboard?.read) {
      showNotice("Clipboard read is not available in this context");
      return;
    }
    let items;
    try {
      items = await navigator.clipboard.read();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotice(`Cannot read clipboard: ${message}`);
      return;
    }
    const files = [];
    for (const item of items) {
      for (const type of item.types) {
        if (!type.startsWith("image/")) continue;
        const blob = await item.getType(type);
        const ext = type.split("/")[1] ?? "png";
        const name = `clipboard-${Date.now()}.${ext}`;
        const file = new File([blob], name, {
          type: type || guessMimeType(name),
        });
        files.push(file);
      }
    }
    if (files.length === 0) {
      showNotice("No image found in clipboard");
      return;
    }
    const target = editor ?? this.getActiveEditor();
    if (!target) {
      showNotice("No active editor to insert into");
      return;
    }
    await this.uploadAndInsert(target, files);
  }
  /**
   * Resolve the image attachment referenced by the current selection
   * (if any) into a vault `TFile`. Synchronous and side-effect-free, so
   * the command palette can use it as a cheap predicate.
   */
  findImageReference(view, editor) {
    if (!view) return null;
    const selected = editor.getSelection().trim();
    const path = this.extractImagePath(selected);
    if (!path) return null;
    const resolved = this.app.vault.getAbstractFileByPath(path);
    if (!(resolved instanceof obsidian.TFile)) return null;
    if (!isImageFile(resolved)) return null;
    return resolved;
  }
  /**
   * Read a vault image into memory and feed it through the regular
   * upload pipeline.
   */
  async uploadReferencedImage(editor, file) {
    try {
      const bytes = await this.app.vault.readBinary(file);
      const blob = new File([bytes], file.name, {
        type: guessMimeType(file.name),
      });
      await this.uploadAndInsert(editor, [blob]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotice(`Cannot read vault image: ${message}`);
    }
  }
  /**
   * Extract the path portion of a markdown image tag in the current
   * selection. Returns `null` for external URLs or non-image content.
   */
  extractImagePath(selection) {
    if (!selection) return null;
    const match = selection.match(/!\[[^\]]*\]\(([^)]+)\)/);
    if (!match) return null;
    const target = match[1].trim();
    if (/^[a-z]+:\/\//i.test(target)) return null;
    // Strip optional title: `path "title"`.
    const cleanPath = target.split(" ")[0];
    if (cleanPath.startsWith("/")) {
      return cleanPath.slice(1);
    }
    return cleanPath;
  }
  getActiveEditor() {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    return view?.editor ?? null;
  }
  // ------------------------------------------------------------------
  // Frontmatter opt-out
  // ------------------------------------------------------------------
  /**
   * Allow individual notes to disable auto-upload via the YAML key
   * `zpic-upload: false`. We keep the key configurable but the constant
   * is the only one we read in this version.
   */
  isUploadDisabledInFrontmatter() {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    const cache = view?.file
      ? this.app.metadataCache.getFileCache(view.file)
      : null;
    const value = cache?.frontmatter?.[FRONTMATTER_DISABLE_KEY];
    if (value === false) return false; // explicit opt-in overrides nothing
    if (value === "false" || value === "no" || value === 0) return false;
    return Boolean(value);
  }
}

module.exports = ZpicPlugin;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsic3JjL3V0aWxzLnRzIiwic3JjL3VwbG9hZGVyLnRzIiwic3JjL3R5cGVzLnRzIiwic3JjL3NldHRpbmdzLnRzIiwic3JjL21haW4udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBVdGlsaXR5IGhlbHBlcnMgc2hhcmVkIGFjcm9zcyB0aGUgcGx1Z2luLlxuICpcbiAqIEtlZXAgdGhpcyBtb2R1bGUgZGVwZW5kZW5jeS1mcmVlIChvdGhlciB0aGFuIHRoZSB0eXBlLW9ubHkgYG9ic2lkaWFuYFxuICogaW1wb3J0KSBzbyBpdCBjYW4gYmUgZXhlcmNpc2VkIGZyb20gdGVzdHMgaW4gdGhlIGZ1dHVyZS5cbiAqL1xuXG5pbXBvcnQgeyBURmlsZSB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB0eXBlIHsgSW1hZ2VEZXNjTW9kZSB9IGZyb20gJy4vdHlwZXMnO1xuXG4vKiogTG93ZXItY2FzZSBpbWFnZSBleHRlbnNpb25zIGFjY2VwdGVkIGJ5IHRoZSBwbHVnaW4gYW5kIHpwaWMgc2VydmVyLiAqL1xuY29uc3QgSU1BR0VfRVhURU5TSU9OUyA9IFtcbiAgJy5wbmcnLFxuICAnLmpwZycsXG4gICcuanBlZycsXG4gICcuZ2lmJyxcbiAgJy53ZWJwJyxcbiAgJy5ibXAnLFxuICAnLnRpZmYnLFxuICAnLnRpZicsXG4gICcuc3ZnJyxcbiAgJy5hdmlmJyxcbl07XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciBhIGZpbGUgKGJyb3dzZXIgYEZpbGVgIG9yIE9ic2lkaWFuIGBURmlsZWApIGlzIGFuIGltYWdlXG4gKiBieSBsb29raW5nIGF0IGl0cyBleHRlbnNpb24uIFRoZSBNSU1FIHR5cGUgb24gYEZpbGVgIG9iamVjdHMgaXMgbm90XG4gKiByZWxpYWJsZSBhY3Jvc3MgbW9iaWxlIHBsYXRmb3Jtcywgc28gd2UgZmFsbCBiYWNrIHRvIHRoZSBleHRlbnNpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0ltYWdlRmlsZShmaWxlOiBGaWxlIHwgVEZpbGUpOiBib29sZWFuIHtcbiAgaWYgKCFmaWxlIHx8ICFmaWxlLm5hbWUpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgZmlsZU5hbWUgPSBmaWxlLm5hbWUudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIElNQUdFX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBmaWxlTmFtZS5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBhIHNob3J0LCB1bmlxdWUgcGxhY2Vob2xkZXIgaWQgdXNlZCBpbnNpZGUgdGhlIGluc2VydGVkXG4gKiBgIVtVcGxvYWRpbmcuLi57aWR9XSgpYCBtYXJrZG93bi4gQ3J5cHRvZ3JhcGhpYyBzdHJlbmd0aCBpcyBub3QgbmVlZGVkXG4gKiBoZXJlOyB3ZSBqdXN0IHdhbnQgdG8gYXZvaWQgY2xhc2hlcyBiZXR3ZWVuIGNvbmN1cnJlbnQgdXBsb2Fkcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdlbmVyYXRlUGxhY2Vob2xkZXJJZCgpOiBzdHJpbmcge1xuICByZXR1cm4gTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOSk7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIG1hcmtkb3duIGltYWdlIHRhZyBmb3IgYW4gdXBsb2FkZWQgVVJMLiBUaGUgYGRlc2NgIG1vZGVcbiAqIGNvbnRyb2xzIHdoZXRoZXIgdGhlIG9yaWdpbmFsIGZpbGVuYW1lIGlzIHByZXNlcnZlZCBhcyBhbHQgdGV4dC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdEltYWdlTWFya2Rvd24oXG4gIHVybDogc3RyaW5nLFxuICBuYW1lOiBzdHJpbmcsXG4gIGRlc2M6IEltYWdlRGVzY01vZGVcbik6IHN0cmluZyB7XG4gIGNvbnN0IGFsdFRleHQgPSBkZXNjID09PSAnb3JpZ2luJyA/IG5hbWUgOiAnJztcbiAgcmV0dXJuIGAhWyR7YWx0VGV4dH1dKCR7dXJsfSlgO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBwbGFjZWhvbGRlciBtYXJrZG93biBpbnNlcnRlZCB3aGlsZSBhbiB1cGxvYWQgaXMgaW4gZmxpZ2h0LlxuICogVGhlIGlkIGlzIGVtYmVkZGVkIHNvIHRoZSBwb3N0LXVwbG9hZCByZXBsYWNlbWVudCBjYW4gbG9jYXRlIHRoZSByb3cuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRQbGFjZWhvbGRlclRleHQoaWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgIVtVcGxvYWRpbmcgJHtpZH3igKZdKClgO1xufVxuXG4vKipcbiAqIE5vcm1hbGl6ZSBhIHVzZXItcHJvdmlkZWQgc2VydmVyIFVSTDogdHJpbSB3aGl0ZXNwYWNlIGFuZCBzdHJpcCBhXG4gKiB0cmFpbGluZyBzbGFzaCBzbyB3ZSBjYW4gc2FmZWx5IGNvbmNhdGVuYXRlIGAvdXBsb2FkYCwgYC9oZWFsdGhgLCBldGMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTZXJ2ZXJVcmwodXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdXJsLnRyaW0oKS5yZXBsYWNlKC9cXC8rJC8sICcnKTtcbn1cblxuLyoqXG4gKiBIZXVyaXN0aWMgTUlNRSBndWVzcyBmcm9tIGEgZmlsZW5hbWUuIFVzZWQgYXMgYSBmYWxsYmFjayB3aGVuIHRoZVxuICogcGxhdGZvcm0tcHJvdmlkZWQgYEZpbGUudHlwZWAgaXMgZW1wdHkgKGNvbW1vbiBvbiBpT1MpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ3Vlc3NNaW1lVHlwZShmaWxlTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgZXh0ID0gZmlsZU5hbWUudG9Mb3dlckNhc2UoKS5zcGxpdCgnLicpLnBvcCgpID8/ICcnO1xuICBzd2l0Y2ggKGV4dCkge1xuICAgIGNhc2UgJ3BuZyc6XG4gICAgICByZXR1cm4gJ2ltYWdlL3BuZyc7XG4gICAgY2FzZSAnanBnJzpcbiAgICBjYXNlICdqcGVnJzpcbiAgICAgIHJldHVybiAnaW1hZ2UvanBlZyc7XG4gICAgY2FzZSAnZ2lmJzpcbiAgICAgIHJldHVybiAnaW1hZ2UvZ2lmJztcbiAgICBjYXNlICd3ZWJwJzpcbiAgICAgIHJldHVybiAnaW1hZ2Uvd2VicCc7XG4gICAgY2FzZSAnYm1wJzpcbiAgICAgIHJldHVybiAnaW1hZ2UvYm1wJztcbiAgICBjYXNlICdzdmcnOlxuICAgICAgcmV0dXJuICdpbWFnZS9zdmcreG1sJztcbiAgICBjYXNlICdhdmlmJzpcbiAgICAgIHJldHVybiAnaW1hZ2UvYXZpZic7XG4gICAgY2FzZSAndGlmJzpcbiAgICBjYXNlICd0aWZmJzpcbiAgICAgIHJldHVybiAnaW1hZ2UvdGlmZic7XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiAnYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtJztcbiAgfVxufVxuIiwiLyoqXG4gKiBIVFRQIGNsaWVudCBmb3IgdGhlIHpwaWMgc2VydmVyLlxuICpcbiAqIENvbW11bmljYXRlcyB3aXRoIHRoZSBQaWNHby1jb21wYXRpYmxlIEFQSSBkb2N1bWVudGVkIGluXG4gKiBgb3BlbnNwZWMvY2hhbmdlcy9hZGQtaHR0cC1zZXJ2ZXItZm9yLW9ic2lkaWFuL3NwZWNzL2FwaS1zcGVjaWZpY2F0aW9uLm1kYC5cbiAqXG4gKiBPYnNpZGlhbiBzaGlwcyBpdHMgb3duIGByZXF1ZXN0VXJsYCBoZWxwZXIgd2hpY2ggd29ya3Mgb24gZGVza3RvcFxuICogKEVsZWN0cm9uKSBhbmQgbW9iaWxlIChpT1MgLyBBbmRyb2lkKSB3aXRob3V0IGdvaW5nIHRocm91Z2ggdGhlXG4gKiBicm93c2VyIGZldGNoIHN0YWNrLCBzbyBpdCBpcyB0aGUgcHJlZmVycmVkIHRyYW5zcG9ydC5cbiAqL1xuXG5pbXBvcnQgeyBOb3RpY2UsIHJlcXVlc3RVcmwsIHR5cGUgUmVxdWVzdFVybFBhcmFtIH0gZnJvbSBcIm9ic2lkaWFuXCI7XG5pbXBvcnQgdHlwZSB7XG4gIEhlYWx0aFJlc3BvbnNlLFxuICBTZXJ2ZXJDb25maWdSZXNwb25zZSxcbiAgVXBsb2FkRXJyb3JDb2RlLFxuICBVcGxvYWRSZXNwb25zZSxcbiAgWnBpY1NldHRpbmdzLFxufSBmcm9tIFwiLi90eXBlc1wiO1xuaW1wb3J0IHsgZ3Vlc3NNaW1lVHlwZSwgbm9ybWFsaXplU2VydmVyVXJsIH0gZnJvbSBcIi4vdXRpbHNcIjtcblxuLyoqIFN1YnNldCBvZiB0aGUgT2JzaWRpYW4gYFJlcXVlc3RVcmxSZXNwb25zZWAgd2UgZGVwZW5kIG9uLiAqL1xuaW50ZXJmYWNlIE1pbmltYWxSZXF1ZXN0UmVzcG9uc2Uge1xuICBzdGF0dXM6IG51bWJlcjtcbiAganNvbjogdW5rbm93bjtcbiAgdGV4dD86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIFpwaWNVcGxvYWRlciB7XG4gIHByaXZhdGUgc2VydmVyVXJsOiBzdHJpbmc7XG4gIHByaXZhdGUgdGltZW91dDogbnVtYmVyO1xuXG4gIGNvbnN0cnVjdG9yKHNldHRpbmdzOiBacGljU2V0dGluZ3MpIHtcbiAgICB0aGlzLnNlcnZlclVybCA9IG5vcm1hbGl6ZVNlcnZlclVybChzZXR0aW5ncy5zZXJ2ZXJVcmwpO1xuICAgIHRoaXMudGltZW91dCA9IHNldHRpbmdzLnRpbWVvdXQ7XG4gIH1cblxuICAvKipcbiAgICogVXBkYXRlIHRoZSB1cGxvYWRlciB3aGVuIHRoZSB1c2VyIGNoYW5nZXMgdGhlIHNlcnZlciBVUkwgb3IgdGltZW91dFxuICAgKiBmcm9tIHRoZSBzZXR0aW5ncyB0YWIuXG4gICAqL1xuICB1cGRhdGVTZXR0aW5ncyhzZXR0aW5nczogWnBpY1NldHRpbmdzKTogdm9pZCB7XG4gICAgdGhpcy5zZXJ2ZXJVcmwgPSBub3JtYWxpemVTZXJ2ZXJVcmwoc2V0dGluZ3Muc2VydmVyVXJsKTtcbiAgICB0aGlzLnRpbWVvdXQgPSBzZXR0aW5ncy50aW1lb3V0O1xuICB9XG5cbiAgLyoqXG4gICAqIFVwbG9hZCBvbmUgb3IgbW9yZSBmaWxlcy4gRGlzcGF0Y2hlcyB0byB0aGUgSlNPTiBwYXRoLWxpc3QgbW9kZVxuICAgKiB3aGVuIGdpdmVuIHN0cmluZ3MgKGZpbGUgcGF0aHMpIGFuZCB0byB0aGUgbXVsdGlwYXJ0IG1vZGUgd2hlblxuICAgKiBnaXZlbiBgRmlsZWAgb2JqZWN0cy5cbiAgICovXG4gIGFzeW5jIHVwbG9hZChpbnB1dDogRmlsZVtdIHwgc3RyaW5nW10pOiBQcm9taXNlPFVwbG9hZFJlc3BvbnNlPiB7XG4gICAgaWYgKGlucHV0Lmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIG1zZzogXCJObyBmaWxlcyB0byB1cGxvYWRcIiB9O1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBpZiAodHlwZW9mIGlucHV0WzBdID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHJldHVybiBhd2FpdCB0aGlzLnVwbG9hZFBhdGhzKGlucHV0IGFzIHN0cmluZ1tdKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBhd2FpdCB0aGlzLnVwbG9hZE11bHRpcGFydChpbnB1dCBhcyBGaWxlW10pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgY29uc29sZS5lcnJvcihcIlt6cGljXSB1cGxvYWQgZXJyb3I6XCIsIG1lc3NhZ2UpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIG1zZzogYFVwbG9hZCBmYWlsZWQ6ICR7bWVzc2FnZX1gLFxuICAgICAgICBjb2RlOiBcIlNFUlZFUl9FUlJPUlwiLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogSlNPTiBwYXRoLWxpc3QgdXBsb2FkIG1vZGUuIFVzZWQgb24gZGVza3RvcCBPYnNpZGlhbiB3aGVuIHRoZVxuICAgKiBkcm9wcGVkIC8gcGFzdGVkIGltYWdlIGlzIGJhY2tlZCBieSBhIHJlYWwgZmlsZSBvbiBkaXNrLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyB1cGxvYWRQYXRocyhwYXRoczogc3RyaW5nW10pOiBQcm9taXNlPFVwbG9hZFJlc3BvbnNlPiB7XG4gICAgY29uc3QgcGFyYW1zOiBSZXF1ZXN0VXJsUGFyYW0gPSB7XG4gICAgICB1cmw6IGAke3RoaXMuc2VydmVyVXJsfS91cGxvYWRgLFxuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgbGlzdDogcGF0aHMgfSksXG4gICAgICB0aHJvdzogZmFsc2UsXG4gICAgfTtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZFdpdGhUaW1lb3V0KHBhcmFtcyk7XG4gICAgcmV0dXJuIHRoaXMuaGFuZGxlUmVzcG9uc2UocmVzcG9uc2UpO1xuICB9XG5cbiAgLyoqXG4gICAqIE11bHRpcGFydCB1cGxvYWQgbW9kZS4gVXNlZCBvbiBtb2JpbGUgYW5kIGZvciBjbGlwYm9hcmQgaW1hZ2VzXG4gICAqIHRoYXQgYXJlIG5vdCB5ZXQgb24gZGlzay5cbiAgICovXG4gIHByaXZhdGUgYXN5bmMgdXBsb2FkTXVsdGlwYXJ0KGZpbGVzOiBGaWxlW10pOiBQcm9taXNlPFVwbG9hZFJlc3BvbnNlPiB7XG4gICAgLy8gT2JzaWRpYW4ncyBgcmVxdWVzdFVybGAgZG9lcyAqbm90KiByZWxpYWJseSBzZXQgdGhlXG4gICAgLy8gYENvbnRlbnQtVHlwZTogbXVsdGlwYXJ0L2Zvcm0tZGF0YTsgYm91bmRhcnk9Li4uYCBoZWFkZXIgd2hlblxuICAgIC8vIGhhbmRlZCBhIGBGb3JtRGF0YWAgYm9keSDigJQgb24gc29tZSBwbGF0Zm9ybXMgdGhlIGhlYWRlciBpc1xuICAgIC8vIGRyb3BwZWQgZW50aXJlbHksIGFuZCB0aGUgc2VydmVyIHRoZW4gcmVqZWN0cyB0aGUgcmVxdWVzdCBhc1xuICAgIC8vIGFuIHVuc3VwcG9ydGVkIGNvbnRlbnQgdHlwZS4gVG8gYXZvaWQgcmVseWluZyBvbiB0aGF0XG4gICAgLy8gYmVoYXZpb3VyLCB3ZSBidWlsZCB0aGUgbXVsdGlwYXJ0IGJvZHkgYnkgaGFuZCwgc2V0IHRoZVxuICAgIC8vIGJvdW5kYXJ5IGV4cGxpY2l0bHksIGFuZCBzaGlwIHRoZSByYXcgYnl0ZXMgd2l0aCB0aGUgbWF0Y2hpbmdcbiAgICAvLyBoZWFkZXIuXG4gICAgY29uc3QgeyBib2R5LCBjb250ZW50VHlwZSB9ID0gYXdhaXQgYnVpbGRNdWx0aXBhcnRCb2R5KGZpbGVzKTtcblxuICAgIC8vIGBSZXF1ZXN0VXJsUGFyYW0uYm9keWAgaXMgdHlwZWQgYXMgYHN0cmluZyB8IEFycmF5QnVmZmVyYCwgbm90XG4gICAgLy8gYFVpbnQ4QXJyYXlgLiBQYXNzaW5nIGEgYFVpbnQ4QXJyYXlgIGNhc3QgYXMgYHN0cmluZ2AgY29ycnVwdHNcbiAgICAvLyB0aGUgYmluYXJ5IHBheWxvYWQ6IGByZXF1ZXN0VXJsYCBVVEYtOCBkZWNvZGVzIGl0IG9uIHRoZSB3YXlcbiAgICAvLyBvdXQsIHJlcGxhY2luZyBldmVyeSBpbnZhbGlkIGJ5dGUgc2VxdWVuY2UgKGkuZS4gYWxtb3N0IGFsbFxuICAgIC8vIGltYWdlIGJ5dGVzIGFmdGVyIHRoZSBBU0NJSSBoZWFkZXJzKSB3aXRoIFUrRkZGRC4gVGhlIHNlcnZlclxuICAgIC8vIHRoZW4gc2VlcyBhIG1hbGZvcm1lZCBtdWx0aXBhcnQgZW52ZWxvcGUgYW5kIHJlcGxpZXMgd2l0aCBIVFRQXG4gICAgLy8gNDAwIFwiaW5jb21wbGV0ZSBtdWx0aXBhcnQgc3RyZWFtXCIuIFNsaWNpbmcgdGhlIHVuZGVybHlpbmdcbiAgICAvLyBgQXJyYXlCdWZmZXJgIGFuZCBzaGlwcGluZyBpdCBhcyBiaW5hcnkgcHJlc2VydmVzIGV2ZXJ5IGJ5dGVcbiAgICAvLyBvbiB0aGUgd2lyZS5cbiAgICBjb25zdCBib2R5QnVmZmVyID0gYm9keS5idWZmZXIuc2xpY2UoXG4gICAgICBib2R5LmJ5dGVPZmZzZXQsXG4gICAgICBib2R5LmJ5dGVPZmZzZXQgKyBib2R5LmJ5dGVMZW5ndGgsXG4gICAgKSBhcyBBcnJheUJ1ZmZlcjtcblxuICAgIGNvbnN0IHBhcmFtczogUmVxdWVzdFVybFBhcmFtID0ge1xuICAgICAgdXJsOiBgJHt0aGlzLnNlcnZlclVybH0vdXBsb2FkYCxcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IGNvbnRlbnRUeXBlIH0sXG4gICAgICBib2R5OiBib2R5QnVmZmVyLFxuICAgICAgdGhyb3c6IGZhbHNlLFxuICAgIH07XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmRXaXRoVGltZW91dChwYXJhbXMpO1xuICAgIHJldHVybiB0aGlzLmhhbmRsZVJlc3BvbnNlKHJlc3BvbnNlKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSYWNlIGEgYHJlcXVlc3RVcmxgIGNhbGwgYWdhaW5zdCBhIHRpbWVvdXQuIFdlIGNhbid0IGNhbmNlbCB0aGVcbiAgICogdW5kZXJseWluZyByZXF1ZXN0IGZyb20gaW5zaWRlIE9ic2lkaWFuLCBidXQgcmVqZWN0aW5nIGVhcmx5IGxldHNcbiAgICogdGhlIFVJIHNob3cgYSB1c2VmdWwgZXJyb3IgcmF0aGVyIHRoYW4gaGFuZ2luZy5cbiAgICovXG4gIHByaXZhdGUgYXN5bmMgc2VuZFdpdGhUaW1lb3V0KFxuICAgIHBhcmFtczogUmVxdWVzdFVybFBhcmFtLFxuICApOiBQcm9taXNlPE1pbmltYWxSZXF1ZXN0UmVzcG9uc2U+IHtcbiAgICBjb25zdCBzZW5kID0gcmVxdWVzdFVybChcbiAgICAgIHBhcmFtcyxcbiAgICApIGFzIHVua25vd24gYXMgUHJvbWlzZTxNaW5pbWFsUmVxdWVzdFJlc3BvbnNlPjtcbiAgICBsZXQgdGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXG4gICAgY29uc3QgdGltZW91dCA9IG5ldyBQcm9taXNlPE1pbmltYWxSZXF1ZXN0UmVzcG9uc2U+KChfLCByZWplY3QpID0+IHtcbiAgICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHJlamVjdChuZXcgRXJyb3IoYFJlcXVlc3QgdGltZWQgb3V0IGFmdGVyICR7dGhpcy50aW1lb3V0fW1zYCkpO1xuICAgICAgfSwgdGhpcy50aW1lb3V0KTtcbiAgICB9KTtcblxuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgUHJvbWlzZS5yYWNlKFtzZW5kLCB0aW1lb3V0XSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmICh0aW1lcikgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB9XG4gIH1cblxuICAvKiogUGFyc2UgdGhlIHNlcnZlciByZXNwb25zZSBhbmQgc3VyZmFjZSBzdHJ1Y3R1cmVkIGVycm9ycy4gKi9cbiAgcHJpdmF0ZSBoYW5kbGVSZXNwb25zZShyZXNwb25zZTogTWluaW1hbFJlcXVlc3RSZXNwb25zZSk6IFVwbG9hZFJlc3BvbnNlIHtcbiAgICBpZiAocmVzcG9uc2Uuc3RhdHVzIDwgMjAwIHx8IHJlc3BvbnNlLnN0YXR1cyA+PSAzMDApIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICBtc2c6IGBTZXJ2ZXIgcmV0dXJuZWQgSFRUUCAke3Jlc3BvbnNlLnN0YXR1c31gLFxuICAgICAgICBjb2RlOiBcIlNFUlZFUl9FUlJPUlwiLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBkYXRhID0gKHJlc3BvbnNlLmpzb24gPz8ge30pIGFzIFVwbG9hZFJlc3BvbnNlO1xuICAgIGlmICghZGF0YSB8fCB0eXBlb2YgZGF0YSAhPT0gXCJvYmplY3RcIikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIG1zZzogXCJTZXJ2ZXIgcmV0dXJuZWQgYW4gaW52YWxpZCByZXNwb25zZVwiLFxuICAgICAgICBjb2RlOiBcIlNFUlZFUl9FUlJPUlwiLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAoIWRhdGEuc3VjY2Vzcykge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIG1zZzogZGF0YS5tc2cgPz8gXCJVcGxvYWQgZmFpbGVkXCIsXG4gICAgICAgIGNvZGU6IChkYXRhLmNvZGUgPz8gXCJVUExPQURfRkFJTEVEXCIpIGFzIFVwbG9hZEVycm9yQ29kZSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIGRhdGE7XG4gIH1cblxuICAvKipcbiAgICogTGlnaHR3ZWlnaHQgcmVhY2hhYmlsaXR5IGNoZWNrIHVzZWQgYmVmb3JlIGtpY2tpbmcgb2ZmIGEgcmVhbFxuICAgKiB1cGxvYWQuIFJldHVybnMgYHRydWVgIG9ubHkgd2hlbiB0aGUgc2VydmVyIHJlc3BvbmRzIHdpdGggSFRUUCAyMDBcbiAgICogYW5kIGEgdmFsaWQgYEhlYWx0aFJlc3BvbnNlYCBwYXlsb2FkLlxuICAgKi9cbiAgYXN5bmMgY2hlY2tIZWFsdGgoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBhcmFtczogUmVxdWVzdFVybFBhcmFtID0ge1xuICAgICAgICB1cmw6IGAke3RoaXMuc2VydmVyVXJsfS9oZWFsdGhgLFxuICAgICAgICBtZXRob2Q6IFwiR0VUXCIsXG4gICAgICAgIHRocm93OiBmYWxzZSxcbiAgICAgIH07XG4gICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZFdpdGhUaW1lb3V0KHBhcmFtcyk7XG4gICAgICBpZiAocmVzcG9uc2Uuc3RhdHVzICE9PSAyMDApIHJldHVybiBmYWxzZTtcbiAgICAgIGNvbnN0IGRhdGEgPSAocmVzcG9uc2UuanNvbiA/PyB7fSkgYXMgSGVhbHRoUmVzcG9uc2U7XG4gICAgICByZXR1cm4gZGF0YS5zdGF0dXMgPT09IFwib2tcIjtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogRmV0Y2ggdGhlIG5vbi1zZW5zaXRpdmUgc2VydmVyIGNvbmZpZ3VyYXRpb24uIEN1cnJlbnRseSB1c2VkIGZvclxuICAgKiBkaWFnbm9zdGljcywgZXhwb3NlZCBpbiB0aGUgc2V0dGluZ3MgdGFiIHNvIHVzZXJzIGNhbiBjb25maXJtXG4gICAqIHdoaWNoIHVwbG9hZGVyIGlzIGFjdGl2ZS5cbiAgICovXG4gIGFzeW5jIGdldENvbmZpZygpOiBQcm9taXNlPFNlcnZlckNvbmZpZ1Jlc3BvbnNlIHwgbnVsbD4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJhbXM6IFJlcXVlc3RVcmxQYXJhbSA9IHtcbiAgICAgICAgdXJsOiBgJHt0aGlzLnNlcnZlclVybH0vY29uZmlnYCxcbiAgICAgICAgbWV0aG9kOiBcIkdFVFwiLFxuICAgICAgICB0aHJvdzogZmFsc2UsXG4gICAgICB9O1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmRXaXRoVGltZW91dChwYXJhbXMpO1xuICAgICAgaWYgKHJlc3BvbnNlLnN0YXR1cyAhPT0gMjAwKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiAocmVzcG9uc2UuanNvbiA/PyBudWxsKSBhcyBTZXJ2ZXJDb25maWdSZXNwb25zZSB8IG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH1cbn1cblxuLyoqXG4gKiBTaG93IGEgdXNlci12aXNpYmxlIG5vdGljZSB3aXRoIGEgZGVmYXVsdCA1cyB0aW1lb3V0LiBDZW50cmFsaXNpbmdcbiAqIHRoaXMga2VlcHMgdGhlIG1lc3NhZ2Ugc3R5bGUgY29uc2lzdGVudCBhY3Jvc3MgdGhlIHBsdWdpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3dOb3RpY2UobWVzc2FnZTogc3RyaW5nLCB0aW1lb3V0ID0gNTAwMCk6IHZvaWQge1xuICBuZXcgTm90aWNlKG1lc3NhZ2UsIHRpbWVvdXQpO1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgYG11bHRpcGFydC9mb3JtLWRhdGFgIGVudmVsb3BlIGFyb3VuZCB0aGUgZ2l2ZW4gZmlsZXMgYW5kXG4gKiByZXR1cm4gdGhlIGJvZHkgYXMgYSBgVWludDhBcnJheWAgcGx1cyB0aGUgbWF0Y2hpbmcgQ29udGVudC1UeXBlXG4gKiBoZWFkZXIgKHdpdGggYSBmcmVzaGx5LWdlbmVyYXRlZCBib3VuZGFyeSkuIFRoZSBib3VuZGFyeSBpc1xuICogY2hvc2VuIGF0IHJlcXVlc3QgdGltZSBzbyBjb25jdXJyZW50IHVwbG9hZHMgbmV2ZXIgY29sbGlkZS5cbiAqXG4gKiBXZSBkbyB0aGlzIGJ5IGhhbmQgYmVjYXVzZSBPYnNpZGlhbidzIGByZXF1ZXN0VXJsYCBkb2VzIG5vdFxuICogcmVsaWFibHkgc2V0IHRoZSBDb250ZW50LVR5cGUgd2hlbiBnaXZlbiBhIGBGb3JtRGF0YWAgYm9keS4gVGhlXG4gKiByZXN1bHRpbmcgYnl0ZXMgYXJlIFJGQyA3NTc4IGNvbXBsaWFudDogQVNDSUkgaGVhZGVycyBhcm91bmRcbiAqIGVhY2ggcGFydCwgQ1JMRiBzZXBhcmF0b3JzLCBhbmQgYSBgLS08Ym91bmRhcnk+LS1gIHRlcm1pbmF0b3IuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZE11bHRpcGFydEJvZHkoXG4gIGZpbGVzOiBGaWxlW10sXG4pOiBQcm9taXNlPHsgYm9keTogVWludDhBcnJheTsgY29udGVudFR5cGU6IHN0cmluZyB9PiB7XG4gIC8vIEJvdW5kYXJ5IHJ1bGU6IDEtNzAgY2hhcnMsIG5vIHNwYWNlcywgbm8gc3BlY2lhbCBjaGFyYWN0ZXJzXG4gIC8vIHRoYXQgd291bGQgcmVxdWlyZSBxdW90aW5nLiBXZSBtaXggYSB0aW1lc3RhbXAgYW5kIHR3byByYW5kb21cbiAgLy8gYmFzZS0zNiBzZWdtZW50cyB0byBrZWVwIHRoZSBib3VuZGFyeSB1bmlxdWUgcGVyIHJlcXVlc3QuXG4gIGNvbnN0IGJvdW5kYXJ5ID1cbiAgICBgLS0tLXpwaWMtJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX1gICtcbiAgICBgLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgMTApfWA7XG5cbiAgY29uc3QgZW5jb2RlciA9IG5ldyBUZXh0RW5jb2RlcigpO1xuICBjb25zdCBwYXJ0czogVWludDhBcnJheVtdID0gW107XG5cbiAgZm9yIChjb25zdCBmaWxlIG9mIGZpbGVzKSB7XG4gICAgY29uc3Qgc2FmZU5hbWUgPSBmaWxlLm5hbWUucmVwbGFjZSgvW1xcclxcblwiXS9nLCBcIl9cIik7XG4gICAgY29uc3QgZmlsZVR5cGUgPSBmaWxlLnR5cGUgfHwgZ3Vlc3NNaW1lVHlwZShmaWxlLm5hbWUpO1xuICAgIGNvbnN0IGhlYWRlciA9XG4gICAgICBgLS0ke2JvdW5kYXJ5fVxcclxcbmAgK1xuICAgICAgYENvbnRlbnQtRGlzcG9zaXRpb246IGZvcm0tZGF0YTsgbmFtZT1cImxpc3RcIjsgZmlsZW5hbWU9XCIke3NhZmVOYW1lfVwiXFxyXFxuYCArXG4gICAgICBgQ29udGVudC1UeXBlOiAke2ZpbGVUeXBlfVxcclxcblxcclxcbmA7XG4gICAgcGFydHMucHVzaChlbmNvZGVyLmVuY29kZShoZWFkZXIpKTtcbiAgICBwYXJ0cy5wdXNoKG5ldyBVaW50OEFycmF5KGF3YWl0IGZpbGUuYXJyYXlCdWZmZXIoKSkpO1xuICAgIHBhcnRzLnB1c2goZW5jb2Rlci5lbmNvZGUoXCJcXHJcXG5cIikpO1xuICB9XG4gIC8vIENsb3NpbmcgYm91bmRhcnk6IHNhbWUgcHJlZml4IGFzIHRoZSBwYXJ0IGRlbGltaXRlciwgdGhlblxuICAvLyBhbiBleHRyYSBgLS1gLlxuICBwYXJ0cy5wdXNoKGVuY29kZXIuZW5jb2RlKGAtLSR7Ym91bmRhcnl9LS1cXHJcXG5gKSk7XG5cbiAgLy8gQ29uY2F0ZW5hdGUgZXZlcnkgY2h1bmsgaW50byBvbmUgYnVmZmVyLiBVc2luZyBgc2V0YCBpbiBhXG4gIC8vIHNpbmdsZSBwYXNzIGlzIHJvdWdobHkgTyh0b3RhbCkgYW5kIGF2b2lkcyBhIHF1YWRyYXRpYyBjb3B5LlxuICBjb25zdCB0b3RhbCA9IHBhcnRzLnJlZHVjZSgoc3VtLCBwKSA9PiBzdW0gKyBwLmJ5dGVMZW5ndGgsIDApO1xuICBjb25zdCBib2R5ID0gbmV3IFVpbnQ4QXJyYXkodG90YWwpO1xuICBsZXQgb2Zmc2V0ID0gMDtcbiAgZm9yIChjb25zdCBwYXJ0IG9mIHBhcnRzKSB7XG4gICAgYm9keS5zZXQocGFydCwgb2Zmc2V0KTtcbiAgICBvZmZzZXQgKz0gcGFydC5ieXRlTGVuZ3RoO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBib2R5LFxuICAgIGNvbnRlbnRUeXBlOiBgbXVsdGlwYXJ0L2Zvcm0tZGF0YTsgYm91bmRhcnk9JHtib3VuZGFyeX1gLFxuICB9O1xufVxuIiwiLyoqXG4gKiBUeXBlIGRlZmluaXRpb25zIGZvciB0aGUgenBpYyBPYnNpZGlhbiBwbHVnaW4uXG4gKi9cblxuLyoqXG4gKiBQbHVnaW4gc2V0dGluZ3MgcGVyc2lzdGVkIGluIE9ic2lkaWFuJ3MgZGF0YSBBUEkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgWnBpY1NldHRpbmdzIHtcbiAgLyoqIHpwaWMgc2VydmVyIGJhc2UgVVJMIChkZWZhdWx0OiBodHRwOi8vMTI3LjAuMC4xOjM2Njc3KS4gKi9cbiAgc2VydmVyVXJsOiBzdHJpbmc7XG4gIC8qKiBBdXRvLXVwbG9hZCB3aGVuIHBhc3RpbmcgaW1hZ2VzIGZyb20gY2xpcGJvYXJkLiAqL1xuICB1cGxvYWRPblBhc3RlOiBib29sZWFuO1xuICAvKiogQXV0by11cGxvYWQgd2hlbiBkcmFnZ2luZyBpbWFnZSBmaWxlcyBpbnRvIHRoZSBlZGl0b3IuICovXG4gIHVwbG9hZE9uRHJvcDogYm9vbGVhbjtcbiAgLyoqIEhvdyB0byByZW5kZXIgdGhlIGFsdCB0ZXh0IGluIHRoZSBpbnNlcnRlZCBtYXJrZG93bi4gKi9cbiAgaW1hZ2VEZXNjOiBJbWFnZURlc2NNb2RlO1xuICAvKiogUmVtb3ZlIHRoZSBsb2NhbCB0ZW1wIGZpbGUgYWZ0ZXIgYSBzdWNjZXNzZnVsIHVwbG9hZC4gKi9cbiAgZGVsZXRlTG9jYWxBZnRlclVwbG9hZDogYm9vbGVhbjtcbiAgLyoqIFVwbG9hZCByZXF1ZXN0IHRpbWVvdXQgaW4gbWlsbGlzZWNvbmRzLiAqL1xuICB0aW1lb3V0OiBudW1iZXI7XG59XG5cbmV4cG9ydCB0eXBlIEltYWdlRGVzY01vZGUgPSAnb3JpZ2luJyB8ICdub25lJztcblxuLyoqXG4gKiBTZXJ2ZXIgcmVzcG9uc2Ugc2hhcGUsIG1hdGNoZXMgdGhlIFBpY0dvLWNvbXBhdGlibGUgY29udHJhY3QgZGVzY3JpYmVkXG4gKiBpbiBvcGVuc3BlYy9jaGFuZ2VzL2FkZC1odHRwLXNlcnZlci1mb3Itb2JzaWRpYW4vc3BlY3MvYXBpLXNwZWNpZmljYXRpb24ubWQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgVXBsb2FkUmVzcG9uc2Uge1xuICBzdWNjZXNzOiBib29sZWFuO1xuICAvKiogQXJyYXkgb2YgdXBsb2FkZWQgaW1hZ2UgVVJMcyAocGFyYWxsZWwgdG8gdGhlIHJlcXVlc3QgbGlzdCkuICovXG4gIHJlc3VsdD86IHN0cmluZ1tdO1xuICAvKiogT3B0aW9uYWwgZXh0ZW5kZWQgbWV0YWRhdGEgd2l0aCBkZWxldGUgVVJMcywgZXRjLiAqL1xuICBmdWxsUmVzdWx0PzogVXBsb2FkUmVzdWx0SXRlbVtdO1xuICAvKiogSHVtYW4tcmVhZGFibGUgZXJyb3IgbWVzc2FnZS4gKi9cbiAgbXNnPzogc3RyaW5nO1xuICAvKiogTWFjaGluZS1yZWFkYWJsZSBlcnJvciBjb2RlLiAqL1xuICBjb2RlPzogVXBsb2FkRXJyb3JDb2RlO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFVwbG9hZFJlc3VsdEl0ZW0ge1xuICBpbWdVcmw6IHN0cmluZztcbiAgLyoqIE9wdGlvbmFsIGRlbGV0ZSBVUkwgd2hlbiB0aGUgdXBsb2FkZXIgc3VwcG9ydHMgZGVsZXRpb24uICovXG4gIGRlbGV0ZT86IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgVXBsb2FkRXJyb3JDb2RlID1cbiAgfCAnSU5WQUxJRF9GSUxFX1RZUEUnXG4gIHwgJ0ZJTEVfTk9UX0ZPVU5EJ1xuICB8ICdVUExPQURfRkFJTEVEJ1xuICB8ICdDT05GSUdfRVJST1InXG4gIHwgJ1NFUlZFUl9FUlJPUic7XG5cbi8qKiBIZWFsdGggY2hlY2sgcmVzcG9uc2UuICovXG5leHBvcnQgaW50ZXJmYWNlIEhlYWx0aFJlc3BvbnNlIHtcbiAgc3RhdHVzOiAnb2snIHwgc3RyaW5nO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIHVwdGltZTogbnVtYmVyO1xufVxuXG4vKiogU2VydmVyIGNvbmZpZ3VyYXRpb24gb3ZlcnZpZXcgKG5vbi1zZW5zaXRpdmUpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTZXJ2ZXJDb25maWdSZXNwb25zZSB7XG4gIGN1cnJlbnRVcGxvYWRlcjogc3RyaW5nO1xuICB1cGxvYWRlcnM6IHN0cmluZ1tdO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG59XG5cbi8qKiBBIHBsYWNlaG9sZGVyIHJvdyB1c2VkIHRvIHRyYWNrIGFuIGluLWZsaWdodCB1cGxvYWQgaW5zaWRlIHRoZSBlZGl0b3IuICovXG5leHBvcnQgaW50ZXJmYWNlIFVwbG9hZFBsYWNlaG9sZGVyIHtcbiAgLyoqIFVuaXF1ZSBpZGVudGlmaWVyIGVtYmVkZGVkIGluIHRoZSBwbGFjZWhvbGRlciBtYXJrZG93bi4gKi9cbiAgaWQ6IHN0cmluZztcbiAgLyoqIE9yaWdpbmFsIGZpbGUgbmFtZSAodXNlZCBhcyBhbHQgdGV4dCkuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIFRoZSBGaWxlIG9iamVjdCB0byB1cGxvYWQuICovXG4gIGZpbGU6IEZpbGU7XG59XG5cbi8qKlxuICogRnJvbnRtYXR0ZXIga2V5cyB0aGF0IGFsbG93IGRpc2FibGluZyBwZXItbm90ZSB1cGxvYWRzLlxuICogYHpwaWMtdXBsb2FkOiBmYWxzZWAgaW4gdGhlIFlBTUwgZnJvbnRtYXR0ZXIgZGlzYWJsZXMgYXV0by11cGxvYWQuXG4gKi9cbmV4cG9ydCBjb25zdCBGUk9OVE1BVFRFUl9ESVNBQkxFX0tFWSA9ICd6cGljLXVwbG9hZCc7XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NFVFRJTkdTOiBacGljU2V0dGluZ3MgPSB7XG4gIHNlcnZlclVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6MzY2NzcnLFxuICB1cGxvYWRPblBhc3RlOiB0cnVlLFxuICB1cGxvYWRPbkRyb3A6IHRydWUsXG4gIGltYWdlRGVzYzogJ29yaWdpbicsXG4gIGRlbGV0ZUxvY2FsQWZ0ZXJVcGxvYWQ6IGZhbHNlLFxuICB0aW1lb3V0OiAzMDAwMCxcbn07XG4iLCIvKipcbiAqIFNldHRpbmdzIHRhYiBmb3IgdGhlIHpwaWMgcGx1Z2luLlxuICpcbiAqIFRoZSBwbHVnaW4gc2V0dGluZ3MgYW5kIHRoZSBgWnBpY1NldHRpbmdUYWJgIGNsYXNzIGxpdmUgaW4gdGhlaXIgb3duXG4gKiBtb2R1bGUgc28gdGhhdCBgbWFpbi50c2Agc3RheXMgZm9jdXNlZCBvbiBldmVudCBoYW5kbGluZy4gVGhlIHRhYlxuICogdXNlcyB0aGUgc3RhbmRhcmQgT2JzaWRpYW4gYFNldHRpbmdgIGJ1aWxkZXIgdG8gcmVuZGVyIGlucHV0cyB0aGF0XG4gKiBtYXRjaCB0aGUgbG9vayBhbmQgZmVlbCBvZiB0aGUgcmVzdCBvZiB0aGUgc2V0dGluZ3MgcGFuZWwuXG4gKi9cblxuaW1wb3J0IHsgQXBwLCBOb3RpY2UsIFBsdWdpblNldHRpbmdUYWIsIFNldHRpbmcgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgdHlwZSBacGljUGx1Z2luIGZyb20gJy4vbWFpbic7XG5pbXBvcnQgeyBzaG93Tm90aWNlLCBacGljVXBsb2FkZXIgfSBmcm9tICcuL3VwbG9hZGVyJztcbmltcG9ydCB0eXBlIHsgSW1hZ2VEZXNjTW9kZSwgWnBpY1NldHRpbmdzIH0gZnJvbSAnLi90eXBlcyc7XG5pbXBvcnQgeyBERUZBVUxUX1NFVFRJTkdTIH0gZnJvbSAnLi90eXBlcyc7XG5cbmNvbnN0IFNFUlZFUl9VUkxfUEFUVEVSTiA9IC9eaHR0cHM/OlxcL1xcLy4rL2k7XG5cbmV4cG9ydCBjbGFzcyBacGljU2V0dGluZ1RhYiBleHRlbmRzIFBsdWdpblNldHRpbmdUYWIge1xuICBwcml2YXRlIHBsdWdpbjogWnBpY1BsdWdpbjtcbiAgLyoqIFJldXNlZCBwcm9iZSB0byB2YWxpZGF0ZSB0aGUgc2VydmVyIFVSTCB3aXRob3V0IGxlYWtpbmcgc3RhdGUuICovXG4gIHByaXZhdGUgcHJvYmU6IFpwaWNVcGxvYWRlciB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IFpwaWNQbHVnaW4pIHtcbiAgICBzdXBlcihhcHAsIHBsdWdpbik7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBkaXNwbGF5KCk6IHZvaWQge1xuICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgY29udGFpbmVyRWwuZW1wdHkoKTtcblxuICAgIGNvbnRhaW5lckVsLmNyZWF0ZUVsKCdoMicsIHsgdGV4dDogJ1pwaWMgaW1hZ2UgdXBsb2FkJyB9KTtcblxuICAgIGNvbnRhaW5lckVsLmNyZWF0ZUVsKCdwJywge1xuICAgICAgdGV4dDpcbiAgICAgICAgJ3pwaWMgdXBsb2FkcyBpbWFnZXMgdG8geW91ciBjb25maWd1cmVkIGhvc3QgKEdpdEh1YiwgUzMsIE9TUywgJyArXG4gICAgICAgICdsb2NhbCwgLi4uKSBhbmQgaW5zZXJ0cyB0aGUgcmVzdWx0aW5nIFVSTCBpbnRvIHRoZSBjdXJyZW50IG5vdGUuICcgK1xuICAgICAgICAnTWFrZSBzdXJlIHRoZSB6cGljIHNlcnZlciBpcyBydW5uaW5nIGJlZm9yZSB1c2luZyB0aGUgcGx1Z2luLicsXG4gICAgICBjbHM6ICdzZXR0aW5nLWl0ZW0tZGVzY3JpcHRpb24nLFxuICAgIH0pO1xuXG4gICAgdGhpcy5yZW5kZXJTZXJ2ZXJTZWN0aW9uKGNvbnRhaW5lckVsKTtcbiAgICB0aGlzLnJlbmRlckJlaGF2aW9yU2VjdGlvbihjb250YWluZXJFbCk7XG4gICAgdGhpcy5yZW5kZXJEaWFnbm9zdGljc1NlY3Rpb24oY29udGFpbmVyRWwpO1xuICB9XG5cbiAgLyoqIFNlcnZlciBVUkwgKyB0aW1lb3V0LiAqL1xuICBwcml2YXRlIHJlbmRlclNlcnZlclNlY3Rpb24oY29udGFpbmVyRWw6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gICAgY29udGFpbmVyRWwuY3JlYXRlRWwoJ2gzJywgeyB0ZXh0OiAnU2VydmVyJyB9KTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoJ1NlcnZlciBVUkwnKVxuICAgICAgLnNldERlc2MoJ0Jhc2UgVVJMIG9mIHRoZSBydW5uaW5nIHpwaWMgc2VydmVyIChkZWZhdWx0OiBodHRwOi8vMTI3LjAuMC4xOjM2Njc3KS4nKVxuICAgICAgLmFkZFRleHQoKHRleHQpID0+IHtcbiAgICAgICAgdGV4dFxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcignaHR0cDovLzEyNy4wLjAuMTozNjY3NycpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnNlcnZlclVybClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0cmltbWVkID0gdmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgaWYgKHRyaW1tZWQgJiYgIVNFUlZFUl9VUkxfUEFUVEVSTi50ZXN0KHRyaW1tZWQpKSB7XG4gICAgICAgICAgICAgIHNob3dOb3RpY2UoJ1NlcnZlciBVUkwgbXVzdCBzdGFydCB3aXRoIGh0dHA6Ly8gb3IgaHR0cHM6Ly8nKTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Muc2VydmVyVXJsID0gdHJpbW1lZCB8fCBERUZBVUxUX1NFVFRJTkdTLnNlcnZlclVybDtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB0ZXh0LmlucHV0RWwuc3R5bGUud2lkdGggPSAnMTAwJSc7XG4gICAgICB9KTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoJ1JlcXVlc3QgdGltZW91dCcpXG4gICAgICAuc2V0RGVzYygnTWF4aW11bSB0aW1lIHRvIHdhaXQgZm9yIGEgc2luZ2xlIHVwbG9hZCAobWlsbGlzZWNvbmRzKS4nKVxuICAgICAgLmFkZFRleHQoKHRleHQpID0+IHtcbiAgICAgICAgdGV4dFxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcignMzAwMDAnKVxuICAgICAgICAgIC5zZXRWYWx1ZShTdHJpbmcodGhpcy5wbHVnaW4uc2V0dGluZ3MudGltZW91dCkpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcGFyc2VkID0gTnVtYmVyLnBhcnNlSW50KHZhbHVlLCAxMCk7XG4gICAgICAgICAgICBpZiAoTnVtYmVyLmlzTmFOKHBhcnNlZCkgfHwgcGFyc2VkIDw9IDApIHtcbiAgICAgICAgICAgICAgc2hvd05vdGljZSgnVGltZW91dCBtdXN0IGJlIGEgcG9zaXRpdmUgbnVtYmVyJyk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnRpbWVvdXQgPSBwYXJzZWQ7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuICB9XG5cbiAgLyoqIFBhc3RlIC8gZHJvcCBiZWhhdmlvdXIgKyBtYXJrZG93biBmb3JtYXR0aW5nLiAqL1xuICBwcml2YXRlIHJlbmRlckJlaGF2aW9yU2VjdGlvbihjb250YWluZXJFbDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgICBjb250YWluZXJFbC5jcmVhdGVFbCgnaDMnLCB7IHRleHQ6ICdCZWhhdmlvdXInIH0pO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnVXBsb2FkIG9uIHBhc3RlJylcbiAgICAgIC5zZXREZXNjKCdBdXRvbWF0aWNhbGx5IHVwbG9hZCBpbWFnZXMgcGFzdGVkIGZyb20gdGhlIGNsaXBib2FyZC4nKVxuICAgICAgLmFkZFRvZ2dsZSgodG9nZ2xlKSA9PlxuICAgICAgICB0b2dnbGVcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MudXBsb2FkT25QYXN0ZSlcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy51cGxvYWRPblBhc3RlID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoJ1VwbG9hZCBvbiBkcm9wJylcbiAgICAgIC5zZXREZXNjKFxuICAgICAgICAnQXV0b21hdGljYWxseSB1cGxvYWQgaW1hZ2UgZmlsZXMgZHJhZ2dlZCBpbnRvIHRoZSBlZGl0b3IuICcgK1xuICAgICAgICAgICdIb2xkIEN0cmwvQ21kIHdoaWxlIGRyb3BwaW5nIHRvIGtlZXAgT2JzaWRpYW5cXCdzIGRlZmF1bHQgYmVoYXZpb3VyLidcbiAgICAgIClcbiAgICAgIC5hZGRUb2dnbGUoKHRvZ2dsZSkgPT5cbiAgICAgICAgdG9nZ2xlXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnVwbG9hZE9uRHJvcClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy51cGxvYWRPbkRyb3AgPSB2YWx1ZTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZSgnSW1hZ2UgZGVzY3JpcHRpb24nKVxuICAgICAgLnNldERlc2MoJ0hvdyB0byByZW5kZXIgYWx0IHRleHQgaW4gdGhlIGluc2VydGVkIG1hcmtkb3duLicpXG4gICAgICAuYWRkRHJvcGRvd24oKGRyb3Bkb3duKSA9PlxuICAgICAgICBkcm9wZG93blxuICAgICAgICAgIC5hZGRPcHRpb24oJ29yaWdpbicsICdPcmlnaW5hbCBmaWxlbmFtZScpXG4gICAgICAgICAgLmFkZE9wdGlvbignbm9uZScsICdFbXB0eSBhbHQgdGV4dCcpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmltYWdlRGVzYylcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5pbWFnZURlc2MgPSB2YWx1ZSBhcyBJbWFnZURlc2NNb2RlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKCdEZWxldGUgbG9jYWwgZmlsZSBhZnRlciB1cGxvYWQnKVxuICAgICAgLnNldERlc2MoXG4gICAgICAgICdSZW1vdmUgdGhlIGxvY2FsIHNvdXJjZSBmaWxlIG9uY2UgdGhlIHVwbG9hZCBjb21wbGV0ZXMuICcgK1xuICAgICAgICAgICdPbmx5IGFwcGxpZXMgdG8gZmlsZXMgdGhlIHBsdWdpbiBpcyByZXNwb25zaWJsZSBmb3IgKGUuZy4gY2xpcGJvYXJkIHBhc3RlcykuJ1xuICAgICAgKVxuICAgICAgLmFkZFRvZ2dsZSgodG9nZ2xlKSA9PlxuICAgICAgICB0b2dnbGVcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuZGVsZXRlTG9jYWxBZnRlclVwbG9hZClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5kZWxldGVMb2NhbEFmdGVyVXBsb2FkID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcbiAgfVxuXG4gIC8qKiBIZWFsdGggcHJvYmUgKyBjb25maWcgZHVtcCBmb3Igc2FuaXR5LWNoZWNraW5nIHRoZSBzZXJ2ZXIuICovXG4gIHByaXZhdGUgcmVuZGVyRGlhZ25vc3RpY3NTZWN0aW9uKGNvbnRhaW5lckVsOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICAgIGNvbnRhaW5lckVsLmNyZWF0ZUVsKCdoMycsIHsgdGV4dDogJ0RpYWdub3N0aWNzJyB9KTtcblxuICAgIGNvbnN0IHN0YXR1c0VsID0gY29udGFpbmVyRWwuY3JlYXRlRWwoJ2RpdicsIHtcbiAgICAgIGNsczogJ3pwaWMtc3RhdHVzJyxcbiAgICAgIHRleHQ6ICdDbGljayBcIkNoZWNrIHNlcnZlclwiIHRvIHRlc3QgdGhlIGNvbm5lY3Rpb24uJyxcbiAgICB9KTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoJ0NoZWNrIHNlcnZlcicpXG4gICAgICAuc2V0RGVzYygnVmVyaWZ5IHRoZSBzZXJ2ZXIgaXMgcmVhY2hhYmxlIGFuZCByZXBvcnQgdGhlIGFjdGl2ZSB1cGxvYWRlci4nKVxuICAgICAgLmFkZEJ1dHRvbigoYnV0dG9uKSA9PlxuICAgICAgICBidXR0b25cbiAgICAgICAgICAuc2V0QnV0dG9uVGV4dCgnQ2hlY2sgc2VydmVyJylcbiAgICAgICAgICAuc2V0Q3RhKClcbiAgICAgICAgICAub25DbGljayhhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICBzdGF0dXNFbC5zZXRUZXh0KCdDaGVja2luZ+KApicpO1xuICAgICAgICAgICAgY29uc3QgcHJvYmUgPSB0aGlzLnByb2JlID8/IG5ldyBacGljVXBsb2FkZXIodGhpcy5wbHVnaW4uc2V0dGluZ3MpO1xuICAgICAgICAgICAgdGhpcy5wcm9iZSA9IHByb2JlO1xuICAgICAgICAgICAgcHJvYmUudXBkYXRlU2V0dGluZ3ModGhpcy5wbHVnaW4uc2V0dGluZ3MpO1xuXG4gICAgICAgICAgICBjb25zdCBoZWFsdGh5ID0gYXdhaXQgcHJvYmUuY2hlY2tIZWFsdGgoKTtcbiAgICAgICAgICAgIGlmICghaGVhbHRoeSkge1xuICAgICAgICAgICAgICBzdGF0dXNFbC5zZXRUZXh0KFxuICAgICAgICAgICAgICAgICdTZXJ2ZXIgaXMgdW5yZWFjaGFibGUuIFJ1biBgenBpYyBzZXJ2ZXIgc3RhcnRgIGluIGEgdGVybWluYWwuJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICBuZXcgTm90aWNlKCdDYW5ub3QgY29ubmVjdCB0byB6cGljIHNlcnZlcicsIDUwMDApO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGNvbmZpZyA9IGF3YWl0IHByb2JlLmdldENvbmZpZygpO1xuICAgICAgICAgICAgaWYgKCFjb25maWcpIHtcbiAgICAgICAgICAgICAgc3RhdHVzRWwuc2V0VGV4dCgnU2VydmVyIGlzIGhlYWx0aHkgYnV0IC9jb25maWcgaXMgdW5hdmFpbGFibGUuJyk7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHN0YXR1c0VsLnNldFRleHQoXG4gICAgICAgICAgICAgIGBPSyDCtyB1cGxvYWRlcjogJHtjb25maWcuY3VycmVudFVwbG9hZGVyfSBgICtcbiAgICAgICAgICAgICAgICBgKCR7Y29uZmlnLnVwbG9hZGVycy5sZW5ndGh9IGF2YWlsYWJsZSkgwrcgenBpYyB2JHtjb25maWcudmVyc2lvbn1gXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pXG4gICAgICApO1xuICB9XG59XG5cbi8qKiBQZXJzaXN0ZWQtc2hhcGUgdmFsaWRhdGlvbiBmb3IgbG9hZGVkIHNldHRpbmdzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVNldHRpbmdzKFxuICByYXc6IFBhcnRpYWw8WnBpY1NldHRpbmdzPiB8IHVuZGVmaW5lZCB8IG51bGxcbik6IFpwaWNTZXR0aW5ncyB7XG4gIGNvbnN0IG1lcmdlZDogWnBpY1NldHRpbmdzID0geyAuLi5ERUZBVUxUX1NFVFRJTkdTLCAuLi4ocmF3ID8/IHt9KSB9O1xuXG4gIGlmICh0eXBlb2YgbWVyZ2VkLnNlcnZlclVybCAhPT0gJ3N0cmluZycgfHwgbWVyZ2VkLnNlcnZlclVybC5sZW5ndGggPT09IDApIHtcbiAgICBtZXJnZWQuc2VydmVyVXJsID0gREVGQVVMVF9TRVRUSU5HUy5zZXJ2ZXJVcmw7XG4gIH1cbiAgaWYgKG1lcmdlZC5pbWFnZURlc2MgIT09ICdvcmlnaW4nICYmIG1lcmdlZC5pbWFnZURlc2MgIT09ICdub25lJykge1xuICAgIG1lcmdlZC5pbWFnZURlc2MgPSBERUZBVUxUX1NFVFRJTkdTLmltYWdlRGVzYztcbiAgfVxuICBpZiAodHlwZW9mIG1lcmdlZC50aW1lb3V0ICE9PSAnbnVtYmVyJyB8fCBtZXJnZWQudGltZW91dCA8PSAwKSB7XG4gICAgbWVyZ2VkLnRpbWVvdXQgPSBERUZBVUxUX1NFVFRJTkdTLnRpbWVvdXQ7XG4gIH1cblxuICByZXR1cm4gbWVyZ2VkO1xufVxuIiwiLyoqXG4gKiB6cGljIEltYWdlIFVwbG9hZCDigJQgT2JzaWRpYW4gcGx1Z2luIGVudHJ5IHBvaW50LlxuICpcbiAqIExpc3RlbnMgZm9yIGVkaXRvciBwYXN0ZSBhbmQgZHJvcCBldmVudHMsIHNlbmRzIGFueSBpbWFnZSBmaWxlcyB0byB0aGVcbiAqIHJ1bm5pbmcgenBpYyBzZXJ2ZXIsIGFuZCByZXBsYWNlcyBhIHRlbXBvcmFyeSBgIVtVcGxvYWRpbmfigKZdKClgIHJvdyBpblxuICogdGhlIGRvY3VtZW50IHdpdGggdGhlIGZpbmFsIHVwbG9hZGVkIFVSTC5cbiAqXG4gKiBUaGUgcGx1Z2luIGlzIGludGVudGlvbmFsbHkgdGhpbjogdGhlIGhlYXZ5IGxpZnRpbmcgKG5ldHdvcmssIHJldHJ5LFxuICogdXBsb2FkZXIgc2VsZWN0aW9uLCBoaXN0b3J5KSBsaXZlcyBpbnNpZGUgdGhlIHpwaWMgc2VydmVyIGl0c2VsZi4gU2VlXG4gKiBgb3BlbnNwZWMvY2hhbmdlcy9hZGQtaHR0cC1zZXJ2ZXItZm9yLW9ic2lkaWFuYCBmb3IgdGhlIGZ1bGwgZGVzaWduLlxuICovXG5cbmltcG9ydCB7XG4gIEVkaXRvcixcbiAgTWFya2Rvd25WaWV3LFxuICBQbHVnaW4sXG4gIFRGaWxlLFxuICB0eXBlIENhY2hlZE1ldGFkYXRhLFxufSBmcm9tIFwib2JzaWRpYW5cIjtcbmltcG9ydCB7IFpwaWNTZXR0aW5nVGFiLCBub3JtYWxpemVTZXR0aW5ncyB9IGZyb20gXCIuL3NldHRpbmdzXCI7XG5pbXBvcnQgeyBacGljVXBsb2FkZXIsIHNob3dOb3RpY2UgfSBmcm9tIFwiLi91cGxvYWRlclwiO1xuaW1wb3J0IHtcbiAgREVGQVVMVF9TRVRUSU5HUyxcbiAgRlJPTlRNQVRURVJfRElTQUJMRV9LRVksXG4gIHR5cGUgVXBsb2FkUmVzcG9uc2UsXG4gIHR5cGUgWnBpY1NldHRpbmdzLFxufSBmcm9tIFwiLi90eXBlc1wiO1xuaW1wb3J0IHtcbiAgZm9ybWF0SW1hZ2VNYXJrZG93bixcbiAgZ2VuZXJhdGVQbGFjZWhvbGRlcklkLFxuICBnZXRQbGFjZWhvbGRlclRleHQsXG4gIGd1ZXNzTWltZVR5cGUsXG4gIGlzSW1hZ2VGaWxlLFxufSBmcm9tIFwiLi91dGlsc1wiO1xuXG5jb25zdCBDT01NQU5EX1VQTE9BRF9GUk9NX0NMSVBCT0FSRCA9IFwidXBsb2FkLWltYWdlLWZyb20tY2xpcGJvYXJkXCI7XG5jb25zdCBDT01NQU5EX1VQTE9BRF9GUk9NX1ZBVUxUID0gXCJ1cGxvYWQtaW1hZ2UtZnJvbS12YXVsdFwiO1xuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBacGljUGx1Z2luIGV4dGVuZHMgUGx1Z2luIHtcbiAgc2V0dGluZ3MhOiBacGljU2V0dGluZ3M7XG4gIHVwbG9hZGVyITogWnBpY1VwbG9hZGVyO1xuXG4gIGFzeW5jIG9ubG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLmxvYWRTZXR0aW5ncygpO1xuICAgIHRoaXMudXBsb2FkZXIgPSBuZXcgWnBpY1VwbG9hZGVyKHRoaXMuc2V0dGluZ3MpO1xuXG4gICAgdGhpcy5hZGRTZXR0aW5nVGFiKG5ldyBacGljU2V0dGluZ1RhYih0aGlzLmFwcCwgdGhpcykpO1xuXG4gICAgLy8gUGFzdGUgaGFuZGxlciDigJQgYXV0by11cGxvYWRzIGltYWdlcyBjb21pbmcgZnJvbSB0aGUgT1MgY2xpcGJvYXJkLlxuICAgIHRoaXMucmVnaXN0ZXJFdmVudChcbiAgICAgIHRoaXMuYXBwLndvcmtzcGFjZS5vbihcbiAgICAgICAgXCJlZGl0b3ItcGFzdGVcIixcbiAgICAgICAgKGV2dDogQ2xpcGJvYXJkRXZlbnQsIGVkaXRvcjogRWRpdG9yLCB2aWV3OiBNYXJrZG93blZpZXcpID0+IHtcbiAgICAgICAgICB2b2lkIHRoaXMuaGFuZGxlUGFzdGUoZXZ0LCBlZGl0b3IsIHZpZXcpO1xuICAgICAgICB9LFxuICAgICAgKSxcbiAgICApO1xuXG4gICAgLy8gRHJvcCBoYW5kbGVyIOKAlCBhdXRvLXVwbG9hZHMgaW1hZ2VzIGRyb3BwZWQgZnJvbSB0aGUgZmlsZSBzeXN0ZW0uXG4gICAgdGhpcy5yZWdpc3RlckV2ZW50KFxuICAgICAgdGhpcy5hcHAud29ya3NwYWNlLm9uKFxuICAgICAgICBcImVkaXRvci1kcm9wXCIsXG4gICAgICAgIChldnQ6IERyYWdFdmVudCwgZWRpdG9yOiBFZGl0b3IsIHZpZXc6IE1hcmtkb3duVmlldykgPT4ge1xuICAgICAgICAgIHZvaWQgdGhpcy5oYW5kbGVEcm9wKGV2dCwgZWRpdG9yLCB2aWV3KTtcbiAgICAgICAgfSxcbiAgICAgICksXG4gICAgKTtcblxuICAgIC8vIFJpYmJvbiBpY29uIGZvciB1c2VycyB3aG8gcHJlZmVyIGNsaWNraW5nIG92ZXIgcGFzdGluZy9kcm9wcGluZy5cbiAgICB0aGlzLmFkZFJpYmJvbkljb24oXG4gICAgICBcInVwbG9hZC1nbHlwaFwiLFxuICAgICAgXCJ6cGljOiB1cGxvYWQgaW1hZ2UgZnJvbSBjbGlwYm9hcmRcIixcbiAgICAgICgpID0+IHtcbiAgICAgICAgdm9pZCB0aGlzLnVwbG9hZEZyb21DbGlwYm9hcmQoKTtcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogQ09NTUFORF9VUExPQURfRlJPTV9DTElQQk9BUkQsXG4gICAgICBuYW1lOiBcIlVwbG9hZCBpbWFnZSBmcm9tIGNsaXBib2FyZFwiLFxuICAgICAgZWRpdG9yQ2FsbGJhY2s6IChlZGl0b3I6IEVkaXRvcikgPT4ge1xuICAgICAgICB2b2lkIHRoaXMudXBsb2FkRnJvbUNsaXBib2FyZChlZGl0b3IpO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogQ09NTUFORF9VUExPQURfRlJPTV9WQVVMVCxcbiAgICAgIG5hbWU6IFwiVXBsb2FkIGN1cnJlbnQgaW1hZ2UgYXR0YWNobWVudFwiLFxuICAgICAgZWRpdG9yQ2hlY2tDYWxsYmFjazogKGNoZWNraW5nLCBlZGl0b3IsIGN0eCkgPT4ge1xuICAgICAgICAvLyBRdWljayBsb29rdXA6IGEgY2FuZGlkYXRlIGltYWdlIGlzIHJlYWNoYWJsZSB2aWEgdGhlIGN1cnJlbnRcbiAgICAgICAgLy8gc2VsZWN0aW9uIHdpdGhvdXQgcmVhZGluZyBhbnkgYnl0ZXMuIFRoZSBhY3R1YWwgdXBsb2FkIGlzXG4gICAgICAgIC8vIGtpY2tlZCBvZmYgaW4gdGhlIG5vbi1jaGVja2luZyBicmFuY2guIGBjdHhgIG1heSBiZSBhXG4gICAgICAgIC8vIGBNYXJrZG93blZpZXdgIChlZGl0b3IgY29tbWFuZHMpIG9yIGEgYE1hcmtkb3duRmlsZUluZm9gXG4gICAgICAgIC8vIChmaWxlLW1lbnUgY29tbWFuZHMpOyB3ZSBvbmx5IG5lZWQgdGhlIHZpZXcgZm9yIHRoZSBlZGl0b3JcbiAgICAgICAgLy8gc2VsZWN0aW9uLlxuICAgICAgICBjb25zdCB2aWV3ID0gY3R4IGluc3RhbmNlb2YgTWFya2Rvd25WaWV3ID8gY3R4IDogbnVsbDtcbiAgICAgICAgY29uc3QgY2FuZGlkYXRlID0gdGhpcy5maW5kSW1hZ2VSZWZlcmVuY2UodmlldywgZWRpdG9yKTtcbiAgICAgICAgaWYgKGNoZWNraW5nKSByZXR1cm4gY2FuZGlkYXRlICE9PSBudWxsO1xuICAgICAgICBpZiAoY2FuZGlkYXRlKSB7XG4gICAgICAgICAgdm9pZCB0aGlzLnVwbG9hZFJlZmVyZW5jZWRJbWFnZShlZGl0b3IsIGNhbmRpZGF0ZSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc29sZS5pbmZvKFwiW3pwaWNdIHBsdWdpbiBsb2FkZWRcIik7XG4gIH1cblxuICBvbnVubG9hZCgpOiB2b2lkIHtcbiAgICBjb25zb2xlLmluZm8oXCJbenBpY10gcGx1Z2luIHVubG9hZGVkXCIpO1xuICB9XG5cbiAgYXN5bmMgbG9hZFNldHRpbmdzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHJhdyA9IChhd2FpdCB0aGlzLmxvYWREYXRhKCkpIGFzIFBhcnRpYWw8WnBpY1NldHRpbmdzPiB8IG51bGw7XG4gICAgdGhpcy5zZXR0aW5ncyA9IG5vcm1hbGl6ZVNldHRpbmdzKHJhdyA/PyBERUZBVUxUX1NFVFRJTkdTKTtcbiAgfVxuXG4gIGFzeW5jIHNhdmVTZXR0aW5ncygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLnNhdmVEYXRhKHRoaXMuc2V0dGluZ3MpO1xuICAgIC8vIEtlZXAgdGhlIHVwbG9hZGVyIGluIHN5bmMgd2l0aCB0aGUgbGF0ZXN0IHNldHRpbmdzIHNvIHN1YnNlcXVlbnRcbiAgICAvLyB1cGxvYWRzIGRvbid0IGhhdmUgdG8gd2FpdCBmb3IgdGhlIG5leHQgb25sb2FkIGN5Y2xlLlxuICAgIHRoaXMudXBsb2FkZXI/LnVwZGF0ZVNldHRpbmdzKHRoaXMuc2V0dGluZ3MpO1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIEV2ZW50IGhhbmRsZXJzXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIHByaXZhdGUgYXN5bmMgaGFuZGxlUGFzdGUoXG4gICAgZXZ0OiBDbGlwYm9hcmRFdmVudCxcbiAgICBlZGl0b3I6IEVkaXRvcixcbiAgICBfdmlldzogTWFya2Rvd25WaWV3LFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIXRoaXMuc2V0dGluZ3MudXBsb2FkT25QYXN0ZSkgcmV0dXJuO1xuICAgIGlmICh0aGlzLmlzVXBsb2FkRGlzYWJsZWRJbkZyb250bWF0dGVyKCkpIHJldHVybjtcblxuICAgIGNvbnN0IGZpbGVzID0gZXZ0LmNsaXBib2FyZERhdGE/LmZpbGVzO1xuICAgIGlmICghZmlsZXMgfHwgZmlsZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICBjb25zdCBpbWFnZUZpbGVzID0gQXJyYXkuZnJvbShmaWxlcykuZmlsdGVyKGlzSW1hZ2VGaWxlKTtcbiAgICBpZiAoaW1hZ2VGaWxlcy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIC8vIE9ubHkgaW50ZXJjZXB0IHRoZSBwYXN0ZSBvbmNlIHdlIGFyZSBzdXJlIHRoZXJlIGlzIGFuIGltYWdlIHRvXG4gICAgLy8gdXBsb2FkLCBzbyBwYXN0aW5nIHBsYWluIHRleHQgc3RpbGwgd29ya3MuXG4gICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgZXZ0LnN0b3BQcm9wYWdhdGlvbigpO1xuXG4gICAgYXdhaXQgdGhpcy51cGxvYWRBbmRJbnNlcnQoZWRpdG9yLCBpbWFnZUZpbGVzKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgaGFuZGxlRHJvcChcbiAgICBldnQ6IERyYWdFdmVudCxcbiAgICBlZGl0b3I6IEVkaXRvcixcbiAgICBfdmlldzogTWFya2Rvd25WaWV3LFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIXRoaXMuc2V0dGluZ3MudXBsb2FkT25Ecm9wKSByZXR1cm47XG4gICAgaWYgKHRoaXMuaXNVcGxvYWREaXNhYmxlZEluRnJvbnRtYXR0ZXIoKSkgcmV0dXJuO1xuICAgIC8vIFByZXNlcnZlIE9ic2lkaWFuJ3MgZGVmYXVsdCBkcmFnLXRvLWF0dGFjaCBiZWhhdmlvdXIgd2hlbiB0aGVcbiAgICAvLyB1c2VyIGV4cGxpY2l0bHkgb3B0cyBvdXQgdmlhIG1vZGlmaWVyIGtleS5cbiAgICBpZiAoZXZ0LmN0cmxLZXkgfHwgZXZ0Lm1ldGFLZXkpIHJldHVybjtcblxuICAgIGNvbnN0IGZpbGVzID0gZXZ0LmRhdGFUcmFuc2Zlcj8uZmlsZXM7XG4gICAgaWYgKCFmaWxlcyB8fCBmaWxlcy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIGNvbnN0IGltYWdlRmlsZXMgPSBBcnJheS5mcm9tKGZpbGVzKS5maWx0ZXIoaXNJbWFnZUZpbGUpO1xuICAgIGlmIChpbWFnZUZpbGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgZXZ0LnByZXZlbnREZWZhdWx0KCk7XG4gICAgZXZ0LnN0b3BQcm9wYWdhdGlvbigpO1xuXG4gICAgYXdhaXQgdGhpcy51cGxvYWRBbmRJbnNlcnQoZWRpdG9yLCBpbWFnZUZpbGVzKTtcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBDb3JlIHVwbG9hZCBwaXBlbGluZVxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICAvKipcbiAgICogSW5zZXJ0IHBsYWNlaG9sZGVycyBmb3IgZWFjaCBmaWxlLCBraWNrIG9mZiB0aGUgdXBsb2FkLCBhbmQgdGhlblxuICAgKiByZXBsYWNlIHRoZSBwbGFjZWhvbGRlcnMgd2l0aCB0aGUgcmV0dXJuZWQgVVJMcyAob3IgYW4gZXJyb3Igcm93XG4gICAqIG9uIGZhaWx1cmUpLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyB1cGxvYWRBbmRJbnNlcnQoXG4gICAgZWRpdG9yOiBFZGl0b3IsXG4gICAgZmlsZXM6IEZpbGVbXSxcbiAgKTogUHJvbWlzZTxVcGxvYWRSZXNwb25zZSB8IG51bGw+IHtcbiAgICBpZiAoZmlsZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IGhlYWx0aHkgPSBhd2FpdCB0aGlzLnVwbG9hZGVyLmNoZWNrSGVhbHRoKCk7XG4gICAgaWYgKCFoZWFsdGh5KSB7XG4gICAgICBzaG93Tm90aWNlKFxuICAgICAgICBcIkNhbm5vdCBjb25uZWN0IHRvIHpwaWMgc2VydmVyLiBSdW4gYHpwaWMgc2VydmVyIHN0YXJ0YCBpbiBhIHRlcm1pbmFsLlwiLFxuICAgICAgICA2MDAwLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIC8vIE9uZSBwbGFjZWhvbGRlciBwZXIgZmlsZSBrZWVwcyB0aGUgdmlzdWFsIG9yZGVyIHN0YWJsZSBhbmQgbGV0c1xuICAgIC8vIHVzIG1hcCB0aGUgcmVzcG9uc2UgYXJyYXkgYmFjayB0byB0aGUgaW5zZXJ0ZWQgcm93cy5cbiAgICBjb25zdCBwbGFjZWhvbGRlcnMgPSBmaWxlcy5tYXAoKGZpbGUpID0+ICh7XG4gICAgICBpZDogZ2VuZXJhdGVQbGFjZWhvbGRlcklkKCksXG4gICAgICBuYW1lOiBmaWxlLm5hbWUsXG4gICAgfSkpO1xuXG4gICAgY29uc3QgcGxhY2Vob2xkZXJUZXh0ID0gcGxhY2Vob2xkZXJzXG4gICAgICAubWFwKChwKSA9PiBnZXRQbGFjZWhvbGRlclRleHQocC5pZCkpXG4gICAgICAuam9pbihcIlxcblwiKTtcbiAgICBlZGl0b3IucmVwbGFjZVNlbGVjdGlvbihgJHtwbGFjZWhvbGRlclRleHR9XFxuYCk7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnVwbG9hZGVyLnVwbG9hZChmaWxlcyk7XG5cbiAgICAgIGlmICghcmVzcG9uc2Uuc3VjY2Vzcykge1xuICAgICAgICB0aGlzLnJlcGxhY2VQbGFjZWhvbGRlcnMoZWRpdG9yLCBwbGFjZWhvbGRlcnMsIHtcbiAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICBtc2c6IHJlc3BvbnNlLm1zZyA/PyBcIlVwbG9hZCBmYWlsZWRcIixcbiAgICAgICAgfSk7XG4gICAgICAgIHNob3dOb3RpY2UoYFVwbG9hZCBmYWlsZWQ6ICR7cmVzcG9uc2UubXNnID8/IFwidW5rbm93biBlcnJvclwifWApO1xuICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHVybHMgPSByZXNwb25zZS5yZXN1bHQgPz8gW107XG4gICAgICBwbGFjZWhvbGRlcnMuZm9yRWFjaCgocGxhY2Vob2xkZXIsIGluZGV4KSA9PiB7XG4gICAgICAgIGNvbnN0IHVybCA9IHVybHNbaW5kZXhdO1xuICAgICAgICBpZiAoIXVybCkge1xuICAgICAgICAgIHRoaXMucmVwbGFjZVBsYWNlaG9sZGVyKGVkaXRvciwgcGxhY2Vob2xkZXIuaWQsIFwi4pqg77iPIE1pc3NpbmcgVVJMXCIpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBtYXJrZG93biA9IGZvcm1hdEltYWdlTWFya2Rvd24oXG4gICAgICAgICAgdXJsLFxuICAgICAgICAgIHBsYWNlaG9sZGVyLm5hbWUsXG4gICAgICAgICAgdGhpcy5zZXR0aW5ncy5pbWFnZURlc2MsXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMucmVwbGFjZVBsYWNlaG9sZGVyKGVkaXRvciwgcGxhY2Vob2xkZXIuaWQsIG1hcmtkb3duKTtcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBva0NvdW50ID0gcGxhY2Vob2xkZXJzLmZpbHRlcigoXywgaSkgPT4gdXJsc1tpXSkubGVuZ3RoO1xuICAgICAgaWYgKG9rQ291bnQgPiAwKSB7XG4gICAgICAgIHNob3dOb3RpY2UoYFVwbG9hZGVkICR7b2tDb3VudH0gb2YgJHtwbGFjZWhvbGRlcnMubGVuZ3RofSBpbWFnZShzKWApO1xuICAgICAgfVxuXG4gICAgICAvLyBUaGUgYGRlbGV0ZUxvY2FsQWZ0ZXJVcGxvYWRgIHNldHRpbmcgaXMgYSBuby1vcCBmb3Igbm93OiB3ZVxuICAgICAgLy8gY2FuJ3QgcmVsaWFibHkgdGVsbCBhIGNsaXBib2FyZCBibG9iIGZyb20gYSBkcmFnZ2VkIGZpbGUgb25cbiAgICAgIC8vIGV2ZXJ5IHBsYXRmb3JtLCBzbyBkZWxldGluZyB0aGUgc291cmNlIG1pZ2h0IGRlc3Ryb3kgdXNlclxuICAgICAgLy8gZGF0YS4gVGhlIHNldHRpbmcgaXMgd2lyZWQgdGhyb3VnaCB0byB0aGUgVUkgdG8gcmVzZXJ2ZSB0aGVcbiAgICAgIC8vIGNvbnRyYWN0IOKAlCBzZWUgQ0hBTkdFTE9HIDAuMS4wLlxuICAgICAgdm9pZCB0aGlzLnNldHRpbmdzLmRlbGV0ZUxvY2FsQWZ0ZXJVcGxvYWQ7XG5cbiAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbenBpY10gdW5leHBlY3RlZCBlcnJvciBkdXJpbmcgdXBsb2FkOlwiLCBtZXNzYWdlKTtcbiAgICAgIHRoaXMucmVwbGFjZVBsYWNlaG9sZGVycyhlZGl0b3IsIHBsYWNlaG9sZGVycywge1xuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgbXNnOiBtZXNzYWdlLFxuICAgICAgfSk7XG4gICAgICBzaG93Tm90aWNlKGBVcGxvYWQgZXJyb3I6ICR7bWVzc2FnZX1gKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBMb2NhdGUgdGhlIGZpcnN0IG9jY3VycmVuY2Ugb2YgYSBwbGFjZWhvbGRlciBpbiB0aGUgZWRpdG9yIGFuZFxuICAgKiBzd2FwIGl0IGZvciBgcmVwbGFjZW1lbnRgLiBUaGUgc2VhcmNoIGlzIGFuY2hvcmVkIG9uIHRoZSB1bmlxdWUgaWRcbiAgICogZW1iZWRkZWQgaW4gdGhlIGFsdCB0ZXh0IHNvIG11bHRpLWltYWdlIGJhdGNoZXMgZG9uJ3QgY29sbGlkZS5cbiAgICovXG4gIHByaXZhdGUgcmVwbGFjZVBsYWNlaG9sZGVyKFxuICAgIGVkaXRvcjogRWRpdG9yLFxuICAgIGlkOiBzdHJpbmcsXG4gICAgcmVwbGFjZW1lbnQ6IHN0cmluZyxcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgdGFyZ2V0ID0gZ2V0UGxhY2Vob2xkZXJUZXh0KGlkKTtcbiAgICBjb25zdCBjb250ZW50ID0gZWRpdG9yLmdldFZhbHVlKCk7XG4gICAgY29uc3QgaWR4ID0gY29udGVudC5pbmRleE9mKHRhcmdldCk7XG4gICAgaWYgKGlkeCA9PT0gLTEpIHJldHVybjtcblxuICAgIGNvbnN0IHBvcyA9IGVkaXRvci5vZmZzZXRUb1BvcyhpZHgpO1xuICAgIGNvbnN0IGVuZCA9IGVkaXRvci5vZmZzZXRUb1BvcyhpZHggKyB0YXJnZXQubGVuZ3RoKTtcbiAgICBlZGl0b3IucmVwbGFjZVJhbmdlKHJlcGxhY2VtZW50LCBwb3MsIGVuZCk7XG4gIH1cblxuICAvKiogQnVsay1yZXBsYWNlIHBsYWNlaG9sZGVycyB3aXRoIGEgc2luZ2xlIGVycm9yIHJvdy4gKi9cbiAgcHJpdmF0ZSByZXBsYWNlUGxhY2Vob2xkZXJzKFxuICAgIGVkaXRvcjogRWRpdG9yLFxuICAgIHBsYWNlaG9sZGVyczogUmVhZG9ubHlBcnJheTx7IGlkOiBzdHJpbmcgfT4sXG4gICAgcmVzcG9uc2U6IHsgc3VjY2VzczogZmFsc2U7IG1zZzogc3RyaW5nIH0sXG4gICk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgcGxhY2Vob2xkZXIgb2YgcGxhY2Vob2xkZXJzKSB7XG4gICAgICB0aGlzLnJlcGxhY2VQbGFjZWhvbGRlcihcbiAgICAgICAgZWRpdG9yLFxuICAgICAgICBwbGFjZWhvbGRlci5pZCxcbiAgICAgICAgYOKaoO+4jyBVcGxvYWQgZmFpbGVkOiAke3Jlc3BvbnNlLm1zZ31gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gQ29tbWFuZHNcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSBhc3luYyB1cGxvYWRGcm9tQ2xpcGJvYXJkKGVkaXRvcj86IEVkaXRvcik6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0eXBlb2YgbmF2aWdhdG9yID09PSBcInVuZGVmaW5lZFwiIHx8ICFuYXZpZ2F0b3IuY2xpcGJvYXJkPy5yZWFkKSB7XG4gICAgICBzaG93Tm90aWNlKFwiQ2xpcGJvYXJkIHJlYWQgaXMgbm90IGF2YWlsYWJsZSBpbiB0aGlzIGNvbnRleHRcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbGV0IGl0ZW1zOiBDbGlwYm9hcmRJdGVtcztcbiAgICB0cnkge1xuICAgICAgaXRlbXMgPSBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLnJlYWQoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgIHNob3dOb3RpY2UoYENhbm5vdCByZWFkIGNsaXBib2FyZDogJHttZXNzYWdlfWApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGZpbGVzOiBGaWxlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICAgIGZvciAoY29uc3QgdHlwZSBvZiBpdGVtLnR5cGVzKSB7XG4gICAgICAgIGlmICghdHlwZS5zdGFydHNXaXRoKFwiaW1hZ2UvXCIpKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgYmxvYiA9IGF3YWl0IGl0ZW0uZ2V0VHlwZSh0eXBlKTtcbiAgICAgICAgY29uc3QgZXh0ID0gdHlwZS5zcGxpdChcIi9cIilbMV0gPz8gXCJwbmdcIjtcbiAgICAgICAgY29uc3QgbmFtZSA9IGBjbGlwYm9hcmQtJHtEYXRlLm5vdygpfS4ke2V4dH1gO1xuICAgICAgICBjb25zdCBmaWxlID0gbmV3IEZpbGUoW2Jsb2JdLCBuYW1lLCB7XG4gICAgICAgICAgdHlwZTogdHlwZSB8fCBndWVzc01pbWVUeXBlKG5hbWUpLFxuICAgICAgICB9KTtcbiAgICAgICAgZmlsZXMucHVzaChmaWxlKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmlsZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICBzaG93Tm90aWNlKFwiTm8gaW1hZ2UgZm91bmQgaW4gY2xpcGJvYXJkXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHRhcmdldCA9IGVkaXRvciA/PyB0aGlzLmdldEFjdGl2ZUVkaXRvcigpO1xuICAgIGlmICghdGFyZ2V0KSB7XG4gICAgICBzaG93Tm90aWNlKFwiTm8gYWN0aXZlIGVkaXRvciB0byBpbnNlcnQgaW50b1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy51cGxvYWRBbmRJbnNlcnQodGFyZ2V0LCBmaWxlcyk7XG4gIH1cblxuICAvKipcbiAgICogUmVzb2x2ZSB0aGUgaW1hZ2UgYXR0YWNobWVudCByZWZlcmVuY2VkIGJ5IHRoZSBjdXJyZW50IHNlbGVjdGlvblxuICAgKiAoaWYgYW55KSBpbnRvIGEgdmF1bHQgYFRGaWxlYC4gU3luY2hyb25vdXMgYW5kIHNpZGUtZWZmZWN0LWZyZWUsIHNvXG4gICAqIHRoZSBjb21tYW5kIHBhbGV0dGUgY2FuIHVzZSBpdCBhcyBhIGNoZWFwIHByZWRpY2F0ZS5cbiAgICovXG4gIHByaXZhdGUgZmluZEltYWdlUmVmZXJlbmNlKFxuICAgIHZpZXc6IE1hcmtkb3duVmlldyB8IG51bGwsXG4gICAgZWRpdG9yOiBFZGl0b3IsXG4gICk6IFRGaWxlIHwgbnVsbCB7XG4gICAgaWYgKCF2aWV3KSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBzZWxlY3RlZCA9IGVkaXRvci5nZXRTZWxlY3Rpb24oKS50cmltKCk7XG4gICAgY29uc3QgcGF0aCA9IHRoaXMuZXh0cmFjdEltYWdlUGF0aChzZWxlY3RlZCk7XG4gICAgaWYgKCFwYXRoKSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IHJlc29sdmVkID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpO1xuICAgIGlmICghKHJlc29sdmVkIGluc3RhbmNlb2YgVEZpbGUpKSByZXR1cm4gbnVsbDtcbiAgICBpZiAoIWlzSW1hZ2VGaWxlKHJlc29sdmVkKSkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHJlc29sdmVkO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlYWQgYSB2YXVsdCBpbWFnZSBpbnRvIG1lbW9yeSBhbmQgZmVlZCBpdCB0aHJvdWdoIHRoZSByZWd1bGFyXG4gICAqIHVwbG9hZCBwaXBlbGluZS5cbiAgICovXG4gIHByaXZhdGUgYXN5bmMgdXBsb2FkUmVmZXJlbmNlZEltYWdlKFxuICAgIGVkaXRvcjogRWRpdG9yLFxuICAgIGZpbGU6IFRGaWxlLFxuICApOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgYnl0ZXMgPSBhd2FpdCB0aGlzLmFwcC52YXVsdC5yZWFkQmluYXJ5KGZpbGUpO1xuICAgICAgY29uc3QgYmxvYiA9IG5ldyBGaWxlKFtieXRlc10sIGZpbGUubmFtZSwge1xuICAgICAgICB0eXBlOiBndWVzc01pbWVUeXBlKGZpbGUubmFtZSksXG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHRoaXMudXBsb2FkQW5kSW5zZXJ0KGVkaXRvciwgW2Jsb2JdKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgIHNob3dOb3RpY2UoYENhbm5vdCByZWFkIHZhdWx0IGltYWdlOiAke21lc3NhZ2V9YCk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEV4dHJhY3QgdGhlIHBhdGggcG9ydGlvbiBvZiBhIG1hcmtkb3duIGltYWdlIHRhZyBpbiB0aGUgY3VycmVudFxuICAgKiBzZWxlY3Rpb24uIFJldHVybnMgYG51bGxgIGZvciBleHRlcm5hbCBVUkxzIG9yIG5vbi1pbWFnZSBjb250ZW50LlxuICAgKi9cbiAgcHJpdmF0ZSBleHRyYWN0SW1hZ2VQYXRoKHNlbGVjdGlvbjogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgaWYgKCFzZWxlY3Rpb24pIHJldHVybiBudWxsO1xuICAgIGNvbnN0IG1hdGNoID0gc2VsZWN0aW9uLm1hdGNoKC8hXFxbW15cXF1dKlxcXVxcKChbXildKylcXCkvKTtcbiAgICBpZiAoIW1hdGNoKSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IHRhcmdldCA9IG1hdGNoWzFdLnRyaW0oKTtcbiAgICBpZiAoL15bYS16XSs6XFwvXFwvL2kudGVzdCh0YXJnZXQpKSByZXR1cm4gbnVsbDtcblxuICAgIC8vIFN0cmlwIG9wdGlvbmFsIHRpdGxlOiBgcGF0aCBcInRpdGxlXCJgLlxuICAgIGNvbnN0IGNsZWFuUGF0aCA9IHRhcmdldC5zcGxpdChcIiBcIilbMF07XG4gICAgaWYgKGNsZWFuUGF0aC5zdGFydHNXaXRoKFwiL1wiKSkge1xuICAgICAgcmV0dXJuIGNsZWFuUGF0aC5zbGljZSgxKTtcbiAgICB9XG4gICAgcmV0dXJuIGNsZWFuUGF0aDtcbiAgfVxuXG4gIHByaXZhdGUgZ2V0QWN0aXZlRWRpdG9yKCk6IEVkaXRvciB8IG51bGwge1xuICAgIGNvbnN0IHZpZXcgPSB0aGlzLmFwcC53b3Jrc3BhY2UuZ2V0QWN0aXZlVmlld09mVHlwZShNYXJrZG93blZpZXcpO1xuICAgIHJldHVybiB2aWV3Py5lZGl0b3IgPz8gbnVsbDtcbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBGcm9udG1hdHRlciBvcHQtb3V0XG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIC8qKlxuICAgKiBBbGxvdyBpbmRpdmlkdWFsIG5vdGVzIHRvIGRpc2FibGUgYXV0by11cGxvYWQgdmlhIHRoZSBZQU1MIGtleVxuICAgKiBgenBpYy11cGxvYWQ6IGZhbHNlYC4gV2Uga2VlcCB0aGUga2V5IGNvbmZpZ3VyYWJsZSBidXQgdGhlIGNvbnN0YW50XG4gICAqIGlzIHRoZSBvbmx5IG9uZSB3ZSByZWFkIGluIHRoaXMgdmVyc2lvbi5cbiAgICovXG4gIHByaXZhdGUgaXNVcGxvYWREaXNhYmxlZEluRnJvbnRtYXR0ZXIoKTogYm9vbGVhbiB7XG4gICAgY29uc3QgdmlldyA9IHRoaXMuYXBwLndvcmtzcGFjZS5nZXRBY3RpdmVWaWV3T2ZUeXBlKE1hcmtkb3duVmlldyk7XG4gICAgY29uc3QgY2FjaGUgPSB2aWV3Py5maWxlXG4gICAgICA/ICh0aGlzLmFwcC5tZXRhZGF0YUNhY2hlLmdldEZpbGVDYWNoZShcbiAgICAgICAgICB2aWV3LmZpbGUsXG4gICAgICAgICkgYXMgQ2FjaGVkTWV0YWRhdGEgfCBudWxsKVxuICAgICAgOiBudWxsO1xuICAgIGNvbnN0IHZhbHVlID0gY2FjaGU/LmZyb250bWF0dGVyPy5bRlJPTlRNQVRURVJfRElTQUJMRV9LRVldO1xuICAgIGlmICh2YWx1ZSA9PT0gZmFsc2UpIHJldHVybiBmYWxzZTsgLy8gZXhwbGljaXQgb3B0LWluIG92ZXJyaWRlcyBub3RoaW5nXG4gICAgaWYgKHZhbHVlID09PSBcImZhbHNlXCIgfHwgdmFsdWUgPT09IFwibm9cIiB8fCB2YWx1ZSA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBCb29sZWFuKHZhbHVlKTtcbiAgfVxufVxuIl0sIm5hbWVzIjpbInJlcXVlc3RVcmwiLCJOb3RpY2UiLCJQbHVnaW5TZXR0aW5nVGFiIiwiU2V0dGluZyIsIlBsdWdpbiIsIk1hcmtkb3duVmlldyIsIlRGaWxlIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUE7Ozs7O0FBS0c7QUFLSDtBQUNBLE1BQU0sZ0JBQWdCLEdBQUc7SUFDdkIsTUFBTTtJQUNOLE1BQU07SUFDTixPQUFPO0lBQ1AsTUFBTTtJQUNOLE9BQU87SUFDUCxNQUFNO0lBQ04sT0FBTztJQUNQLE1BQU07SUFDTixNQUFNO0lBQ04sT0FBTztDQUNSO0FBRUQ7Ozs7QUFJRztBQUNHLFNBQVUsV0FBVyxDQUFDLElBQWtCLEVBQUE7QUFDNUMsSUFBQSxJQUFJLENBQUMsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUk7QUFBRSxRQUFBLE9BQU8sS0FBSztJQUNyQyxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRTtBQUN4QyxJQUFBLE9BQU8sZ0JBQWdCLENBQUMsSUFBSSxDQUFDLENBQUMsR0FBRyxLQUFLLFFBQVEsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDL0Q7QUFFQTs7OztBQUlHO1NBQ2EscUJBQXFCLEdBQUE7QUFDbkMsSUFBQSxPQUFPLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDL0M7QUFFQTs7O0FBR0c7U0FD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
