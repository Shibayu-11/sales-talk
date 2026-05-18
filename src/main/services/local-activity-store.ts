import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ActionItemTaskSchema, MeetingMinuteSchema } from '@shared/schemas';
import type { ActionItemTask, MeetingMinute } from '@shared/types';

const LocalActivityDataSchema = z.object({
  latestMeetingMinute: MeetingMinuteSchema.nullable(),
  tasks: z.array(ActionItemTaskSchema),
});

interface LocalActivityData {
  latestMeetingMinute: MeetingMinute | null;
  tasks: ActionItemTask[];
}

const DEFAULT_ACTIVITY_DATA: LocalActivityData = {
  latestMeetingMinute: null,
  tasks: [],
};

export class LocalActivityStore {
  private cache: LocalActivityData | null = null;

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-activity.json')) {}

  async getLatestMeetingMinute(): Promise<MeetingMinute | null> {
    return (await this.get()).latestMeetingMinute;
  }

  async setLatestMeetingMinute(minute: MeetingMinute): Promise<MeetingMinute> {
    const data = await this.get();
    const next = { ...data, latestMeetingMinute: minute };
    this.cache = next;
    await this.persist(next);
    return minute;
  }

  async listTasks(): Promise<ActionItemTask[]> {
    return (await this.get()).tasks;
  }

  async createTask(task: ActionItemTask): Promise<ActionItemTask> {
    const data = await this.get();
    const next = { ...data, tasks: [task, ...data.tasks] };
    this.cache = next;
    await this.persist(next);
    return task;
  }

  async completeTask(id: string, completed: boolean): Promise<ActionItemTask> {
    const data = await this.get();
    const task = data.tasks.find((candidate) => candidate.id === id);
    if (!task) {
      throw new Error('Task was not found');
    }

    const nextTask = { ...task, completed };
    const next = {
      ...data,
      tasks: data.tasks.map((candidate) => (candidate.id === id ? nextTask : candidate)),
    };
    this.cache = next;
    await this.persist(next);
    return nextTask;
  }

  private async get(): Promise<LocalActivityData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = LocalActivityDataSchema.parse(JSON.parse(raw));
      return this.cache;
    } catch {
      this.cache = DEFAULT_ACTIVITY_DATA;
      await this.persist(this.cache);
      return this.cache;
    }
  }

  private async persist(data: LocalActivityData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

export const localActivityStore = new LocalActivityStore();

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}
