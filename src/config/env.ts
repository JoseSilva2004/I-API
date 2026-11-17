import dotenv from 'dotenv';

dotenv.config();

const adminMasterKey = (process.env.ADMIN_MASTER_KEY || '').trim();
if (adminMasterKey.length < 32 || adminMasterKey === 'iapi_master_secret_2026') {
  throw new Error(
    '[Config] ADMIN_MASTER_KEY es obligatoria, debe tener al menos 32 caracteres y no puede ser el valor de ejemplo.'
  );
}

// Configuración centralizada y validada del entorno
export const env = {
  port: Number(process.env.PORT || 3100),
  nodeEnv: process.env.NODE_ENV || 'development',
  adminMasterKey,
  databaseUrl: process.env.DATABASE_URL || '',
  idleThresholdMs: Number(process.env.IDLE_THRESHOLD_MS || 120000),
  fastTypingMinMs: Number(process.env.FAST_TYPING_MIN_MS || 1800),
  fastTypingMaxMs: Number(process.env.FAST_TYPING_MAX_MS || 8500),
  burstDelayMinMs: Number(process.env.BURST_DELAY_MIN_MS || 20000),
  burstDelayMaxMs: Number(process.env.BURST_DELAY_MAX_MS || 45000),
  autoReadMessages: process.env.AUTO_READ_MESSAGES === 'true',
  humanizeMessages: process.env.HUMANIZE_MESSAGES === 'true',
  adminTelegramBotToken: process.env.ADMIN_TELEGRAM_BOT_TOKEN || '',
  adminTelegramChatId: process.env.ADMIN_TELEGRAM_CHAT_ID || ''
};
