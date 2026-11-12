import express, { Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { ENV } from './server/config/env';
import { requestLogger } from './server/middleware/logger';
import authRouter from './server/routes/auth';
import healthRouter from './server/routes/health';
import sheetsRouter from './server/routes/sheets';

import fs from 'fs';

async function startServer() {
  const app = express();

  // Basic Middlewares
  app.use(cors({
    origin: true,
    credentials: true
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '5mb' }));
  app.use(requestLogger);

  // API Routes
  app.use('/api/auth', authRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/sheets', sheetsRouter);

  // Direct APK Download Route (avoids putting APK inside dist/public where Capacitor would nest it)
  app.get('/download/st-george-dashboard-debug.apk', (_req: Request, res: Response) => {
    const apkPath = path.resolve(process.cwd(), 'android/app/build/outputs/apk/debug/app-debug.apk');
    if (!fs.existsSync(apkPath)) {
      res.status(404).json({ ok: false, error: 'APK file not built yet' });
      return;
    }
    res.download(apkPath, 'st-george-dashboard-debug.apk');
  });

  // Vite Integration
  if (ENV.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(ENV.PORT, '0.0.0.0', () => {
    console.log(`[St. George Dashboard Server] running on http://0.0.0.0:${ENV.PORT} (${ENV.NODE_ENV})`);
  });

  return server;
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
