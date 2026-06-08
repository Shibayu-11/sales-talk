import { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { AuditIntegrityResult, AuditLogEntry } from '@shared/types';

export function createAuditCsv(
  entries: AuditLogEntry[],
  integrity: AuditIntegrityResult,
): string {
  const headers = [
    'createdAt',
    'action',
    'actorDisplayName',
    'actorRole',
    'tenantId',
    'organizationId',
    'targetType',
    'targetId',
    'metadata',
    'previousHash',
    'hash',
    'chainValid',
  ];
  const rows = entries.map((entry) =>
    [
      entry.createdAt,
      entry.action,
      entry.actorDisplayName,
      entry.actorRole,
      entry.tenantId,
      entry.organizationId,
      entry.targetType,
      entry.targetId,
      JSON.stringify(entry.metadata),
      entry.previousHash,
      entry.hash,
      integrity.valid,
    ].map(csvCell),
  );
  return `\uFEFF${[headers, ...rows].map((row) => row.join(',')).join('\n')}\n`;
}

export async function writeAuditPdf(
  filePath: string,
  entries: AuditLogEntry[],
  integrity: AuditIntegrityResult,
): Promise<void> {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createAuditHtml(entries, integrity))}`);
    const pdf = await window.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
    });
    await writeFile(filePath, pdf);
  } finally {
    window.destroy();
  }
}

function createAuditHtml(entries: AuditLogEntry[], integrity: AuditIntegrityResult): string {
  const rows = entries
    .map(
      (entry) => `<tr>
        <td>${escapeHtml(entry.createdAt)}</td>
        <td>${escapeHtml(entry.action)}</td>
        <td>${escapeHtml(entry.actorDisplayName ?? entry.actorType)} / ${escapeHtml(entry.actorRole ?? '-')}</td>
        <td>${escapeHtml(entry.organizationId ?? '-')}</td>
        <td>${escapeHtml(entry.targetType)} / ${escapeHtml(entry.targetId)}</td>
        <td class="hash">${escapeHtml(entry.hash ?? '-')}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;color:#18181b;font-size:10px}
    h1{font-size:20px} .valid{color:#166534}.invalid{color:#b91c1c}
    table{width:100%;border-collapse:collapse}th,td{border:1px solid #d4d4d8;padding:5px;vertical-align:top}
    th{background:#f4f4f5}.hash{font-family:monospace;font-size:7px;word-break:break-all}
  </style></head><body><h1>監査ログ提出資料</h1>
  <p>生成日時: ${escapeHtml(new Date().toISOString())}</p>
  <p class="${integrity.valid ? 'valid' : 'invalid'}">ハッシュチェーン検証: ${integrity.valid ? 'VALID' : 'INVALID'} (${integrity.checkedEntries}件)</p>
  <table><thead><tr><th>日時</th><th>操作</th><th>実行者</th><th>組織</th><th>対象</th><th>SHA-256</th></tr></thead>
  <tbody>${rows}</tbody></table></body></html>`;
}

function csvCell(value: string | number | boolean | null): string {
  const text = value === null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
