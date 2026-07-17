import { mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export async function writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;

  try {
    const handle = await open(temporaryPath, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    renamed = true;
    await fsyncDirectory(directory);
  } finally {
    if (!renamed) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function renameFileAtomic(temporaryPath: string, filePath: string): Promise<void> {
  await rename(temporaryPath, filePath);
  await fsyncDirectory(dirname(filePath));
}

export async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
