/**
 * Settings tab for the Zpic-Uploader plugin.
 *
 * The plugin settings and the `ZpicSettingTab` class live in their own
 * module so that `main.ts` stays focused on event handling. The tab
 * uses the standard Obsidian `Setting` builder to render inputs that
 * match the look and feel of the rest of the settings panel.
 */

import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ZpicPlugin from './main';
import { showNotice, ZpicUploader } from './uploader';
import type { ImageDescMode, ZpicSettings } from './types';
import { DEFAULT_SETTINGS } from './types';

const SERVER_URL_PATTERN = /^https?:\/\/.+/i;

export class ZpicSettingTab extends PluginSettingTab {
  private plugin: ZpicPlugin;
  /** Reused probe to validate the server URL without leaking state. */
  private probe: ZpicUploader | null = null;

  constructor(app: App, plugin: ZpicPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Zpic-Uploader' });

    containerEl.createEl('p', {
      text:
        'zpic uploads images to your configured host (GitHub, S3, OSS, ' +
        'local, ...) and inserts the resulting URL into the current note. ' +
        'Make sure the zpic server is running before using the plugin.',
      cls: 'setting-item-description',
    });

    this.renderServerSection(containerEl);
    this.renderBehaviorSection(containerEl);
    this.renderDiagnosticsSection(containerEl);
  }

  /** Server URL + timeout. */
  private renderServerSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Server' });

    new Setting(containerEl)
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

    new Setting(containerEl)
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
  private renderBehaviorSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Behaviour' });

    new Setting(containerEl)
      .setName('Upload on paste')
      .setDesc('Automatically upload images pasted from the clipboard.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.uploadOnPaste)
          .onChange(async (value) => {
            this.plugin.settings.uploadOnPaste = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Upload on drop')
      .setDesc(
        'Automatically upload image files dragged into the editor. ' +
          'Hold Ctrl/Cmd while dropping to keep Obsidian\'s default behaviour.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.uploadOnDrop)
          .onChange(async (value) => {
            this.plugin.settings.uploadOnDrop = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Image description')
      .setDesc('How to render alt text in the inserted markdown.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('origin', 'Original filename')
          .addOption('none', 'Empty alt text')
          .setValue(this.plugin.settings.imageDesc)
          .onChange(async (value) => {
            this.plugin.settings.imageDesc = value as ImageDescMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Delete local file after upload')
      .setDesc(
        'Remove the local source file once the upload completes. ' +
          'Only applies to files the plugin is responsible for (e.g. clipboard pastes).'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteLocalAfterUpload)
          .onChange(async (value) => {
            this.plugin.settings.deleteLocalAfterUpload = value;
            await this.plugin.saveSettings();
          })
      );
  }

  /** Health probe + config dump for sanity-checking the server. */
  private renderDiagnosticsSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Diagnostics' });

    const statusEl = containerEl.createEl('div', {
      cls: 'zpic-status',
      text: 'Click "Check server" to test the connection.',
    });

    new Setting(containerEl)
      .setName('Check server')
      .setDesc('Verify the server is reachable and report the active uploader.')
      .addButton((button) =>
        button
          .setButtonText('Check server')
          .setCta()
          .onClick(async () => {
            statusEl.setText('Checking…');
            const probe = this.probe ?? new ZpicUploader(this.plugin.settings);
            this.probe = probe;
            probe.updateSettings(this.plugin.settings);

            const healthy = await probe.checkHealth();
            if (!healthy) {
              statusEl.setText(
                'Server is unreachable. Run `zpic server start` in a terminal.'
              );
              new Notice('Cannot connect to zpic server', 5000);
              return;
            }

            const config = await probe.getConfig();
            if (!config) {
              statusEl.setText('Server is healthy but /config is unavailable.');
              return;
            }
            statusEl.setText(
              `OK · uploader: ${config.currentUploader} ` +
                `(${config.uploaders.length} available) · zpic v${config.version}`
            );
          })
      );
  }
}

/** Persisted-shape validation for loaded settings. */
export function normalizeSettings(
  raw: Partial<ZpicSettings> | undefined | null
): ZpicSettings {
  const merged: ZpicSettings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };

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
