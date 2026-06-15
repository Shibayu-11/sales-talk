import { useEffect, useReducer, useRef, useState } from 'react';
import type { ProductId } from '@shared/types';
import {
  canStartRecording,
  initialRecorderState,
  isBusy,
  recorderReducer,
} from './lib/recorder-machine';
import { RecorderApi, RecorderApiError } from './lib/recorder-api';

const PRODUCT_LABELS: Record<ProductId, string> = {
  real_estate: '不動産',
  kenko_keiei: '健康経営優良法人',
  hojokin: '補助金・助成金',
};

// Configured at build time; falls back to the known β Worker.
const API_URL =
  (import.meta.env.VITE_SALESTALK_API_URL as string | undefined) ??
  'https://sales-talk-api.lively-violet-0704.workers.dev';

const SESSION_KEY = 'salestalk.mobile.session';

export function App(): JSX.Element {
  const apiRef = useRef<RecorderApi>(new RecorderApi({ apiUrl: API_URL }));
  const [state, dispatch] = useReducer(recorderReducer, undefined, () => initialRecorderState());
  const [authError, setAuthError] = useState<string | null>(null);

  // Restore a saved session so the agent isn't asked to log in every visit.
  useEffect(() => {
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved) {
      apiRef.current.setSessionToken(saved);
      dispatch({ type: 'LOGIN_OK' });
    }
  }, []);

  const handleLogin = async (email: string, password: string): Promise<void> => {
    setAuthError(null);
    try {
      await apiRef.current.login(email, password);
      const token = (apiRef.current as unknown as { sessionToken: string | null }).sessionToken;
      if (token) localStorage.setItem(SESSION_KEY, token);
      dispatch({ type: 'LOGIN_OK' });
    } catch (error) {
      setAuthError(error instanceof RecorderApiError ? loginMessage(error.code) : 'ログインに失敗しました');
    }
  };

  const handleLogout = (): void => {
    localStorage.removeItem(SESSION_KEY);
    apiRef.current.setSessionToken(null);
    dispatch({ type: 'LOGOUT' });
  };

  if (state.status === 'idle') {
    return <LoginScreen onLogin={handleLogin} error={authError} />;
  }

  return (
    <RecorderScreen
      api={apiRef.current}
      state={state}
      dispatch={dispatch}
      onLogout={handleLogout}
    />
  );
}

function LoginScreen(props: {
  onLogin: (email: string, password: string) => Promise<void>;
  error: string | null;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      await props.onLogin(email.trim(), password);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <div className="header">
        <h1>SalesTalk 録音</h1>
        <div className="sub">訪問商談の録音とアップロード</div>
      </div>
      <div className="card">
        <div className="label">ログイン</div>
        <input
          type="email"
          inputMode="email"
          autoComplete="username"
          placeholder="メールアドレス"
          aria-label="メールアドレス"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
        <input
          type="password"
          autoComplete="current-password"
          placeholder="パスワード"
          aria-label="パスワード"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        {props.error && <div className="status error">{props.error}</div>}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !email.trim() || !password}
          onClick={() => void submit()}
          style={{ marginTop: 6 }}
        >
          {busy ? 'ログイン中…' : 'ログイン'}
        </button>
      </div>
      <div className="footer">音声はこの端末から暗号化してアップロードされます</div>
    </div>
  );
}

