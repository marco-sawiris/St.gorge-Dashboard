/**
 * Single source of truth for the central Google Sheets identifier and URLs.
 * This ID is confirmed by the project owner and must match the Apps Script backend.
 * Client-supplied spreadsheetId overrides must be ignored/rejected.
 */
export const CENTRAL_SPREADSHEET_ID = '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0' as const;

export const CENTRAL_SPREADSHEET_EDIT_URL =
  `https://docs.google.com/spreadsheets/d/${CENTRAL_SPREADSHEET_ID}/edit` as const;

export function isDisallowedClientSpreadsheetOverride(
  candidate: unknown,
  authoritativeId: string = CENTRAL_SPREADSHEET_ID
): boolean {
  if (candidate === undefined || candidate === null) return false;
  const trimmed = String(candidate).trim();
  if (!trimmed) return false;
  return trimmed !== String(authoritativeId).trim();
}
