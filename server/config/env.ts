import dotenv from 'dotenv';
dotenv.config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

function readProductionSecret(name: 'JWT_SECRET' | 'JWT_REFRESH_SECRET'): string {
  const value = process.env[name]?.trim() || '';
  if (isProduction && (value.length < 32 || value.toLowerCase().includes('production_key'))) {
    throw new Error(
      `Production startup blocked: ${name} must be configured with a unique secret of at least 32 characters.`
    );
  }
  return value || (name === 'JWT_SECRET'
    ? 'development_only_jwt_secret_do_not_use_in_production'
    : 'development_only_refresh_secret_do_not_use_in_production');
}

const parsedPort = Number.parseInt(process.env.PORT || '3000', 10);
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error('Invalid PORT environment variable; expected an integer from 1 to 65535.');
}

export const ENV = {
  NODE_ENV,
  PORT: parsedPort,
  JWT_SECRET: readProductionSecret('JWT_SECRET'),
  JWT_REFRESH_SECRET: readProductionSecret('JWT_REFRESH_SECRET'),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '15m',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  // PostgreSQL Database config
  SQL_HOST: process.env.SQL_HOST || '',
  SQL_USER: process.env.SQL_USER || '',
  SQL_PASSWORD: process.env.SQL_PASSWORD || '',
  SQL_DB_NAME: process.env.SQL_DB_NAME || 'st_george_db',
  DATABASE_URL: process.env.DATABASE_URL || '',
  CORS_ORIGINS: process.env.CORS_ORIGINS || '',

  // Google Sheets integration config
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
  GOOGLE_PRIVATE_KEY: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),

  // Security parameters
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION_MS: 15 * 60 * 1000,
  IDEMPOTENCY_TTL_MS: 7 * 24 * 60 * 60 * 1000
};
