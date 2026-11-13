import dotenv from 'dotenv';
dotenv.config();

export const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'st_george_jwt_secret_production_key_2026_secured',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'st_george_jwt_refresh_secret_production_key_2026_secured',
  JWT_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '7d',
  
  // PostgreSQL Database config
  SQL_HOST: process.env.SQL_HOST || '',
  SQL_USER: process.env.SQL_USER || '',
  SQL_PASSWORD: process.env.SQL_PASSWORD || '',
  SQL_DB_NAME: process.env.SQL_DB_NAME || 'st_george_db',
  DATABASE_URL: process.env.DATABASE_URL || '',
  
  // Google Sheets integration config
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
  GOOGLE_PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  
  // Security parameters
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION_MS: 15 * 60 * 1000, // 15 minutes
  IDEMPOTENCY_TTL_MS: 7 * 24 * 60 * 60 * 1000 // 7 days
};
