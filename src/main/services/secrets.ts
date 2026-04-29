import { app, safeStorage } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretKeyInput } from '@shared/schemas';

export class SecretStore {
  constructor(private readonly directory = defaultSecretDirectory()) {}

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

  async get(key: SecretKeyInput): Promise<string | null> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption is not available');
    }
    try {
      const encrypted = await readFile(this.pathFor(key));
      return safeStorage.decryptString(encrypted);
    } catch {
      return null;
    }
  }

  async delete(key: SecretKeyInput): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: SecretKeyInput): string {
    return join(this.directory, `${key}.bin`);
  }
}

function defaultSecretDirectory(): string {
  const userDataPath = app?.getPath?.('userData');
  return join(userDataPath ?? process.cwd(), 'secrets');
}

export const secretStore = new SecretStore();
