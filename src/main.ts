/**
 * Zpic Uploader — Obsidian plugin entry point.
 *
 * Listens for editor paste and drop events, sends any image files to the
 * running zpic server, and replaces a temporary `![Uploading…]()` row in
 * the document with the final uploaded URL.
 *
 * The plugin is intentionally thin: the heavy lifting (network, retry,
 * uploader selection, history) lives inside the zpic server itself. See
 * `openspec/changes/add-http-server-for-obsidian` for the full design.
 */

import {
  Editor,
  MarkdownView,
  Plugin,
  TFile,
  type CachedMetadata,
} from "obsidian";
import { ZpicSettingTab, normalizeSettings } from "./settings";
import { ZpicUploader, showNotice } from "./uploader";
import {
  DEFAULT_SETTINGS,
  FRONTMATTER_DISABLE_KEY,
  type UploadResponse,
  type ZpicSettings,
} from "./types";
import {
  formatImageMarkdown,
  generatePlaceholderId,
  getPlaceholderText,
  guessMimeType,
  isImageFile,
} from "./utils";

const COMMAND_UPLOAD_FROM_CLIPBOARD = "upload-image-from-clipboard";
const COMMAND_UPLOAD_FROM_VAULT = "upload-image-from-vault";

export default class ZpicPlugin extends Plugin {
  settings!: ZpicSettings;
  uploader!: ZpicUploader;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.uploader = new ZpicUploader(this.settings);

    this.addSettingTab(new ZpicSettingTab(this.app, this));

    // Paste handler — auto-uploads images coming from the OS clipboard.
    this.registerEvent(
      this.app.workspace.on(
        "editor-paste",
        (evt: ClipboardEvent, editor: Editor, view: MarkdownView) => {
          void this.handlePaste(evt, editor, view);
        },
      ),
    );

    // Drop handler — auto-uploads images dropped from the file system.
    this.registerEvent(
      this.app.workspace.on(
        "editor-drop",
        (evt: DragEvent, editor: Editor, view: MarkdownView) => {
          void this.handleDrop(evt, editor, view);
        },
      ),
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
      editorCallback: (editor: Editor) => {
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
        const view = ctx instanceof MarkdownView ? ctx : null;
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

  onunload(): void {
    console.info("[zpic] plugin unloaded");
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<ZpicSettings> | null;
    this.settings = normalizeSettings(raw ?? DEFAULT_SETTINGS);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Keep the uploader in sync with the latest settings so subsequent
    // uploads don't have to wait for the next onload cycle.
    this.uploader?.updateSettings(this.settings);
  }

  // ------------------------------------------------------------------
  // Event handlers
  // ------------------------------------------------------------------

  private async handlePaste(
    evt: ClipboardEvent,
    editor: Editor,
    _view: MarkdownView,
  ): Promise<void> {
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

  private async handleDrop(
    evt: DragEvent,
    editor: Editor,
    _view: MarkdownView,
  ): Promise<void> {
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
  private async uploadAndInsert(
    editor: Editor,
    files: File[],
  ): Promise<UploadResponse | null> {
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
  private replacePlaceholder(
    editor: Editor,
    id: string,
    replacement: string,
  ): void {
    const target = getPlaceholderText(id);
    const content = editor.getValue();
    const idx = content.indexOf(target);
    if (idx === -1) return;

    const pos = editor.offsetToPos(idx);
    const end = editor.offsetToPos(idx + target.length);
    editor.replaceRange(replacement, pos, end);
  }

  /** Bulk-replace placeholders with a single error row. */
  private replacePlaceholders(
    editor: Editor,
    placeholders: ReadonlyArray<{ id: string }>,
    response: { success: false; msg: string },
  ): void {
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

  private async uploadFromClipboard(editor?: Editor): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.clipboard?.read) {
      showNotice("Clipboard read is not available in this context");
      return;
    }

    let items: ClipboardItems;
    try {
      items = await navigator.clipboard.read();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotice(`Cannot read clipboard: ${message}`);
      return;
    }

    const files: File[] = [];
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
  private findImageReference(
    view: MarkdownView | null,
    editor: Editor,
  ): TFile | null {
    if (!view) return null;
    const selected = editor.getSelection().trim();
    const path = this.extractImagePath(selected);
    if (!path) return null;

    const resolved = this.app.vault.getAbstractFileByPath(path);
    if (!(resolved instanceof TFile)) return null;
    if (!isImageFile(resolved)) return null;
    return resolved;
  }

  /**
   * Read a vault image into memory and feed it through the regular
   * upload pipeline.
   */
  private async uploadReferencedImage(
    editor: Editor,
    file: TFile,
  ): Promise<void> {
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
  private extractImagePath(selection: string): string | null {
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

  private getActiveEditor(): Editor | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
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
  private isUploadDisabledInFrontmatter(): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cache = view?.file
      ? (this.app.metadataCache.getFileCache(
          view.file,
        ) as CachedMetadata | null)
      : null;
    const value = cache?.frontmatter?.[FRONTMATTER_DISABLE_KEY];
    if (value === false) return false; // explicit opt-in overrides nothing
    if (value === "false" || value === "no" || value === 0) return false;
    return Boolean(value);
  }
}
