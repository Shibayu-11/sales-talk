import { formatMmSs } from '@shared/time';
import type { Speaker } from '@shared/types';

export interface TranscriptBubbleEntry {
  id: string;
  speaker: Speaker;
  text: string;
  startMs: number;
  isFinal: boolean;
}

/** 自分=右 / 相手=左 のチャットバブル。話者はチャンネル分離由来なので推定ラベル不要。 */
export function TranscriptBubbles(props: {
  entries: TranscriptBubbleEntry[];
  highlightedId?: string | null;
  emptyMessage: string;
  maxHeightClassName?: string;
}): JSX.Element {
  if (props.entries.length === 0) {
    return <p className="text-sm text-zinc-600">{props.emptyMessage}</p>;
  }

  return (
    <ul className={`space-y-3 overflow-y-auto pr-1 ${props.maxHeightClassName ?? 'max-h-[480px]'}`}>
      {props.entries.map((entry) => {
        const isSelf = entry.speaker === 'self';
        const highlighted = props.highlightedId === entry.id;
        return (
          <li
            key={entry.id}
            id={`transcript-bubble-${entry.id}`}
            className={`flex items-start gap-3 ${isSelf ? 'flex-row-reverse' : ''}`}
          >
            <span className="mt-1 w-12 shrink-0 font-mono text-[11px] text-zinc-600">
              {formatMmSs(entry.startMs)}
            </span>
            <div
              className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed transition-shadow ${
                isSelf
                  ? 'rounded-tr-sm bg-zinc-100 text-zinc-900'
                  : 'rounded-tl-sm border border-zinc-800 bg-zinc-900 text-zinc-200'
              } ${entry.isFinal ? '' : 'opacity-60'} ${
                highlighted ? 'ring-2 ring-overlay-warning' : ''
              }`}
            >
              {entry.text}
              {!entry.isFinal && <span className="ml-1 text-zinc-500">…</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
