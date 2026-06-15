import { useEffect, useReducer, useState } from 'react';
import type {
  DetectedObjection,
  ObjectionResponse,
  ObjectionResponseSource,
  SharingState,
} from '@shared/types';
import {
  hasRiskFlags,
  initialOverlayState,
  overlayReducer,
  type OverlayLayer,
} from './lib/overlay-state';

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(overlayReducer, initialOverlayState);
  const [sharing, setSharing] = useState<SharingState>({ status: 'not_sharing' });
  const { objection, response, layer } = state;

  useEffect(() => {
    const offDetected = window.api.objection.onDetected((detected) => {
      dispatch({ type: 'DETECTED', objection: detected });
    });
    const offResponse = window.api.objection.onResponseReady((readyResponse) => {
      dispatch({ type: 'RESPONSE', response: readyResponse });
    });
    const offCancelled = window.api.objection.onCancelled(() => {
      dispatch({ type: 'CANCELLED' });
    });
    const offSharing = window.api.overlay.onSharingState(setSharing);
    return () => {
      offDetected();
      offResponse();
      offCancelled();
      offSharing();
    };
  }, []);

  const setHover = (isHover: boolean): void => {
    void window.api.overlay.setHover(isHover);
  };

  return (
    <div
      className="m-2 flex h-[calc(100vh-1rem)] flex-col overflow-hidden rounded-2xl border border-zinc-700/50 bg-overlay-bg text-[13px] text-overlay-text shadow-2xl backdrop-blur-overlay"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <header className="flex items-center justify-between border-b border-zinc-700/40 px-4 py-2 text-xs font-medium">
        <div className="flex items-center gap-2">
          <SharingBadge sharing={sharing} />
          <span className="text-zinc-600">/</span>
          <span className={objection ? 'text-overlay-objection' : 'text-zinc-400'}>
            {objection ? '反論検知' : '待機中'}
          </span>
          {hasRiskFlags(state) && (
            <span
              title="法務リスクあり — L3 で詳細を確認"
              className="rounded bg-overlay-objection/20 px-1.5 py-0.5 text-[10px] text-overlay-objection"
            >
              ⚠ リスク
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => dispatch({ type: 'SET_LAYER', layer: n as OverlayLayer })}
              className={`rounded px-2 py-0.5 text-xs ${
                layer === n ? 'bg-zinc-700' : 'hover:bg-zinc-800'
              }`}
            >
              L{n}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 overflow-hidden p-4">
        {!objection ? (
          <IdleState />
        ) : (
          <ObjectionContent layer={layer} objection={objection} response={response} />
        )}
      </main>
    </div>
  );
}

function SharingBadge(props: { sharing: SharingState }): JSX.Element {
  const labelByStatus: Record<SharingState['status'], string> = {
    sharing: '🔒 画面共有保護',
    protection_failed: '⚠️ 保護失敗',
    not_sharing: 'SalesTalk',
    verifying: '保護検証中…',
  };
  const className =
    props.sharing.status === 'sharing'
      ? 'text-overlay-success'
      : props.sharing.status === 'protection_failed'
        ? 'text-overlay-objection'
        : 'text-zinc-400';

  return <span className={className}>{labelByStatus[props.sharing.status]}</span>;
}

function IdleState(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-3 h-2 w-2 rounded-full bg-zinc-600" />
      <div className="text-sm font-medium text-zinc-400">商談を監視中</div>
      <div className="mt-2 max-w-[260px] text-xs leading-relaxed text-zinc-600">
        相手の反論を検知すると、ここに 3 層の切り返し候補を表示します。
      </div>
    </div>
  );
}

function ObjectionContent(props: {
  layer: 1 | 2 | 3;
  objection: DetectedObjection;
  response: ObjectionResponse | null;
}): JSX.Element {
  if (props.layer === 1) {
    return <LayerOne objection={props.objection} response={props.response} />;
  }

  if (props.layer === 2) {
    return <LayerTwo objection={props.objection} response={props.response} />;
  }

  return <LayerThree objection={props.objection} response={props.response} />;
}

function LayerOne(props: {
  objection: DetectedObjection;
  response: ObjectionResponse | null;
}): JSX.Element {
  const peak = props.response?.peak ?? compactPeak(props.objection.triggerText);

  return (
    <section className="flex h-full flex-col justify-center">
      <div className="mb-3 text-xs uppercase tracking-[0.2em] text-overlay-objection">
        {props.objection.type}
      </div>
      <div className="text-2xl font-semibold leading-tight text-overlay-objection">{peak}</div>
      <div className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
        <span>confidence {formatConfidence(props.objection.confidence)}</span>
        {!props.response && (
          <span className="flex items-center gap-1 text-overlay-warning">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-overlay-warning" />
            切り返し生成中…
          </span>
        )}
      </div>
    </section>
  );
}

