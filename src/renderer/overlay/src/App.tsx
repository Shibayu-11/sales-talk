import { useEffect, useState } from 'react';
import type { DetectedObjection, ObjectionResponse, SharingState } from '@shared/types';

/**
 * Overlay App. Per PRD §12.2 — 3 layer information density.
 * This is a placeholder skeleton; concrete layout follows in subsequent tasks.
 */
export function App(): JSX.Element {
  const [layer, setLayer] = useState<1 | 2 | 3>(2);
  const [objection, setObjection] = useState<DetectedObjection | null>(null);
  const [response, setResponse] = useState<ObjectionResponse | null>(null);
  const [sharing, setSharing] = useState<SharingState>({ status: 'not_sharing' });

  useEffect(() => {
    const offDetected = window.api.objection.onDetected(setObjection);
    const offResponse = window.api.objection.onResponseReady(setResponse);
    const offCancelled = window.api.objection.onCancelled(() => {
      setObjection(null);
      setResponse(null);
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
      className="m-2 flex h-[calc(100vh-1rem)] flex-col rounded-2xl border border-zinc-700/50 bg-overlay-bg text-overlay-text shadow-2xl backdrop-blur-overlay"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <header className="flex items-center justify-between border-b border-zinc-700/40 px-4 py-2 text-xs font-medium">
        <div className="flex items-center gap-2">
          <span
            className={
              sharing.status === 'sharing'
                ? 'text-overlay-success'
                : sharing.status === 'protection_failed'
                  ? 'text-overlay-objection'
                  : 'text-zinc-400'
            }
          >
            {sharing.status === 'sharing' && '🔒 画面共有に映りません'}
            {sharing.status === 'protection_failed' && '⚠️ 保護検証失敗'}
            {sharing.status === 'not_sharing' && 'SalesTalk'}
            {sharing.status === 'verifying' && '保護検証中…'}
          </span>
        </div>
        <div className="flex gap-1">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setLayer(n as 1 | 2 | 3)}
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
        {!objection && (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            待機中
          </div>
        )}

        {objection && layer === 1 && (
          <div className="text-base font-semibold text-overlay-objection">
            {objection.type} · {objection.triggerText.slice(0, 15)}
          </div>
        )}

        {objection && layer === 2 && response && (
          <div className="space-y-3 text-sm">
            <div className="text-overlay-objection font-semibold">{response.peak}</div>
            <ul className="list-disc space-y-1 pl-4">
              {response.summary.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
            <div className="text-xs text-zinc-400">{response.reasoning}</div>
          </div>
        )}

        {objection && layer === 3 && response && (
          <div className="space-y-3 text-sm">
            <div className="whitespace-pre-wrap leading-relaxed">{response.fullScript}</div>
            {response.notes.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500">注意</div>
                <ul className="list-disc pl-4 text-xs">
                  {response.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </div>
            )}
            {response.riskFlags.length > 0 && (
              <div className="rounded bg-overlay-objection/20 p-2 text-xs">
                {response.riskFlags.join(' / ')}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
