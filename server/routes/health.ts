import { Router, Request, Response } from 'express';
import { dbManager } from '../db';
import { googleSheetsService } from '../services/googleSheetsService';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  return res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: dbManager.isPostgresConnected ? 'postgresql' : 'resilient_store',
    sheets: googleSheetsService.isGoogleConfigured() ? 'google_sheets_live' : 'authoritative_store',
    version: '2.0.0'
  });
});

export default router;
