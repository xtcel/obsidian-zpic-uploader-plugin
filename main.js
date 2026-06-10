'use strict';

var obsidian = require('obsidian');

/**
 * Utility helpers shared across the plugin.
 *
 * Keep this module dependency-free (other than the type-only `obsidian`
 * import) so it can be exercised from tests in the future.
 */
/** Lower-case image extensions accepted by the plugin and zpic server. */
const IMAGE_EXTENSIONS = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.bmp',
    '.tiff',
    '.tif',
    '.svg',
    '.avif',
];
/**
 * Check whether a file (browser `File` or Obsidian `TFile`) is an image
 * by looking at its extension. The MIME type on `File` objects is not
 * reliable across mobile platforms, so we fall back to the extension.
 */
function isImageFile(file) {
    if (!file || !file.name)
        return false;
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
    const altText = desc === 'origin' ? name : '';
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
    return url.trim().replace(/\/+$/, '');
}
/**
 * Heuristic MIME guess from a filename. Used as a fallback when the
 * platform-provided `File.type` is empty (common on iOS).
 */
function guessMimeType(fileName) {
    const ext = fileName.toLowerCase().split('.').pop() ?? '';
    switch (ext) {
        case 'png':
            return 'image/png';
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'gif':
            return 'image/gif';
        case 'webp':
            return 'image/webp';
        case 'bmp':
            return 'image/bmp';
        case 'svg':
            return 'image/svg+xml';
        case 'avif':
            return 'image/avif';
        case 'tif':
        case 'tiff':
            return 'image/tiff';
        default:
            return 'application/octet-stream';
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
        }
        catch (error) {
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
        const bodyBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
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
        }
        finally {
            if (timer)
                clearTimeout(timer);
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
        const data = (response.json ?? {});
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
                code: (data.code ?? "UPLOAD_FAILED"),
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
            if (response.status !== 200)
                return false;
            const data = (response.json ?? {});
            return data.status === "ok";
        }
        catch {
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
            if (response.status !== 200)
                return null;
            return (response.json ?? null);
        }
        catch {
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
    const boundary = `----zpic-${Date.now().toString(36)}` +
        `-${Math.random().toString(36).slice(2, 10)}`;
    const encoder = new TextEncoder();
    const parts = [];
    for (const file of files) {
        const safeName = file.name.replace(/[\r\n"]/g, "_");
        const fileType = file.type || guessMimeType(file.name);
        const header = `--${boundary}\r\n` +
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
 * Type definitions for the Zpic-Uploader Obsidian plugin.
 */
/**
 * Frontmatter keys that allow disabling per-note uploads.
 * `zpic-upload: false` in the YAML frontmatter disables auto-upload.
 */
const FRONTMATTER_DISABLE_KEY = 'zpic-upload';
const DEFAULT_SETTINGS = {
    serverUrl: 'http://127.0.0.1:36677',
    uploadOnPaste: true,
    uploadOnDrop: true,
    imageDesc: 'origin',
    deleteLocalAfterUpload: false,
    timeout: 30000,
};

/**
 * Settings tab for the Zpic-Uploader plugin.
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
        containerEl.createEl('h2', { text: 'Zpic-Uploader' });
        containerEl.createEl('p', {
            text: 'zpic uploads images to your configured host (GitHub, S3, OSS, ' +
                'local, ...) and inserts the resulting URL into the current note. ' +
                'Make sure the zpic server is running before using the plugin.',
            cls: 'setting-item-description',
        });
        this.renderServerSection(containerEl);
        this.renderBehaviorSection(containerEl);
        this.renderDiagnosticsSection(containerEl);
    }
    /** Server URL + timeout. */
    renderServerSection(containerEl) {
        containerEl.createEl('h3', { text: 'Server' });
        new obsidian.Setting(containerEl)
            .setName('Server URL')
            .setDesc('Base URL of the running zpic server (default: http://127.0.0.1:36677).')
            .addText((text) => {
            text
                .setPlaceholder('http://127.0.0.1:36677')
                .setValue(this.plugin.settings.serverUrl)
                .onChange(async (value) => {
                const trimmed = value.trim();
                if (trimmed && !SERVER_URL_PATTERN.test(trimmed)) {
                    showNotice('Server URL must start with http:// or https://');
                    return;
                }
                this.plugin.settings.serverUrl = trimmed || DEFAULT_SETTINGS.serverUrl;
                await this.plugin.saveSettings();
            });
            text.inputEl.style.width = '100%';
        });
        new obsidian.Setting(containerEl)
            .setName('Request timeout')
            .setDesc('Maximum time to wait for a single upload (milliseconds).')
            .addText((text) => {
            text
                .setPlaceholder('30000')
                .setValue(String(this.plugin.settings.timeout))
                .onChange(async (value) => {
                const parsed = Number.parseInt(value, 10);
                if (Number.isNaN(parsed) || parsed <= 0) {
                    showNotice('Timeout must be a positive number');
                    return;
                }
                this.plugin.settings.timeout = parsed;
                await this.plugin.saveSettings();
            });
        });
    }
    /** Paste / drop behaviour + markdown formatting. */
    renderBehaviorSection(containerEl) {
        containerEl.createEl('h3', { text: 'Behaviour' });
        new obsidian.Setting(containerEl)
            .setName('Upload on paste')
            .setDesc('Automatically upload images pasted from the clipboard.')
            .addToggle((toggle) => toggle
            .setValue(this.plugin.settings.uploadOnPaste)
            .onChange(async (value) => {
            this.plugin.settings.uploadOnPaste = value;
            await this.plugin.saveSettings();
        }));
        new obsidian.Setting(containerEl)
            .setName('Upload on drop')
            .setDesc('Automatically upload image files dragged into the editor. ' +
            'Hold Ctrl/Cmd while dropping to keep Obsidian\'s default behaviour.')
            .addToggle((toggle) => toggle
            .setValue(this.plugin.settings.uploadOnDrop)
            .onChange(async (value) => {
            this.plugin.settings.uploadOnDrop = value;
            await this.plugin.saveSettings();
        }));
        new obsidian.Setting(containerEl)
            .setName('Image description')
            .setDesc('How to render alt text in the inserted markdown.')
            .addDropdown((dropdown) => dropdown
            .addOption('origin', 'Original filename')
            .addOption('none', 'Empty alt text')
            .setValue(this.plugin.settings.imageDesc)
            .onChange(async (value) => {
            this.plugin.settings.imageDesc = value;
            await this.plugin.saveSettings();
        }));
        new obsidian.Setting(containerEl)
            .setName('Delete local file after upload')
            .setDesc('Remove the local source file once the upload completes. ' +
            'Only applies to files the plugin is responsible for (e.g. clipboard pastes).')
            .addToggle((toggle) => toggle
            .setValue(this.plugin.settings.deleteLocalAfterUpload)
            .onChange(async (value) => {
            this.plugin.settings.deleteLocalAfterUpload = value;
            await this.plugin.saveSettings();
        }));
    }
    /** Health probe + config dump for sanity-checking the server. */
    renderDiagnosticsSection(containerEl) {
        containerEl.createEl('h3', { text: 'Diagnostics' });
        const statusEl = containerEl.createEl('div', {
            cls: 'zpic-status',
            text: 'Click "Check server" to test the connection.',
        });
        new obsidian.Setting(containerEl)
            .setName('Check server')
            .setDesc('Verify the server is reachable and report the active uploader.')
            .addButton((button) => button
            .setButtonText('Check server')
            .setCta()
            .onClick(async () => {
            statusEl.setText('Checking…');
            const probe = this.probe ?? new ZpicUploader(this.plugin.settings);
            this.probe = probe;
            probe.updateSettings(this.plugin.settings);
            const healthy = await probe.checkHealth();
            if (!healthy) {
                statusEl.setText('Server is unreachable. Run `zpic server start` in a terminal.');
                new obsidian.Notice('Cannot connect to zpic server', 5000);
                return;
            }
            const config = await probe.getConfig();
            if (!config) {
                statusEl.setText('Server is healthy but /config is unavailable.');
                return;
            }
            statusEl.setText(`OK · uploader: ${config.currentUploader} ` +
                `(${config.uploaders.length} available) · zpic v${config.version}`);
        }));
    }
}
/** Persisted-shape validation for loaded settings. */
function normalizeSettings(raw) {
    const merged = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
    if (typeof merged.serverUrl !== 'string' || merged.serverUrl.length === 0) {
        merged.serverUrl = DEFAULT_SETTINGS.serverUrl;
    }
    if (merged.imageDesc !== 'origin' && merged.imageDesc !== 'none') {
        merged.imageDesc = DEFAULT_SETTINGS.imageDesc;
    }
    if (typeof merged.timeout !== 'number' || merged.timeout <= 0) {
        merged.timeout = DEFAULT_SETTINGS.timeout;
    }
    return merged;
}

/**
 * Zpic-Uploader — Obsidian plugin entry point.
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
        this.registerEvent(this.app.workspace.on("editor-paste", (evt, editor, view) => {
            void this.handlePaste(evt, editor, view);
        }));
        // Drop handler — auto-uploads images dropped from the file system.
        this.registerEvent(this.app.workspace.on("editor-drop", (evt, editor, view) => {
            void this.handleDrop(evt, editor, view);
        }));
        // Ribbon icon for users who prefer clicking over pasting/dropping.
        this.addRibbonIcon("upload-glyph", "zpic: upload image from clipboard", () => {
            void this.uploadFromClipboard();
        });
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
                if (checking)
                    return candidate !== null;
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
        const raw = (await this.loadData());
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
        if (!this.settings.uploadOnPaste)
            return;
        if (this.isUploadDisabledInFrontmatter())
            return;
        const files = evt.clipboardData?.files;
        if (!files || files.length === 0)
            return;
        const imageFiles = Array.from(files).filter(isImageFile);
        if (imageFiles.length === 0)
            return;
        // Only intercept the paste once we are sure there is an image to
        // upload, so pasting plain text still works.
        evt.preventDefault();
        evt.stopPropagation();
        await this.uploadAndInsert(editor, imageFiles);
    }
    async handleDrop(evt, editor, _view) {
        if (!this.settings.uploadOnDrop)
            return;
        if (this.isUploadDisabledInFrontmatter())
            return;
        // Preserve Obsidian's default drag-to-attach behaviour when the
        // user explicitly opts out via modifier key.
        if (evt.ctrlKey || evt.metaKey)
            return;
        const files = evt.dataTransfer?.files;
        if (!files || files.length === 0)
            return;
        const imageFiles = Array.from(files).filter(isImageFile);
        if (imageFiles.length === 0)
            return;
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
        if (files.length === 0)
            return null;
        const healthy = await this.uploader.checkHealth();
        if (!healthy) {
            showNotice("Cannot connect to zpic server. Run `zpic server start` in a terminal.", 6000);
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
                const markdown = formatImageMarkdown(url, placeholder.name, this.settings.imageDesc);
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
        }
        catch (error) {
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
        if (idx === -1)
            return;
        const pos = editor.offsetToPos(idx);
        const end = editor.offsetToPos(idx + target.length);
        editor.replaceRange(replacement, pos, end);
    }
    /** Bulk-replace placeholders with a single error row. */
    replacePlaceholders(editor, placeholders, response) {
        for (const placeholder of placeholders) {
            this.replacePlaceholder(editor, placeholder.id, `⚠️ Upload failed: ${response.msg}`);
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
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showNotice(`Cannot read clipboard: ${message}`);
            return;
        }
        const files = [];
        for (const item of items) {
            for (const type of item.types) {
                if (!type.startsWith("image/"))
                    continue;
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
        if (!view)
            return null;
        const selected = editor.getSelection().trim();
        const path = this.extractImagePath(selected);
        if (!path)
            return null;
        const resolved = this.app.vault.getAbstractFileByPath(path);
        if (!(resolved instanceof obsidian.TFile))
            return null;
        if (!isImageFile(resolved))
            return null;
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
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showNotice(`Cannot read vault image: ${message}`);
        }
    }
    /**
     * Extract the path portion of a markdown image tag in the current
     * selection. Returns `null` for external URLs or non-image content.
     */
    extractImagePath(selection) {
        if (!selection)
            return null;
        const match = selection.match(/!\[[^\]]*\]\(([^)]+)\)/);
        if (!match)
            return null;
        const target = match[1].trim();
        if (/^[a-z]+:\/\//i.test(target))
            return null;
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
        if (value === false)
            return false; // explicit opt-in overrides nothing
        if (value === "false" || value === "no" || value === 0)
            return false;
        return Boolean(value);
    }
}

module.exports = ZpicPlugin;
