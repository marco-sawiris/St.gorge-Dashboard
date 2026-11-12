function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeCsvCell(value: unknown): string {
  const str = String(value ?? '').replace(/"/g, '""');
  return `"${str}"`;
}

export function triggerBlobDownload(blob: Blob, filename: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export function buildCsvContent(headers: string[], rows: Array<Array<string | number>>): string {
  const headerLine = headers.map(escapeCsvCell).join(',');
  const dataLines = rows.map((row) => row.map(escapeCsvCell).join(','));
  return '\uFEFF' + [headerLine, ...dataLines].join('\r\n');
}

export function downloadCsvReport(
  headers: string[],
  rows: Array<Array<string | number>>,
  filename: string
): boolean {
  const csv = buildCsvContent(headers, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  return triggerBlobDownload(blob, filename);
}

export function buildPrintableHtmlReport(
  title: string,
  subtitle: string,
  headers: string[],
  rows: Array<Array<string | number>>
): string {
  const thHtml = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const trHtml = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4 landscape; margin: 14mm; }
    body { font-family: 'Cairo', 'Segoe UI', Tahoma, sans-serif; color: #0f172a; background: #ffffff; margin: 0; padding: 20px; direction: rtl; }
    .header { border-bottom: 2px solid #267aff; padding-bottom: 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
    h1 { margin: 0; font-size: 20px; color: #071b3b; }
    .meta { margin: 4px 0 0; font-size: 12px; color: #475569; }
    .badge { font-size: 11px; font-weight: bold; color: #123fce; background: #e0f2fe; border: 1px solid #7dd3fc; padding: 4px 10px; border-radius: 999px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid #cbd5e1; padding: 8px 10px; text-align: right; }
    th { background: #071b3b; color: #ffffff; font-weight: bold; }
    tr:nth-child(even) td { background: #f8fafc; }
    @media print { .no-print { display: none; } body { padding: 0; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <p class="meta">${escapeHtml(subtitle)}</p>
    </div>
    <span class="badge">فصل الشهيد مارجرجس — العذراء بالزيتون</span>
  </div>
  <table>
    <thead><tr>${thHtml}</tr></thead>
    <tbody>${trHtml}</tbody>
  </table>
</body>
</html>`;
}

export function downloadPrintableHtmlReport(
  title: string,
  subtitle: string,
  headers: string[],
  rows: Array<Array<string | number>>,
  filename: string
): boolean {
  const html = buildPrintableHtmlReport(title, subtitle, headers, rows);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8;' });
  return triggerBlobDownload(blob, filename);
}
