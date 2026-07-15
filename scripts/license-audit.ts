import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type PackageLockPackage = {
  version?: unknown;
  license?: unknown;
  dev?: unknown;
};

type PackageLock = {
  lockfileVersion?: unknown;
  packages?: unknown;
};

export type AuditedPackage = {
  name: string;
  version: string;
  license: string | null;
  path: string;
};

export type LicenseFinding = {
  name: string;
  version: string;
  license: string | null;
};

export type LicenseAuditResult = {
  auditedCount: number;
  unknownLicenses: LicenseFinding[];
  prohibitedLicenses: LicenseFinding[];
};

type LicenseExpression =
  | { kind: 'license'; id: string }
  | { kind: 'and'; left: LicenseExpression; right: LicenseExpression }
  | { kind: 'or'; left: LicenseExpression; right: LicenseExpression };

const forbiddenLicensePrefixes = ['GPL', 'AGPL', 'LGPL', 'SSPL', 'CPAL'];

export function auditPackageLock(lock: unknown): LicenseAuditResult {
  const packages = readPackageEntries(lock);
  const productionPackages = packages.filter((entry) => {
    const [packagePath, packageInfo] = entry;
    return packagePath.startsWith('node_modules/') && packageInfo.dev !== true;
  });

  const auditedPackages = productionPackages.map(([packagePath, packageInfo]) =>
    toAuditedPackage(packagePath, packageInfo),
  );

  return auditedPackages.reduce<LicenseAuditResult>(
    (result, packageInfo) => {
      const license = normalizeLicense(packageInfo.license);
      const finding: LicenseFinding = {
        name: packageInfo.name,
        version: packageInfo.version,
        license: packageInfo.license,
      };

      if (license === null || isUnknownLicense(license)) {
        result.unknownLicenses.push(finding);
        return result;
      }

      if (!isLicenseExpressionAllowed(license)) {
        result.prohibitedLicenses.push(finding);
      }

      return result;
    },
    { auditedCount: auditedPackages.length, unknownLicenses: [], prohibitedLicenses: [] },
  );
}

export function isLicenseExpressionAllowed(license: string): boolean {
  const tokens = tokenizeLicenseExpression(license);
  if (tokens.length === 0) {
    return true;
  }

  const parser = new LicenseExpressionParser(tokens);
  const expression = parser.parse();
  if (expression === null || !parser.isComplete()) {
    return true;
  }

  return hasAllowedLicensePath(expression);
}

export function isUnknownLicense(license: string | null): boolean {
  if (license === null) {
    return true;
  }

  const normalized = license.trim().toUpperCase();
  return normalized === '' || normalized === 'UNKNOWN' || normalized.startsWith('SEE LICENSE');
}

function readPackageEntries(lock: unknown): Array<[string, PackageLockPackage]> {
  if (!isObjectRecord(lock)) {
    throw new Error('package-lock.json must be a JSON object');
  }

  const packageLock = lock as PackageLock;
  if (packageLock.lockfileVersion !== 3) {
    throw new Error('package-lock.json lockfileVersion must be 3');
  }

  if (!isObjectRecord(packageLock.packages)) {
    throw new Error('package-lock.json packages must be a JSON object');
  }

  return Object.entries(packageLock.packages).flatMap(([packagePath, packageInfo]) => {
    if (!isObjectRecord(packageInfo)) {
      return [];
    }

    return [[packagePath, packageInfo as PackageLockPackage]];
  });
}

function toAuditedPackage(packagePath: string, packageInfo: PackageLockPackage): AuditedPackage {
  return {
    name: packageNameFromPath(packagePath),
    version: typeof packageInfo.version === 'string' ? packageInfo.version : 'unknown',
    license: typeof packageInfo.license === 'string' ? packageInfo.license : null,
    path: packagePath,
  };
}

