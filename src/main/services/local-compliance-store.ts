import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  ComplianceRuleSchema,
  ComplianceRuleSetSchema,
  type ComplianceRuleCreateInput,
  type ComplianceRuleUpdateInput,
  type ComplianceRuleSetCreateInput,
} from '@shared/schemas';
import {
  DEFAULT_AGENCY_RULE_SET_ID,
  DEFAULT_INSURANCE_PRESET_RULE_SET_ID,
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_PARENT_ORGANIZATION_ID,
  DEFAULT_TENANT_ID,
} from '@shared/organization-constants';
import type { ComplianceRule, ComplianceRuleSet, Industry } from '@shared/types';

const LocalComplianceDataSchema = z.object({
  rules: z.array(ComplianceRuleSchema),
  ruleSets: z.array(ComplianceRuleSetSchema).default([]),
});

interface LocalComplianceData {
  rules: ComplianceRule[];
  ruleSets: ComplianceRuleSet[];
}

export class LocalComplianceStore {
  private cache: LocalComplianceData | null = null;

  constructor(private readonly filePath = join(defaultUserDataPath(), 'local-compliance.json')) {}

  async listRules(
    industry?: Industry,
    scope?: { tenantId: string; organizationId: string },
    productCategory?: string,
  ): Promise<ComplianceRule[]> {
    const data = await this.get();
    const activeRuleSetIds = new Set(
      data.ruleSets
        .filter((ruleSet) => ruleSet.active && ruleSet.approvalStatus === 'approved')
        .map((ruleSet) => ruleSet.id),
    );
    return data.rules
      .filter(
        (rule) =>
          activeRuleSetIds.has(rule.ruleSetId) &&
          (!industry || rule.industry === industry) &&
          (!productCategory ||
            rule.productCategory === productCategory ||
            rule.productCategory === 'insurance_general') &&
          (!scope ||
            (rule.tenantId === scope.tenantId &&
              (rule.organizationId === scope.organizationId ||
                rule.organizationId === DEFAULT_PARENT_ORGANIZATION_ID))),
      )
      .sort((left, right) => left.priority - right.priority);
  }

  async createRule(input: ComplianceRuleCreateInput): Promise<ComplianceRule> {
    const now = new Date().toISOString();
    const rule: ComplianceRule = {
      id: randomUUID(),
      ruleSetId: input.ruleSetId,
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
      priority: input.priority,
      createdAt: now,
      updatedAt: now,
    };
    const data = await this.get();
    this.assertRuleSetEditable(data, input.ruleSetId);
    const next = { ...data, rules: [rule, ...data.rules] };
    this.cache = next;
    await this.persist(next);
    return rule;
  }

  async listRuleSets(scope: { tenantId: string; organizationId: string }): Promise<ComplianceRuleSet[]> {
    const data = await this.get();
    return data.ruleSets.filter(
      (ruleSet) =>
        ruleSet.tenantId === scope.tenantId &&
        (ruleSet.organizationId === scope.organizationId ||
          ruleSet.organizationId === DEFAULT_PARENT_ORGANIZATION_ID),
    );
  }

  async listRulesForSet(ruleSetId: string): Promise<ComplianceRule[]> {
    return (await this.get()).rules
      .filter((rule) => rule.ruleSetId === ruleSetId)
      .sort((left, right) => left.priority - right.priority);
  }

  async createRuleSet(
    scope: { tenantId: string; organizationId: string },
    input: ComplianceRuleSetCreateInput,
  ): Promise<ComplianceRuleSet> {
    const now = new Date().toISOString();
    const ruleSet: ComplianceRuleSet = {
      id: randomUUID(),
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      parentRuleSetId: null,
      name: input.name,
      productCategory: input.productCategory,
      presetKey: input.presetKey ?? null,
      active: false,
      version: 1,
      approvalStatus: 'draft',
      approvedAt: null,
      approvedByUserId: null,
      createdAt: now,
      updatedAt: now,
    };
    const data = await this.get();
    const next = { ...data, ruleSets: [ruleSet, ...data.ruleSets] };
    this.cache = next;
    await this.persist(next);
    return ruleSet;
  }

