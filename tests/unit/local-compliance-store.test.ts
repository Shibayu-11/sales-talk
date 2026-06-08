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
      await expect(store.setRuleSetActive(agencySet.id, false)).resolves.toMatchObject({
        active: false,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
