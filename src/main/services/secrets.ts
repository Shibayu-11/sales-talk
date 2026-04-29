import { app, safeStorage } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretKeyInput } from '@shared/schemas';

export class SecretStore {
  constructor(private readonly directory = join(app.getPath('userData'), 'secrets')) {}

  async set(key: SecretKeyInput, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption is not available');
    }
    await mkdir(this.directory, { recursive: true });
    const encrypted = safeStorage.encryptString(value);
    await writeFile(this.pathFor(key), encrypted);
  }

  async has(key: SecretKeyInput): Promise<boolean> {
    try {
      await readFile(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: SecretKeyInput): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: SecretKeyInput): string {
    return join(this.directory, `${key}.bin`);
  }
}

export const secretStore = new SecretStore();