function LayerTwo(props: {
  objection: DetectedObjection;
  response: ObjectionResponse | null;
}): JSX.Element {
  return (
    <section className="space-y-4">
      <div>
        <div className="text-xs uppercase tracking-[0.2em] text-overlay-objection">
          {props.objection.type}
        </div>
        <div className="mt-1 text-xl font-semibold text-overlay-objection">
          {props.response?.peak ?? compactPeak(props.objection.triggerText)}
        </div>
      </div>

      <TriggerCard text={props.objection.triggerText} confidence={props.objection.confidence} />

      {props.response ? (
        <>
          <ul className="space-y-2">
            {props.response.summary.slice(0, 3).map((line) => (
              <li key={line} className="rounded-xl border border-zinc-700/60 bg-zinc-950/40 p-3 leading-relaxed">
                {line}
              </li>
            ))}
          </ul>
          <ReasoningBlock title="根拠" text={props.response.reasoning} />
          {props.response.sources.length > 0 && (
            <div className="text-xs text-overlay-success">
              根拠ナレッジ {props.response.sources.length} 件
            </div>
          )}
        </>
      ) : (
        <GeneratingState />
      )}
    </section>
  );
}

function LayerThree(props: {
  objection: DetectedObjection;
  response: ObjectionResponse | null;
}): JSX.Element {
  if (!props.response) {
    return (
      <section className="space-y-4">
        <TriggerCard text={props.objection.triggerText} confidence={props.objection.confidence} />
        <GeneratingState />
      </section>
    );
  }

  return (
    <section className="h-full space-y-4 overflow-y-auto pr-1">
      <div>
        <div className="text-xs uppercase tracking-[0.2em] text-overlay-objection">script</div>
        <div className="mt-1 text-lg font-semibold text-overlay-objection">{props.response.peak}</div>
      </div>
      <div className="whitespace-pre-wrap rounded-xl border border-zinc-700/60 bg-zinc-950/40 p-3 leading-relaxed">
        {props.response.fullScript}
      </div>
      <ReasoningBlock title="根拠詳細" text={props.response.reasoning} />
      {props.response.sources.length > 0 && (
        <ListBlock
          title="根拠ナレッジ"
          items={props.response.sources.map(formatSource)}
          tone="info"
        />
      )}
      {props.response.notes.length > 0 && (
        <ListBlock title="注意事項" items={props.response.notes} tone="warning" />
      )}
      {props.response.riskFlags.length > 0 && (
        <ListBlock title="risk flags" items={props.response.riskFlags} tone="danger" />
      )}
    </section>
  );
}

function TriggerCard(props: { text: string; confidence: number }): JSX.Element {
  return (
    <div className="rounded-xl border border-overlay-objection/40 bg-overlay-objection/10 p-3">
      <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
        <span>trigger</span>
        <span className="text-overlay-warning">{formatConfidence(props.confidence)}</span>
      </div>
      <div className="leading-relaxed text-zinc-200">{props.text}</div>
    </div>
  );
}

function GeneratingState(): JSX.Element {
  return (
    <div className="rounded-xl border border-zinc-700/60 bg-zinc-950/40 p-3 text-sm text-overlay-warning">
      切り返し生成中…
    </div>
  );
}

function ReasoningBlock(props: { title: string; text: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-3">
      <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">{props.title}</div>
      <div className="text-xs leading-relaxed text-zinc-400">{props.text}</div>
    </div>
  );
}

function ListBlock(props: {
  title: string;
  items: string[];
  tone: 'info' | 'warning' | 'danger';
}): JSX.Element {
  const color =
    props.tone === 'danger'
      ? 'text-overlay-objection'
      : props.tone === 'info'
        ? 'text-overlay-success'
        : 'text-overlay-warning';
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-3">
      <div className={`mb-2 text-xs uppercase tracking-wide ${color}`}>{props.title}</div>
      <ul className="list-disc space-y-1 pl-4 text-xs text-zinc-400">
        {props.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function formatSource(source: ObjectionResponseSource): string {
  return typeof source.score === 'number'
    ? `${source.trigger}(関連度 ${Math.round(source.score * 100)}%)`
    : source.trigger;
}

function compactPeak(text: string): string {
  return text.trim().slice(0, 15);
}

function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}