  async setRuleSetActive(id: string, active: boolean): Promise<ComplianceRuleSet> {
    const data = await this.get();
    const current = data.ruleSets.find((ruleSet) => ruleSet.id === id);
    if (!current) {
      throw new Error('Compliance rule set was not found');
    }
    if (active && current.approvalStatus !== 'approved') {
      throw new Error('Only approved compliance rule sets can be activated');
    }
    const updated = { ...current, active, updatedAt: new Date().toISOString() };
    const next = {
      ...data,
      ruleSets: data.ruleSets.map((ruleSet) => (ruleSet.id === id ? updated : ruleSet)),
    };
    this.cache = next;
    await this.persist(next);
    return updated;
  }

  async submitRuleSet(id: string): Promise<ComplianceRuleSet> {
    return this.updateRuleSetStatus(id, 'pending_review', null);
  }

  async reviewRuleSet(
    id: string,
    approved: boolean,
    approvedByUserId: string,
  ): Promise<ComplianceRuleSet> {
    return this.updateRuleSetStatus(id, approved ? 'approved' : 'rejected', approvedByUserId);
  }

  async createRuleSetRevision(id: string): Promise<ComplianceRuleSet> {
    const data = await this.get();
    const current = data.ruleSets.find((ruleSet) => ruleSet.id === id);
    if (!current || current.approvalStatus !== 'approved') {
      throw new Error('Only approved rule sets can create a new revision');
    }
    const now = new Date().toISOString();
    const revision: ComplianceRuleSet = {
      ...current,
      id: randomUUID(),
      parentRuleSetId: current.parentRuleSetId ?? current.id,
      name: `${current.name} v${current.version + 1}`,
      presetKey: null,
      active: false,
      version: current.version + 1,
      approvalStatus: 'draft',
      approvedAt: null,
      approvedByUserId: null,
      createdAt: now,
      updatedAt: now,
    };
    const clonedRules = data.rules
      .filter((rule) => rule.ruleSetId === current.id)
      .map((rule) => ({
        ...rule,
        id: randomUUID(),
        ruleSetId: revision.id,
        createdAt: now,
        updatedAt: now,
      }));
    const next = {
      rules: [...clonedRules, ...data.rules],
      ruleSets: [revision, ...data.ruleSets],
    };
    this.cache = next;
    await this.persist(next);
    return revision;
  }

  async updateRule(input: ComplianceRuleUpdateInput): Promise<ComplianceRule> {
    const data = await this.get();
    const current = data.rules.find((rule) => rule.id === input.id);
    if (!current) {
      throw new Error('Compliance rule was not found');
    }
    this.assertRuleSetEditable(data, current.ruleSetId);
    const updated = { ...current, ...input, updatedAt: new Date().toISOString() };
    const next = {
      ...data,
      rules: data.rules.map((rule) => (rule.id === input.id ? updated : rule)),
    };
    this.cache = next;
    await this.persist(next);
    return updated;
  }

  async deleteRule(id: string): Promise<void> {
    const data = await this.get();
    const current = data.rules.find((rule) => rule.id === id);
    if (!current) {
      throw new Error('Compliance rule was not found');
    }
    this.assertRuleSetEditable(data, current.ruleSetId);
    const next = { ...data, rules: data.rules.filter((rule) => rule.id !== id) };
    this.cache = next;
    await this.persist(next);
  }

