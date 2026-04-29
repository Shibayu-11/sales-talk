import type { ProductId } from '@shared/types';

export interface GuardrailViolation {
  code: string;
  label: string;
  matched: string;
}

export interface GuardrailInput {
  productId: ProductId;
  text: string;
  riskFlags?: string[];
}

export interface GuardrailResult {
  allowed: boolean;
  safeText: string;
  riskFlags: string[];
  violations: GuardrailViolation[];
}

interface ProductGuardrailRule {
  code: string;
  label: string;
  pattern: RegExp;
}

const RULES: Record<ProductId, ProductGuardrailRule[]> = {
  real_estate: [
    { code: 'real_estate_important_disclosure', label: '重要事項説明への踏み込み', pattern: /重要事項説明|重説|宅建業法/ },
    { code: 'real_estate_yield_guarantee', label: '利回り保証', pattern: /利回り.*(保証|確実|必ず)|元本保証/ },
    { code: 'real_estate_tax_assertion', label: '節税効果断定', pattern: /節税.*(確実|必ず|保証|断定)/ },
  ],
  hojokin: [
    { code: 'subsidy_application_instruction', label: '申請書具体記載の指示', pattern: /申請書.*(こう書|記載して|書けば)|虚偽申請/ },
    { code: 'subsidy_acceptance_guarantee', label: '採択確約', pattern: /採択.*(確実|必ず|保証)|100%.*採択/ },
    { code: 'subsidy_false_application', label: '虚偽申請の教唆', pattern: /虚偽|架空経費|水増し/ },
  ],
  kenko_keiei: [
    { code: 'health_certification_guarantee', label: '認定確約', pattern: /認定.*(確実|必ず|保証)|ホワイト500.*(確実|保証)/ },
    { code: 'health_effect_guarantee', label: '効果数値保証', pattern: /離職率.*(必ず|確実).*下が|生産性.*(必ず|確実).*上が|効果.*保証/ },
    { code: 'health_medical_advice', label: '医療行為への踏み込み', pattern: /診断|治療|処方|医療行為/ },
  ],
};

const SAFE_FALLBACKS: Record<ProductId, string> = {
  real_estate:
    '一般論として、立地・築年数・融資条件次第で変動します。重要事項は宅建士、税務は税理士、融資は金融機関に確認してください。',
  hojokin:
    '公募要領を確認した上で判断が必要です。採択実績は目安であり、申請書作成や詳細な事業計画は提携行政書士・中小企業診断士に確認してください。',
  kenko_keiei:
    '要件を満たす可能性はありますが、認定や効果を保証するものではありません。医療は産業医、労務は社労士に確認してください。',
};

export function applyOutputGuardrail(input: GuardrailInput): GuardrailResult {
  const violations = RULES[input.productId].flatMap((rule) => {
    const matched = input.text.match(rule.pattern)?.[0];
    if (!matched) return [];
    return [{ code: rule.code, label: rule.label, matched }];
  });

  const riskFlags = new Set(input.riskFlags ?? []);
  for (const violation of violations) {
    riskFlags.add(violation.code);
  }

  if (violations.length > 0) {
    riskFlags.add('requires_human_review');
  }

  return {
    allowed: violations.length === 0,
    safeText: violations.length === 0 ? input.text : SAFE_FALLBACKS[input.productId],
    riskFlags: [...riskFlags],
    violations,
  };
}
