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
  type MarkdownFileInfo,
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
  formatUploadedMarkdown,
  generatePlaceholderId,
  getPlaceholderText,
  guessMimeType,
  isUploadableFile,
} from "./utils";

interface EditorSnapshot {
  filePath: string | null;
  content: string;
}

interface InsertedTextChange {
  start: number;
  insertedText: string;
}

interface InsertedMediaReference {
  start: number;
  end: number;
  originalText: string;
  file: TFile;
}

const COMMAND_UPLOAD_FROM_CLIPBOARD = "upload-image-from-clipboard";
const COMMAND_UPLOAD_FROM_VAULT = "upload-image-from-vault";

export default class ZpicPlugin extends Plugin {
  settings!: ZpicSettings;
  uploader!: ZpicUploader;
  private editorSnapshots = new WeakMap<Editor, EditorSnapshot>();
  private suppressedEditorChanges = new WeakMap<Editor, number>();

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

    this.registerEvent(
      this.app.workspace.on(
        "editor-change",
        (editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
          void this.handleEditorChange(editor, info);
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

    const uploadableFiles = Array.from(files).filter(isUploadableFile);
    if (uploadableFiles.length === 0) return;

    // Only intercept the paste once we are sure there is an image to
    // upload, so pasting plain text still works.
    evt.preventDefault();
    evt.stopPropagation();

    await this.uploadAndInsert(editor, uploadableFiles);
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

    const uploadableFiles = Array.from(files).filter(isUploadableFile);
    if (uploadableFiles.length === 0) return;

    evt.preventDefault();
    evt.stopPropagation();

    await this.uploadAndInsert(editor, uploadableFiles);
  }

  private async handleEditorChange(
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ): Promise<void> {
    const filePath = info.file?.path ?? null;
    const content = editor.getValue();
    const previous = this.editorSnapshots.get(editor);

    if (this.isEditorChangeSuppressed(editor)) {
      this.editorSnapshots.set(editor, { filePath, content });
      return;
    }

    this.editorSnapshots.set(editor, { filePath, content });

    if (!previous || previous.filePath !== filePath || !filePath) return;
    if (this.isUploadDisabledInFrontmatter(info.file ?? null)) return;

    const change = this.getInsertedTextChange(previous.content, content);
    if (!change || !/(\[\[|\]\()/.test(change.insertedText)) return;

    const references = this.findInsertedMediaReferences(
      change.insertedText,
      filePath,
    );
    if (references.length === 0) return;

    await this.uploadInsertedMediaReferences(
      editor,
      change.start,
      references,
    );
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
      file,
    }));

    const placeholderText = placeholders
      .map((p) => getPlaceholderText(p.id))
      .join("\n");
    this.runEditorMutation(editor, () => {
      editor.replaceSelection(`${placeholderText}\n`);
    });

    try {
      // On desktop Electron, dropped files usually expose a native file
      // path (`file.path`). Prefer path-list mode when available so large
      // media uploads don't hit multipart body-size limits.
      const nativePaths = this.getNativeFilePaths(files);
      const response = await this.uploader.upload(nativePaths ?? files);

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
        const markdown = formatUploadedMarkdown(
          url,
          placeholder.name,
          this.settings.imageDesc,
        );
        this.replacePlaceholder(editor, placeholder.id, markdown);
      });

      const okCount = placeholders.filter((_, i) => urls[i]).length;
      if (okCount > 0) {
        showNotice(`Uploaded ${okCount} of ${placeholders.length} file(s)`);
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
   * Extract native file-system paths from browser `File` objects when
   * running in desktop Electron. Returns `null` unless every file has
   * a usable absolute path.
   */
  private getNativeFilePaths(files: File[]): string[] | null {
    if (files.length === 0) return null;

    const paths: string[] = [];
    for (const file of files) {
      const nativePath = (file as File & { path?: unknown }).path;
      if (typeof nativePath !== "string" || nativePath.length === 0) {
        return null;
      }
      if (!nativePath.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(nativePath)) {
        return null;
      }
      paths.push(nativePath);
    }

    return paths;
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
    this.runEditorMutation(editor, () => {
      editor.replaceRange(replacement, pos, end);
    });
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

  private async uploadInsertedMediaReferences(
    editor: Editor,
    baseOffset: number,
    references: InsertedMediaReference[],
  ): Promise<void> {
    const placeholders = references.map((reference) => ({
      ...reference,
      id: generatePlaceholderId(),
    }));

    this.runEditorMutation(editor, () => {
      for (const placeholder of [...placeholders].reverse()) {
        const start = editor.offsetToPos(baseOffset + placeholder.start);
        const end = editor.offsetToPos(baseOffset + placeholder.end);
        editor.replaceRange(getPlaceholderText(placeholder.id), start, end);
      }
    });

    const healthy = await this.uploader.checkHealth();
    if (!healthy) {
      this.restoreAttachmentReferences(editor, placeholders);
      showNotice(
        "Cannot connect to zpic server. Kept local media attachment links.",
        6000,
      );
      return;
    }

    let files: File[];
    try {
      files = await Promise.all(
        placeholders.map((placeholder) =>
          this.readVaultFileForUpload(placeholder.file),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.restoreAttachmentReferences(editor, placeholders);
      showNotice(`Cannot read local attachment: ${message}`);
      return;
    }

    try {
      const response = await this.uploader.upload(files);

      if (!response.success) {
        this.restoreAttachmentReferences(editor, placeholders);
        showNotice(`Upload failed: ${response.msg ?? "unknown error"}`);
        return;
      }

      const urls = response.result ?? [];
      let okCount = 0;
      placeholders.forEach((placeholder, index) => {
        const url = urls[index];
        if (!url) {
          this.replacePlaceholder(editor, placeholder.id, placeholder.originalText);
          return;
        }

        okCount += 1;
        this.replacePlaceholder(
          editor,
          placeholder.id,
          formatUploadedMarkdown(
            url,
            placeholder.file.name,
            this.settings.imageDesc,
          ),
        );
      });

      if (okCount === 0) {
        showNotice("Upload failed: zpic did not return any URL");
        return;
      }

      if (okCount < placeholders.length) {
        showNotice(
          `Uploaded ${okCount} of ${placeholders.length} attachment(s); kept local links for the rest.`,
        );
        return;
      }

      showNotice(`Uploaded ${okCount} attachment(s)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[zpic] attachment upload error:", message);
      this.restoreAttachmentReferences(editor, placeholders);
      showNotice(`Upload error: ${message}`);
    }
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
    if (!isUploadableFile(resolved)) return null;
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
      const blob = await this.readVaultFileForUpload(file);
      await this.uploadAndInsert(editor, [blob]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotice(`Cannot read vault image: ${message}`);
    }
  }

  private async readVaultFileForUpload(file: TFile): Promise<File> {
    const bytes = await this.app.vault.readBinary(file);
    return new File([bytes], file.name, {
      type: guessMimeType(file.name),
    });
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

  private findInsertedMediaReferences(
    insertedText: string,
    sourcePath: string,
  ): InsertedMediaReference[] {
    const references: InsertedMediaReference[] = [];
    const wikiLinkPattern = /!?\[\[([^[\]]+)\]\]/g;
    const markdownLinkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;

    for (const match of insertedText.matchAll(wikiLinkPattern)) {
      if (typeof match.index !== "number") continue;
      const originalText = match[0];
      const file = this.resolveMediaReference(match[1], sourcePath);
      if (!file) continue;
      references.push({
        start: match.index,
        end: match.index + originalText.length,
        originalText,
        file,
      });
    }

    for (const match of insertedText.matchAll(markdownLinkPattern)) {
      if (typeof match.index !== "number") continue;
      const originalText = match[0];
      const file = this.resolveMediaReference(
        this.extractMarkdownLinkTarget(match[1]),
        sourcePath,
      );
      if (!file) continue;
      references.push({
        start: match.index,
        end: match.index + originalText.length,
        originalText,
        file,
      });
    }

    return references.sort((left, right) => left.start - right.start);
  }

  private resolveMediaReference(
    rawTarget: string,
    sourcePath: string,
  ): TFile | null {
    const normalizedTarget = rawTarget
      .trim()
      .replace(/^<|>$/g, "")
      .split("|")[0]
      .split("#")[0]
      .trim();

    if (!normalizedTarget) return null;
    if (/^(?:[a-z]+:)?\/\//i.test(normalizedTarget)) return null;
    if (/^(?:data|mailto):/i.test(normalizedTarget)) return null;

    const linkPath = normalizedTarget.startsWith("/")
      ? normalizedTarget.slice(1)
      : normalizedTarget;

    const resolved =
      this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath) ??
      this.app.vault.getAbstractFileByPath(linkPath);

    if (!(resolved instanceof TFile)) return null;
    if (!isUploadableFile(resolved)) return null;
    return resolved;
  }

  private extractMarkdownLinkTarget(rawTarget: string): string {
    const trimmed = rawTarget.trim();
    const angleMatch = trimmed.match(/^<([^>]+)>$/);
    if (angleMatch) return angleMatch[1].trim();

    const titleMatch = trimmed.match(/^(\S+)\s+(?:"[^"]*"|'[^']*')$/);
    if (titleMatch) return titleMatch[1].trim();

    return trimmed;
  }

  private getInsertedTextChange(
    previous: string,
    current: string,
  ): InsertedTextChange | null {
    if (previous === current) return null;

    let start = 0;
    const minLength = Math.min(previous.length, current.length);
    while (
      start < minLength &&
      previous.charCodeAt(start) === current.charCodeAt(start)
    ) {
      start += 1;
    }

    let previousEnd = previous.length - 1;
    let currentEnd = current.length - 1;
    while (
      previousEnd >= start &&
      currentEnd >= start &&
      previous.charCodeAt(previousEnd) === current.charCodeAt(currentEnd)
    ) {
      previousEnd -= 1;
      currentEnd -= 1;
    }

    const insertedText = current.slice(start, currentEnd + 1);
    if (!insertedText) return null;

    return { start, insertedText };
  }

  private restoreAttachmentReferences(
    editor: Editor,
    placeholders: ReadonlyArray<{ id: string; originalText: string }>,
  ): void {
    placeholders.forEach((placeholder) => {
      this.replacePlaceholder(editor, placeholder.id, placeholder.originalText);
    });
  }

  private runEditorMutation(editor: Editor, mutate: () => void): void {
    const currentCount = this.suppressedEditorChanges.get(editor) ?? 0;
    this.suppressedEditorChanges.set(editor, currentCount + 1);

    try {
      mutate();
    } finally {
      if (currentCount === 0) {
        this.suppressedEditorChanges.delete(editor);
      } else {
        this.suppressedEditorChanges.set(editor, currentCount);
      }

      const previous = this.editorSnapshots.get(editor);
      this.editorSnapshots.set(editor, {
        filePath: previous?.filePath ?? this.getActiveEditorFilePath(),
        content: editor.getValue(),
      });
    }
  }

  private isEditorChangeSuppressed(editor: Editor): boolean {
    return (this.suppressedEditorChanges.get(editor) ?? 0) > 0;
  }

  private getActiveEditor(): Editor | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.editor ?? null;
  }

  private getActiveEditorFilePath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path ?? null;
  }

  // ------------------------------------------------------------------
  // Frontmatter opt-out
  // ------------------------------------------------------------------

  /**
   * Allow individual notes to disable auto-upload via the YAML key
   * `zpic-upload: false`. We keep the key configurable but the constant
   * is the only one we read in this version.
   */
  private isUploadDisabledInFrontmatter(file?: TFile | null): boolean {
    const targetFile =
      file ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
    const cache = targetFile
      ? (this.app.metadataCache.getFileCache(
          targetFile,
        ) as CachedMetadata | null)
      : null;
    const value = cache?.frontmatter?.[FRONTMATTER_DISABLE_KEY];
    if (value === false) return false; // explicit opt-in overrides nothing
    if (value === "false" || value === "no" || value === 0) return false;
    return Boolean(value);
  }
}
