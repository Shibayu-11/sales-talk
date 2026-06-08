import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalComplianceStore } from '../../src/main/services/local-compliance-store';

const scope = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
};

describe('LocalComplianceStore', () => {
  it('inherits insurer presets and filters active rules by product', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sales-talk-local-compliance-'));
    try {
      const store = new LocalComplianceStore(join(directory, 'compliance.json'));
      const ruleSets = await store.listRuleSets(scope);
      const preset = ruleSets.find((ruleSet) => ruleSet.presetKey === 'insurance_standard_v1');

      expect(preset).toMatchObject({
        organizationId: '00000000-0000-4000-8000-000000000003',
        productCategory: 'insurance_general',
        active: true,
      });
      await expect(store.listRules('insurance', scope, 'real_estate')).resolves.not.toHaveLength(0);

      const agencySet = await store.createRuleSet(scope, {
        name: '不動産向け重点ルール',
        productCategory: 'real_estate',
      });
      expect(agencySet).toMatchObject({ active: false, approvalStatus: 'draft', version: 1 });
      const rule = await store.createRule({
        ruleSetId: agencySet.id,
        ...scope,
        companyId: scope.organizationId,
        industry: 'insurance',
        productCategory: 'real_estate',
        severity: 'high',
        ruleType: 'prohibited_expression',
        pattern: '絶対安全',
        reason: '断定表現です。',
        recommendedPhrase: 'リスクを説明します。',
        priority: 20,
      });
      await expect(store.updateRule({ ...rule, priority: 10 })).resolves.toMatchObject({
        priority: 10,
      });
      await expect(store.submitRuleSet(agencySet.id)).resolves.toMatchObject({
        approvalStatus: 'pending_review',
      });
      await expect(
        store.reviewRuleSet(agencySet.id, true, '00000000-0000-4000-8000-000000000004'),
      ).resolves.toMatchObject({
        active: true,
        approvalStatus: 'approved',
        version: 1,
      });
      const revision = await store.createRuleSetRevision(agencySet.id);
      expect(revision).toMatchObject({
        active: false,
        approvalStatus: 'draft',
        version: 2,
      });
      await store.submitRuleSet(revision.id);
      await store.reviewRuleSet(
        revision.id,
        true,
        '00000000-0000-4000-8000-000000000004',
      );
      await expect(store.listRuleSets(scope)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: agencySet.id, active: false }),
          expect.objectContaining({ id: revision.id, active: true, version: 2 }),
        ]),
      );
      await expect(store.deleteRule(rule.id)).rejects.toThrow('Only draft or rejected');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
