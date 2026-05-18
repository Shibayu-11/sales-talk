import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { KnowledgeEntrySchema, type KnowledgeCreateInput } from '@shared/schemas';
import type { KnowledgeEntry, ProductId } from '@shared/types';

const LocalKnowledgeDataSchema = z.object({
  entries: z.array(KnowledgeEntrySchema),
});
type ParsedKnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

interface LocalKnowledgeData {
  entries: KnowledgeEntry[];
}

const DEFAULT_LOCAL_KNOWLEDGE: LocalKnowledgeData = {
  entries: [],
};

export class LocalKnowledgeStore {
  private cache: LocalKnowledgeData | null = null;

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-knowledge.json')) {}

  async list(productId: ProductId): Promise<KnowledgeEntry[]> {
    const data = await this.get();
    return data.entries.filter((entry) => entry.productId === productId);
  }

  async search(query: string, productId: ProductId, limit: number): Promise<KnowledgeEntry[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const entries = await this.list(productId);
    return entries
      .filter((entry) =>
        [entry.objectionType, entry.trigger, entry.response, entry.reasoning]
          .join('\n')
          .toLowerCase()
          .includes(normalizedQuery),
      )
      .slice(0, limit);
  }

  async create(input: KnowledgeCreateInput): Promise<KnowledgeEntry> {
    const now = new Date().toISOString();
    const entry: KnowledgeEntry = {
      id: randomUUID(),
      productId: input.productId,
      objectionType: input.objectionType,
      trigger: input.trigger,
      response: input.response,
      reasoning: input.reasoning ?? '',
      riskFlags: input.riskFlags ?? [],
      createdAt: now,
      updatedAt: now,
    };
    const data = await this.get();
    const next = { entries: [entry, ...data.entries] };
    this.cache = next;
    await this.persist(next);
    return entry;
  }

  async delete(id: string): Promise<void> {
    const data = await this.get();
    const next = { entries: data.entries.filter((entry) => entry.id !== id) };
    this.cache = next;
    await this.persist(next);
  }

  private async get(): Promise<LocalKnowledgeData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = LocalKnowledgeDataSchema.parse(JSON.parse(raw));
      const data: LocalKnowledgeData = {
        entries: parsed.entries.map(normalizeKnowledgeEntry),
      };
      this.cache = data;
      return data;
    } catch {
      this.cache = DEFAULT_LOCAL_KNOWLEDGE;
      await this.persist(this.cache);
      return this.cache;
    }
  }

  private async persist(data: LocalKnowledgeData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

export const localKnowledgeStore = new LocalKnowledgeStore();

function normalizeKnowledgeEntry(entry: ParsedKnowledgeEntry): KnowledgeEntry {
  const { embedding, ...rest } = entry;
  return embedding === undefined ? rest : { ...rest, embedding };
}

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}
