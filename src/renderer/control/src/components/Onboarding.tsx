import { useState } from 'react';
import type { PermissionState, ProductId } from '@shared/types';
import {
  completedStepCount,
  isApiKeyStepComplete,
  isPermissionsStepComplete,
  isProductStepComplete,
  resolveCurrentStep,
  type OnboardingState,
} from '../lib/onboarding';
import { PRODUCT_LABELS } from '../lib/call-view';

/**
 * First-run onboarding. Walks the user through the three things the app cannot
 * function without: OS permissions, an Anthropic key, and a product vertical.
 * Shown as a full-window overlay until settings.onboardingCompletedAt is set.
 */
export function Onboarding(props: {
  permissions: PermissionState | null;
  anthropicKeyConfigured: boolean;
  selectedProductId: ProductId | null;
  onRequestScreen: () => Promise<void>;
  onRequestMicrophone: () => Promise<void>;
  onSaveAnthropicKey: (value: string) => Promise<void>;
  onSelectProduct: (productId: ProductId) => Promise<void>;
  onComplete: () => Promise<void>;
}): JSX.Element {
  const state: OnboardingState = {
    permissions: props.permissions,
    anthropicKeyConfigured: props.anthropicKeyConfigured,
    productSelected: props.selectedProductId !== null,
  };
  const currentStep = resolveCurrentStep(state);
  const completed = completedStepCount(state);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="初期セットアップ"
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/95 p-6"
    >
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-8 shadow-2xl">
        <div className="mb-1 text-xs uppercase tracking-[0.2em] text-overlay-warning">SalesTalk</div>
        <h1 className="text-xl font-semibold text-zinc-100">初期セットアップ</h1>
        <p className="mt-1 text-sm text-zinc-400">
          商談で使い始める前に、3 つだけ設定します。すべてこの Mac の中で完結します。
        </p>

        <div className="my-6 flex gap-1.5">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className={`h-1 flex-1 rounded-full ${
                index < completed ? 'bg-overlay-success' : 'bg-zinc-700'
              }`}
            />
          ))}
        </div>

        <PermissionStep
          active={currentStep === 'permissions'}
          done={isPermissionsStepComplete(state)}
          permissions={props.permissions}
          onRequestScreen={props.onRequestScreen}
          onRequestMicrophone={props.onRequestMicrophone}
        />
        <ApiKeyStep
          active={currentStep === 'apiKey'}
          done={isApiKeyStepComplete(state)}
          onSave={props.onSaveAnthropicKey}
        />
        <ProductStep
          active={currentStep === 'product'}
          done={isProductStepComplete(state)}
          selectedProductId={props.selectedProductId}
          onSelect={props.onSelectProduct}
        />

        <button
          type="button"
          disabled={currentStep !== 'done'}
          onClick={() => void props.onComplete()}
          className="mt-6 w-full rounded-lg bg-overlay-success py-2.5 text-sm font-medium text-zinc-950 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
        >
          {currentStep === 'done' ? '商談を始める' : 'すべての項目を完了してください'}
        </button>
      </div>
    </div>
  );
}

function StepShell(props: {
  index: number;
  title: string;
  active: boolean;
  done: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section
      className={`mb-3 rounded-xl border p-4 transition-opacity ${
        props.done
          ? 'border-overlay-success/40 bg-overlay-success/5'
          : props.active
            ? 'border-zinc-600 bg-zinc-950/40'
            : 'border-zinc-800 bg-zinc-950/20 opacity-50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
            props.done ? 'bg-overlay-success text-zinc-950' : 'bg-zinc-700 text-zinc-200'
          }`}
        >
          {props.done ? '✓' : props.index}
        </span>
        <h2 className="text-sm font-medium text-zinc-200">{props.title}</h2>
      </div>
      {props.active && !props.done && <div className="mt-3">{props.children}</div>}
    </section>
  );
}

function PermissionStep(props: {
  active: boolean;
  done: boolean;
  permissions: PermissionState | null;
  onRequestScreen: () => Promise<void>;
  onRequestMicrophone: () => Promise<void>;
}): JSX.Element {
  return (
    <StepShell index={1} title="画面収録とマイクの許可" active={props.active} done={props.done}>
      <p className="mb-3 text-xs leading-relaxed text-zinc-400">
        Zoom の相手音声(画面収録)と自分の声(マイク)を取得します。許可後、システム設定で有効化が
        必要な場合はアプリの再起動を求められることがあります。
      </p>
      <div className="space-y-2">
        <PermissionRow
          label="画面収録"
          granted={Boolean(props.permissions?.screen)}
          onRequest={props.onRequestScreen}
        />
        <PermissionRow
          label="マイク"
          granted={Boolean(props.permissions?.microphone)}
          onRequest={props.onRequestMicrophone}
        />
      </div>
    </StepShell>
  );
}

function PermissionRow(props: {
  label: string;
  granted: boolean;
  onRequest: () => Promise<void>;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-2 text-sm">
      <span className="text-zinc-300">{props.label}</span>
      {props.granted ? (
        <span className="text-xs text-overlay-success">許可済み</span>
      ) : (
        <button
          type="button"
          onClick={() => void props.onRequest()}
          className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
        >
          許可する
        </button>
      )}
    </div>
  );
}

function ApiKeyStep(props: {
  active: boolean;
  done: boolean;
  onSave: (value: string) => Promise<void>;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (!value.trim()) {
      return;
    }
    setSaving(true);
    try {
      await props.onSave(value.trim());
      setValue('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <StepShell index={2} title="Anthropic API キー" active={props.active} done={props.done}>
      <p className="mb-3 text-xs leading-relaxed text-zinc-400">
        反論検知(Haiku)と切り返し生成(Sonnet)に使います。キーは macOS Keychain に保存され、
        画面には二度と表示されません。
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          aria-label="Anthropic API key"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          placeholder="sk-ant-..."
          className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
        />
        <button
          type="button"
          disabled={!value.trim() || saving}
          onClick={() => void save()}
          className="rounded bg-zinc-100 px-3 py-2 text-xs font-medium text-zinc-900 disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </StepShell>
  );
}

function ProductStep(props: {
  active: boolean;
  done: boolean;
  selectedProductId: ProductId | null;
  onSelect: (productId: ProductId) => Promise<void>;
}): JSX.Element {
  return (
    <StepShell index={3} title="商材を選ぶ" active={props.active} done={props.done}>
      <p className="mb-3 text-xs leading-relaxed text-zinc-400">
        商材ごとに検知・切り返し・法務ガードレールが変わります。あとから設定で変更できます。
      </p>
      <div className="space-y-2">
        {(Object.keys(PRODUCT_LABELS) as ProductId[]).map((productId) => (
          <button
            key={productId}
            type="button"
            onClick={() => void props.onSelect(productId)}
            className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
              props.selectedProductId === productId
                ? 'border-overlay-success bg-overlay-success/10 text-zinc-100'
                : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            {PRODUCT_LABELS[productId]}
          </button>
        ))}
      </div>
    </StepShell>
  );
}