function RecorderScreen(props: {
  api: RecorderApi;
  state: ReturnType<typeof recorderReducer>;
  dispatch: React.Dispatch<Parameters<typeof recorderReducer>[1]>;
  onLogout: () => void;
}): JSX.Element {
  const { api, state, dispatch } = props;
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordedBlobRef = useRef<Blob | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);

  // Recording timer.
  useEffect(() => {
    if (state.status !== 'recording') return;
    const startedAt = performance.now();
    const id = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 200);
    return () => window.clearInterval(id);
  }, [state.status]);

  const startRecording = async (): Promise<void> => {
    setRecordError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        recordedBlobRef.current = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/mp4',
        });
        stream.getTracks().forEach((t) => t.stop());
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      dispatch({ type: 'START' });
    } catch {
      setRecordError('マイクへのアクセスが許可されていません');
    }
  };

  const stopRecording = (): void => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    dispatch({ type: 'STOP' });
  };

  const upload = async (): Promise<void> => {
    const blob = recordedBlobRef.current;
    if (!blob) return;
    dispatch({ type: 'UPLOAD' });
    try {
      const extension = blob.type.includes('webm') ? 'webm' : 'mp4';
      const result = await api.uploadRecording({
        blob,
        fileName: `visit-${isoStamp()}.${extension}`,
        productId: state.productId,
      });
      dispatch({ type: 'UPLOADED', callId: result.callId, sttJobId: result.sttJobId });
      dispatch({ type: 'PROCESSED', transcriptCount: result.transcriptCount });
    } catch (error) {
      dispatch({
        type: 'FAIL',
        error: error instanceof RecorderApiError ? error.message : 'アップロードに失敗しました',
      });
    }
  };

  const reset = (): void => {
    recordedBlobRef.current = null;
    setElapsedMs(0);
    dispatch({ type: 'RESET' });
  };

  return (
    <div className="app">
      <div className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1>SalesTalk 録音</h1>
          <div className="sub">{statusLabel(state.status)}</div>
        </div>
        <button type="button" className="link" onClick={props.onLogout}>
          ログアウト
        </button>
      </div>

      {(state.status === 'ready' || state.status === 'consented') && (
        <>
          <div className="card">
            <div className="label">商材</div>
            <div className="products">
              {(Object.keys(PRODUCT_LABELS) as ProductId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`product ${state.productId === id ? 'active' : ''}`}
                  onClick={() => dispatch({ type: 'SELECT_PRODUCT', productId: id })}
                >
                  {PRODUCT_LABELS[id]}
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <label className="consent">
              <input
                type="checkbox"
                aria-label="録音同意"
                checked={state.consentGranted}
                onChange={(e) =>
                  dispatch({ type: e.currentTarget.checked ? 'GRANT_CONSENT' : 'REVOKE_CONSENT' })
                }
              />
              <span>
                顧客から録音・文字起こし・コンプラ解析への同意を取得しました。この確認は監査証跡として
                記録されます。
              </span>
            </label>
          </div>
        </>
      )}

      <div className="record-zone">
        {(state.status === 'consented' || state.status === 'recording') && (
          <>
            <div className="timer">{formatElapsed(elapsedMs)}</div>
            <button
              type="button"
              className={`record-btn ${state.status === 'recording' ? 'recording' : ''}`}
              disabled={state.status === 'consented' && !canStartRecording(state)}
              onClick={() => (state.status === 'recording' ? stopRecording() : void startRecording())}
              aria-label={state.status === 'recording' ? '録音停止' : '録音開始'}
            >
              <span className="dot" />
            </button>
            <div className="status">
              {state.status === 'recording' ? 'タップで停止' : 'タップで録音開始'}
            </div>
            {recordError && <div className="status error">{recordError}</div>}
          </>
        )}

        {state.status === 'recorded' && (
          <>
            <div className="timer">{formatElapsed(elapsedMs)}</div>
            <button type="button" className="btn btn-primary" onClick={() => void upload()}>
              アップロードして文字起こし
            </button>
            <button type="button" className="btn btn-secondary" onClick={reset}>
              録り直す
            </button>
          </>
        )}

        {isBusy(state) && (
          <div className="status">
            <span className="spinner" />
            {state.status === 'uploading' ? 'アップロード中…' : 'クラウドで文字起こし中…'}
          </div>
        )}

        {state.status === 'done' && (
          <>
            <div className="status success">
              ✓ 完了しました{state.transcriptCount !== null && `(${state.transcriptCount} セグメント)`}
            </div>
            <div className="sub" style={{ textAlign: 'center' }}>
              議事録とコンプラ結果は管理画面で確認できます。
            </div>
            <button type="button" className="btn btn-primary" onClick={reset}>
              次の商談を録音
            </button>
          </>
        )}

        {state.status === 'error' && (
          <>
            <div className="status error">{state.error}</div>
            <button type="button" className="btn btn-secondary" onClick={reset}>
              やり直す
            </button>
          </>
        )}
      </div>

      <div className="footer">音声はこの端末から暗号化してアップロードされます</div>
    </div>
  );
}

function statusLabel(status: ReturnType<typeof recorderReducer>['status']): string {
  const labels: Record<typeof status, string> = {
    idle: '',
    ready: '商材と同意を確認',
    consented: '録音できます',
    recording: '録音中',
    recorded: 'アップロード待ち',
    uploading: 'アップロード中',
    processing: '文字起こし中',
    done: '完了',
    error: 'エラー',
  };
  return labels[status];
}

function loginMessage(code: string): string {
  if (code === 'invalid_credentials') return 'メールまたはパスワードが違います';
  if (code === 'account_locked') return 'アカウントが一時ロックされています。しばらく待ってください';
  return 'ログインに失敗しました';
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
