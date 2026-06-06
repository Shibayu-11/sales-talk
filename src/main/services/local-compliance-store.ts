import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  ComplianceRuleSchema,
  type ComplianceRuleCreateInput,
} from '@shared/schemas';
import type { ComplianceRule, Industry } from '@shared/types';

const LocalComplianceDataSchema = z.object({
  rules: z.array(ComplianceRuleSchema),
});

interface LocalComplianceData {
  rules: ComplianceRule[];
}

export class LocalComplianceStore {
  private cache: LocalComplianceData | null = null;

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-compliance.json')) {}

  async listRules(
    industry?: Industry,
    scope?: { tenantId: string; organizationId: string },
  ): Promise<ComplianceRule[]> {
    const data = await this.get();
    return data.rules.filter(
      (rule) =>
        (!industry || rule.industry === industry) &&
        (!scope ||
          (rule.tenantId === scope.tenantId &&
            (rule.organizationId === scope.organizationId ||
              rule.organizationId === '00000000-0000-4000-8000-000000000003'))),
    );
  }

  async createRule(input: ComplianceRuleCreateInput): Promise<ComplianceRule> {
    const now = new Date().toISOString();
    const rule: ComplianceRule = {
      id: randomUUID(),
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      companyId: input.companyId,
      industry: input.industry,
      productCategory: input.productCategory,
      severity: input.severity,
      ruleType: input.ruleType,
      pattern: input.pattern,
      reason: input.reason,
      recommendedPhrase: input.recommendedPhrase,
      createdAt: now,
      updatedAt: now,
    };
    const data = await this.get();
    const next = { rules: [rule, ...data.rules] };
    this.cache = next;
    await this.persist(next);
    return rule;
  }

  async deleteRule(id: string): Promise<void> {
    const data = await this.get();
    const next = { rules: data.rules.filter((rule) => rule.id !== id) };
    this.cache = next;
    await this.persist(next);
  }

  private async get(): Promise<LocalComplianceData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.cache = LocalComplianceDataSchema.parse(JSON.parse(raw));
      return this.cache;
    } catch {
      this.cache = { rules: createDefaultInsuranceRules() };
      await this.persist(this.cache);
      return this.cache;
    }
  }

  private async persist(data: LocalComplianceData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}

export const localComplianceStore = new LocalComplianceStore();

function createDefaultInsuranceRules(): ComplianceRule[] {
  const now = new Date().toISOString();
  return [
    buildDefaultRule({
      now,
      severity: 'critical',
      ruleType: 'prohibited_expression',
      pattern: '告知しなくて大丈夫',
      reason: '告知義務違反を誘導するおそれがあります。',
      recommendedPhrase: '告知事項は正確に申告いただく必要があります。',
    }),
    buildDefaultRule({
      now,
      severity: 'high',
      ruleType: 'prohibited_expression',
      pattern: '絶対儲かります',
      reason: '将来利益を断定する表現は顧客誤認につながります。',
      recommendedPhrase: '将来の成果は保証できないため、リスクと条件を確認します。',
    }),
    buildDefaultRule({
      now,
      severity: 'high',
      ruleType: 'prohibited_expression',
      pattern: '元本保証',
      reason: '商品内容によっては元本保証と誤認させるおそれがあります。',
      recommendedPhrase: '元本保証の有無とリスクを資料に沿って確認します。',
    }),
    buildDefaultRule({
      now,
      severity: 'medium',
      ruleType: 'caution_expression',
      pattern: 'デメリットはない',
      reason: '重要事項や不利益事項の説明不足につながるおそれがあります。',
      recommendedPhrase: 'メリットだけでなく注意点もあわせて説明します。',
    }),
  ];
}

function buildDefaultRule(input: {
  now: string;
  severity: ComplianceRule['severity'];
  ruleType: ComplianceRule['ruleType'];
  pattern: string;
  reason: string;
  recommendedPhrase: string;
}): ComplianceRule {
  return {
    id: randomUUID(),
    tenantId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    companyId: 'default',
    industry: 'insurance',
    productCategory: 'insurance_general',
    severity: input.severity,
    ruleType: input.ruleType,
    pattern: input.pattern,
    reason: input.reason,
    recommendedPhrase: input.recommendedPhrase,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}
