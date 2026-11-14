import dotenv from 'dotenv';

dotenv.config();

// Configuración centralizada y validada del entorno
export const env = {
  port: Number(process.env.PORT || 3100),
  nodeEnv: process.env.NODE_ENV || 'development',
  adminMasterKey: process.env.ADMIN_MASTER_KEY || 'iapi_master_secret_2026',
  databaseUrl: process.env.DATABASE_URL || '',
  idleThresholdMs: Number(process.env.IDLE_THRESHOLD_MS || 120000),
  fastTypingMinMs: Number(process.env.FAST_TYPING_MIN_MS || 3000),
  fastTypingMaxMs: Number(process.env.FAST_TYPING_MAX_MS || 4500),
  burstDelayMinMs: Number(process.env.BURST_DELAY_MIN_MS || 20000),
  burstDelayMaxMs: Number(process.env.BURST_DELAY_MAX_MS || 45000),
  adminTelegramBotToken: process.env.ADMIN_TELEGRAM_BOT_TOKEN || '',
  adminTelegramChatId: process.env.ADMIN_TELEGRAM_CHAT_ID || ''
};

