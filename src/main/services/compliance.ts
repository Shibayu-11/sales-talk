import { randomUUID } from 'node:crypto';
import type { ComplianceFinding, ComplianceRule, Transcript } from '@shared/types';

export function evaluateCompliance(input: {
  meetingId: string;
  transcripts: Transcript[];
  rules: ComplianceRule[];
}): ComplianceFinding[] {
  const finalTexts = input.transcripts.filter((transcript) => transcript.isFinal);
  const findings: ComplianceFinding[] = [];

  for (const rule of input.rules) {
    if (rule.ruleType === 'required_disclosure') {
      if (!containsPattern(finalTexts.map((transcript) => transcript.text).join('\n'), rule.pattern)) {
        findings.push(createFinding(rule, '必須説明が transcript 内で確認できませんでした。', 0));
      }
      continue;
    }

    for (const transcript of finalTexts) {
      if (!containsPattern(transcript.text, rule.pattern)) {
        continue;
      }
      findings.push(createFinding(rule, transcript.text, transcript.startMs));
    }
  }

  return findings;
}

function createFinding(
  rule: ComplianceRule,
  quotedText: string,
  detectedAtMs: number,
): ComplianceFinding {
  return {
    id: randomUUID(),
    ruleId: rule.id,
    severity: rule.severity,
    ruleType: rule.ruleType,
    quotedText,
    reason: rule.reason,
    recommendedAction: rule.recommendedPhrase,
    reviewStatus: 'unreviewed',
    detectedAtMs,
  };
}

function containsPattern(text: string, pattern: string): boolean {
  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    return new RegExp(pattern.slice(1, -1), 'i').test(text);
  }
  return text.toLowerCase().includes(pattern.toLowerCase());
}
