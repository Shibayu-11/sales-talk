import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_HOTKEYS, SETTINGS_SCHEMA_VERSION } from '@shared/constants';
import { AppSettingsSchema } from '@shared/schemas';
import type { AppSettingsPatchInput } from '@shared/schemas';
import type { AppSettings } from '@shared/types';

const DEFAULT_SETTINGS: AppSettings = {
  selectedProductId: 'real_estate',
  overlayPosition: { x: 0, y: 80, display: 0 },
  hotkeys: { ...DEFAULT_HOTKEYS },
  consentNoticeMode: 'verbal',
  schemaVersion: SETTINGS_SCHEMA_VERSION,
};

export class SettingsStore {
  private cache: AppSettings | null = null;

  constructor(private readonly filePath = join(app.getPath('userData'), 'settings.json')) {}

  async get(): Promise<AppSettings> {
    if (this.cache) return this.cache;

    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = AppSettingsSchema.parse(JSON.parse(raw));
      return this.cache;
    } catch {
      this.cache = DEFAULT_SETTINGS;
      await this.persist(this.cache);
      return this.cache;
    }
  }

  async set(patch: AppSettingsPatchInput): Promise<AppSettings> {
    const current = await this.get();
    const next = AppSettingsSchema.parse({
      ...current,
      ...patch,
      overlayPosition: patch.overlayPosition ?? current.overlayPosition,
      hotkeys: patch.hotkeys ? { ...current.hotkeys, ...patch.hotkeys } : current.hotkeys,
      schemaVersion: SETTINGS_SCHEMA_VERSION,
    });
    this.cache = next;
    await this.persist(next);
    return next;
  }

  private async persist(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }
}

export const settingsStore = new SettingsStore();