  private async updateRuleSetStatus(
    id: string,
    approvalStatus: ComplianceRuleSet['approvalStatus'],
    approvedByUserId: string | null,
  ): Promise<ComplianceRuleSet> {
    const data = await this.get();
    const current = data.ruleSets.find((ruleSet) => ruleSet.id === id);
    if (!current) {
      throw new Error('Compliance rule set was not found');
    }
    if (approvalStatus === 'pending_review' && !['draft', 'rejected'].includes(current.approvalStatus)) {
      throw new Error('Only draft or rejected rule sets can be submitted');
    }
    if (
      approvalStatus === 'pending_review' &&
      !data.rules.some((rule) => rule.ruleSetId === current.id)
    ) {
      throw new Error('Rule set must contain at least one rule before submission');
    }
    if (['approved', 'rejected'].includes(approvalStatus) && current.approvalStatus !== 'pending_review') {
      throw new Error('Only pending rule sets can be reviewed');
    }
    const now = new Date().toISOString();
    const updated: ComplianceRuleSet = {
      ...current,
      active: approvalStatus === 'approved',
      version: current.version,
      approvalStatus,
      approvedAt: approvalStatus === 'approved' ? now : null,
      approvedByUserId: approvalStatus === 'approved' ? approvedByUserId : null,
      updatedAt: now,
    };
    const revisionRootId = current.parentRuleSetId ?? current.id;
    const next = {
      ...data,
      ruleSets: data.ruleSets.map((ruleSet) => {
        if (ruleSet.id === id) return updated;
        const candidateRootId = ruleSet.parentRuleSetId ?? ruleSet.id;
        return approvalStatus === 'approved' && candidateRootId === revisionRootId
          ? { ...ruleSet, active: false, updatedAt: now }
          : ruleSet;
      }),
    };
    this.cache = next;
    await this.persist(next);
    return updated;
  }

  private assertRuleSetEditable(data: LocalComplianceData, ruleSetId: string): void {
    const ruleSet = data.ruleSets.find((candidate) => candidate.id === ruleSetId);
    if (!ruleSet || !['draft', 'rejected'].includes(ruleSet.approvalStatus)) {
      throw new Error('Only draft or rejected rule sets can be edited');
    }
  }

  private async get(): Promise<LocalComplianceData> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = LocalComplianceDataSchema.parse(JSON.parse(raw));
      if (parsed.ruleSets.length === 0) {
        parsed.ruleSets = createDefaultRuleSets();
        await this.persist(parsed);
      }
      this.cache = parsed;
      return this.cache;
    } catch {
      this.cache = { rules: createDefaultInsuranceRules(), ruleSets: createDefaultRuleSets() };
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
    ruleSetId: DEFAULT_INSURANCE_PRESET_RULE_SET_ID,
    tenantId: DEFAULT_TENANT_ID,
    organizationId: DEFAULT_PARENT_ORGANIZATION_ID,
    companyId: 'default',
    industry: 'insurance',
    productCategory: 'insurance_general',
    severity: input.severity,
    ruleType: input.ruleType,
    pattern: input.pattern,
    reason: input.reason,
    recommendedPhrase: input.recommendedPhrase,
    priority: 100,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function createDefaultRuleSets(): ComplianceRuleSet[] {
  const now = new Date().toISOString();
  return [
    {
      id: DEFAULT_INSURANCE_PRESET_RULE_SET_ID,
      tenantId: DEFAULT_TENANT_ID,
      organizationId: DEFAULT_PARENT_ORGANIZATION_ID,
      parentRuleSetId: null,
      name: '保険会社標準コンプライアンス',
      productCategory: 'insurance_general',
      presetKey: 'insurance_standard_v1',
      active: true,
      version: 1,
      approvalStatus: 'approved',
      approvedAt: now,
      approvedByUserId: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: DEFAULT_AGENCY_RULE_SET_ID,
      tenantId: DEFAULT_TENANT_ID,
      organizationId: DEFAULT_ORGANIZATION_ID,
      parentRuleSetId: null,
      name: '代理店独自ルール',
      productCategory: 'real_estate',
      presetKey: null,
      active: true,
      version: 1,
      approvalStatus: 'approved',
      approvedAt: now,
      approvedByUserId: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function defaultUserDataPath(): string {
  return process.env.SALES_TALK_USER_DATA_PATH ?? app?.getPath?.('userData') ?? process.cwd();
}
