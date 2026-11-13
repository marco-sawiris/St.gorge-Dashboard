import { Router, Request, Response } from 'express';
import { dbManager } from '../db';
import { googleSheetsService } from '../services/googleSheetsService';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  return res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: dbManager.isPostgresConnected ? 'postgresql' : 'in_memory_development_only',
    databaseReady: dbManager.isPostgresConnected,
    sheets: googleSheetsService.isGoogleConfigured() ? 'google_sheets_read_write' : 'google_sheets_gviz_read_only',
    sheetsWritable: googleSheetsService.isGoogleConfigured(),
    version: '2.0.0'
  });
});

export default router;
