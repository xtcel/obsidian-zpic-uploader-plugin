/**
 * Type definitions for the Zpic-Uploader Obsidian plugin.
 */

/**
 * Plugin settings persisted in Obsidian's data API.
 */
export interface ZpicSettings {
  /** zpic server base URL (default: http://127.0.0.1:36677). */
  serverUrl: string;
  /** Auto-upload when pasting images from clipboard. */
  uploadOnPaste: boolean;
  /** Auto-upload when dragging image files into the editor. */
  uploadOnDrop: boolean;
  /** How to render the alt text in the inserted markdown. */
  imageDesc: ImageDescMode;
  /** Remove the local temp file after a successful upload. */
  deleteLocalAfterUpload: boolean;
  /** Upload request timeout in milliseconds. */
  timeout: number;
}

export type ImageDescMode = 'origin' | 'none';

/**
 * Server response shape, matches the PicGo-compatible contract described
 * in openspec/changes/add-http-server-for-obsidian/specs/api-specification.md.
 */
export interface UploadResponse {
  success: boolean;
  /** Array of uploaded image URLs (parallel to the request list). */
  result?: string[];
  /** Optional extended metadata with delete URLs, etc. */
  fullResult?: UploadResultItem[];
  /** Human-readable error message. */
  msg?: string;
  /** Machine-readable error code. */
  code?: UploadErrorCode;
}

export interface UploadResultItem {
  imgUrl: string;
  /** Optional delete URL when the uploader supports deletion. */
  delete?: string;
}

export type UploadErrorCode =
  | 'INVALID_FILE_TYPE'
  | 'FILE_NOT_FOUND'
  | 'UPLOAD_FAILED'
  | 'CONFIG_ERROR'
  | 'SERVER_ERROR';

/** Health check response. */
export interface HealthResponse {
  status: 'ok' | string;
  version: string;
  uptime: number;
}

/** Server configuration overview (non-sensitive). */
export interface ServerConfigResponse {
  currentUploader: string;
  uploaders: string[];
  version: string;
}

/** A placeholder row used to track an in-flight upload inside the editor. */
export interface UploadPlaceholder {
  /** Unique identifier embedded in the placeholder markdown. */
  id: string;
  /** Original file name (used as alt text). */
  name: string;
  /** The File object to upload. */
  file: File;
}

/**
 * Frontmatter keys that allow disabling per-note uploads.
 * `zpic-upload: false` in the YAML frontmatter disables auto-upload.
 */
export const FRONTMATTER_DISABLE_KEY = 'zpic-upload';

export const DEFAULT_SETTINGS: ZpicSettings = {
  serverUrl: 'http://127.0.0.1:36677',
  uploadOnPaste: true,
  uploadOnDrop: true,
  imageDesc: 'origin',
  deleteLocalAfterUpload: false,
  timeout: 30000,
};
