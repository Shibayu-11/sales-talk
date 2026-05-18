import { app } from 'electron';

export function isDevToolsEnabled(): boolean {
  const configured = process.env.SALES_TALK_ENABLE_DEV_TOOLS;
  if (configured === '1') {
    return true;
  }
  if (configured === '0') {
    return false;
  }
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

export function assertDevToolsEnabled(): void {
  if (!isDevToolsEnabled()) {
    throw new Error('Development diagnostics are disabled');
  }
}

export function isMockPipelineEnabled(): boolean {
  return isDevToolsEnabled() && process.env.SALES_TALK_MOCK_LLM === '1';
}
