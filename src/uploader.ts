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

import { Notice, requestUrl, type RequestUrlParam } from "obsidian";
import type {
  HealthResponse,
  ServerConfigResponse,
  UploadErrorCode,
  UploadResponse,
  ZpicSettings,
} from "./types";
import { guessMimeType, normalizeServerUrl } from "./utils";

/** Subset of the Obsidian `RequestUrlResponse` we depend on. */
interface MinimalRequestResponse {
  status: number;
  json: unknown;
  text?: string;
}

export class ZpicUploader {
  private serverUrl: string;
  private timeout: number;

  constructor(settings: ZpicSettings) {
    this.serverUrl = normalizeServerUrl(settings.serverUrl);
    this.timeout = settings.timeout;
  }

  /**
   * Update the uploader when the user changes the server URL or timeout
   * from the settings tab.
   */
  updateSettings(settings: ZpicSettings): void {
    this.serverUrl = normalizeServerUrl(settings.serverUrl);
    this.timeout = settings.timeout;
  }

  /**
   * Upload one or more files. Dispatches to the JSON path-list mode
   * when given strings (file paths) and to the multipart mode when
   * given `File` objects.
   */
  async upload(input: File[] | string[]): Promise<UploadResponse> {
    if (input.length === 0) {
      return { success: false, msg: "No files to upload" };
    }

    try {
      if (typeof input[0] === "string") {
        return await this.uploadPaths(input as string[]);
      }
      return await this.uploadMultipart(input as File[]);
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
  private async uploadPaths(paths: string[]): Promise<UploadResponse> {
    const params: RequestUrlParam = {
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
  private async uploadMultipart(files: File[]): Promise<UploadResponse> {
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
    ) as ArrayBuffer;

    const params: RequestUrlParam = {
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
  private async sendWithTimeout(
    params: RequestUrlParam,
  ): Promise<MinimalRequestResponse> {
    const send = requestUrl(
      params,
    ) as unknown as Promise<MinimalRequestResponse>;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<MinimalRequestResponse>((_, reject) => {
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
  private handleResponse(response: MinimalRequestResponse): UploadResponse {
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 413) {
        return {
          success: false,
          msg:
            "Server returned HTTP 413 (payload too large). " +
            "This file is larger than the server upload limit.",
          code: "SERVER_ERROR",
        };
      }
      return {
        success: false,
        msg: `Server returned HTTP ${response.status}`,
        code: "SERVER_ERROR",
      };
    }

    const data = (response.json ?? {}) as UploadResponse;
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
        code: (data.code ?? "UPLOAD_FAILED") as UploadErrorCode,
      };
    }

    return data;
  }

  /**
   * Lightweight reachability check used before kicking off a real
   * upload. Returns `true` only when the server responds with HTTP 200
   * and a valid `HealthResponse` payload.
   */
  async checkHealth(): Promise<boolean> {
    try {
      const params: RequestUrlParam = {
        url: `${this.serverUrl}/health`,
        method: "GET",
        throw: false,
      };
      const response = await this.sendWithTimeout(params);
      if (response.status !== 200) return false;
      const data = (response.json ?? {}) as HealthResponse;
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
  async getConfig(): Promise<ServerConfigResponse | null> {
    try {
      const params: RequestUrlParam = {
        url: `${this.serverUrl}/config`,
        method: "GET",
        throw: false,
      };
      const response = await this.sendWithTimeout(params);
      if (response.status !== 200) return null;
      return (response.json ?? null) as ServerConfigResponse | null;
    } catch {
      return null;
    }
  }
}

/**
 * Show a user-visible notice with a default 5s timeout. Centralising
 * this keeps the message style consistent across the plugin.
 */
export function showNotice(message: string, timeout = 5000): void {
  new Notice(message, timeout);
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
export async function buildMultipartBody(
  files: File[],
): Promise<{ body: Uint8Array; contentType: string }> {
  // Boundary rule: 1-70 chars, no spaces, no special characters
  // that would require quoting. We mix a timestamp and two random
  // base-36 segments to keep the boundary unique per request.
  const boundary =
    `----zpic-${Date.now().toString(36)}` +
    `-${Math.random().toString(36).slice(2, 10)}`;

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

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