function packageNameFromPath(packagePath: string): string {
  const parts = packagePath.split('/');
  const nodeModulesIndex = parts.lastIndexOf('node_modules');
  const firstNamePart = parts[nodeModulesIndex + 1];

  if (firstNamePart === undefined) {
    return packagePath;
  }

  if (firstNamePart.startsWith('@')) {
    const scopedNamePart = parts[nodeModulesIndex + 2];
    return scopedNamePart === undefined ? firstNamePart : `${firstNamePart}/${scopedNamePart}`;
  }

  return firstNamePart;
}

function normalizeLicense(license: string | null): string | null {
  return license === null ? null : license.trim();
}

function tokenizeLicenseExpression(license: string): string[] {
  const matches = license.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9.+-]+/g);
  return matches ?? [];
}

function hasAllowedLicensePath(expression: LicenseExpression): boolean {
  switch (expression.kind) {
    case 'license':
      return !isForbiddenLicenseId(expression.id);
    case 'and':
      return hasAllowedLicensePath(expression.left) && hasAllowedLicensePath(expression.right);
    case 'or':
      return hasAllowedLicensePath(expression.left) || hasAllowedLicensePath(expression.right);
  }
}

function isForbiddenLicenseId(licenseId: string): boolean {
  const normalized = licenseId.toUpperCase();
  return forbiddenLicensePrefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}-`),
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class LicenseExpressionParser {
  private index = 0;

  constructor(private readonly tokens: string[]) {}

  parse(): LicenseExpression | null {
    return this.parseOr();
  }

  isComplete(): boolean {
    return this.index === this.tokens.length;
  }

  private parseOr(): LicenseExpression | null {
    let expression = this.parseAnd();
    if (expression === null) {
      return null;
    }

    while (this.peek() === 'OR') {
      this.index += 1;
      const right = this.parseAnd();
      if (right === null) {
        return null;
      }
      expression = { kind: 'or', left: expression, right };
    }

    return expression;
  }

  private parseAnd(): LicenseExpression | null {
    let expression = this.parseTerm();
    if (expression === null) {
      return null;
    }

    while (this.peek() === 'AND') {
      this.index += 1;
      const right = this.parseTerm();
      if (right === null) {
        return null;
      }
      expression = { kind: 'and', left: expression, right };
    }

    return expression;
  }

  private parseTerm(): LicenseExpression | null {
    const token = this.peek();
    if (token === undefined) {
      return null;
    }

    if (token === '(') {
      this.index += 1;
      const expression = this.parseOr();
      if (expression === null || this.peek() !== ')') {
        return null;
      }
      this.index += 1;
      return expression;
    }

    if (token === ')' || token === 'AND' || token === 'OR' || token === 'WITH') {
      return null;
    }

    this.index += 1;
    if (this.peek() === 'WITH') {
      this.index += 1;
      if (this.peek() === undefined) {
        return null;
      }
      this.index += 1;
    }

    return { kind: 'license', id: token };
  }

  private peek(): string | undefined {
    return this.tokens[this.index];
  }
}

function formatFinding(finding: LicenseFinding): string {
  return `- ${finding.name}@${finding.version}: ${finding.license ?? 'missing'}`;
}

function printAuditResult(result: LicenseAuditResult): void {
  process.stdout.write(`Audited production packages: ${result.auditedCount}\n`);
  process.stdout.write(`Unknown license warnings: ${result.unknownLicenses.length}\n`);

  if (result.unknownLicenses.length > 0) {
    process.stdout.write('Packages with missing/unknown/SEE LICENSE license values:\n');
    process.stdout.write(`${result.unknownLicenses.map(formatFinding).join('\n')}\n`);
  }

  if (result.prohibitedLicenses.length > 0) {
    process.stderr.write('Prohibited license packages found:\n');
    process.stderr.write(`${result.prohibitedLicenses.map(formatFinding).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('License audit: pass\n');
}

function runCli(): void {
  const lockPath = resolve(process.cwd(), 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as unknown;
  printAuditResult(auditPackageLock(lock));
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (import.meta.url === invokedPath) {
  runCli();
}
