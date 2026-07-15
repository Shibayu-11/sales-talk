import { describe, expect, it } from 'vitest';
import { auditPackageLock, isLicenseExpressionAllowed, isUnknownLicense } from '../../scripts/license-audit';

describe('license audit', () => {
  it('audits production node_modules packages from package-lock v3 packages', () => {
    const result = auditPackageLock({
      lockfileVersion: 3,
      packages: {
        '': { name: 'sales-talk', version: '0.0.1', license: 'UNLICENSED' },
        'node_modules/allowed': { version: '1.0.0', license: 'MIT' },
        'node_modules/dev-only': { version: '1.0.0', license: 'GPL-3.0-only', dev: true },
        'node_modules/@scope/package': { version: '2.0.0', license: 'Apache-2.0' },
        'node_modules/parent/node_modules/nested': { version: '3.0.0', license: 'BSD-3-Clause' },
      },
    });

    expect(result).toEqual({
      auditedCount: 3,
      unknownLicenses: [],
      prohibitedLicenses: [],
    });
  });

  it('fails AND expressions that require a prohibited license', () => {
    const result = auditPackageLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/copyleft': { version: '1.0.0', license: 'MIT AND GPL-3.0-only' },
        'node_modules/sspl': { version: '2.0.0', license: 'SSPL-1.0' },
        'node_modules/cpal': { version: '3.0.0', license: 'CPAL-1.0' },
      },
    });

    expect(result.prohibitedLicenses).toEqual([
      { name: 'copyleft', version: '1.0.0', license: 'MIT AND GPL-3.0-only' },
      { name: 'sspl', version: '2.0.0', license: 'SSPL-1.0' },
      { name: 'cpal', version: '3.0.0', license: 'CPAL-1.0' },
    ]);
  });

  it('allows OR expressions when at least one alternative is acceptable', () => {
    expect(isLicenseExpressionAllowed('GPL-2.0-only OR MIT')).toBe(true);
    expect(isLicenseExpressionAllowed('(LGPL-3.0-only OR Apache-2.0) AND MIT')).toBe(true);
    expect(isLicenseExpressionAllowed('AGPL-3.0-only OR SSPL-1.0')).toBe(false);
  });

  it('tracks missing, unknown, and SEE LICENSE values as warnings only', () => {
    const result = auditPackageLock({
      lockfileVersion: 3,
      packages: {
        'node_modules/missing': { version: '1.0.0' },
        'node_modules/unknown': { version: '2.0.0', license: 'UNKNOWN' },
        'node_modules/see-license': { version: '3.0.0', license: 'SEE LICENSE IN LICENSE' },
      },
    });

    expect(result.prohibitedLicenses).toEqual([]);
    expect(result.unknownLicenses).toEqual([
      { name: 'missing', version: '1.0.0', license: null },
      { name: 'unknown', version: '2.0.0', license: 'UNKNOWN' },
      { name: 'see-license', version: '3.0.0', license: 'SEE LICENSE IN LICENSE' },
    ]);
    expect(isUnknownLicense(null)).toBe(true);
  });
});
