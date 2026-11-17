import { Bot, InputFile } from 'grammy';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { IMessageProvider, SendMessageOptions } from '../provider.interface.js';

// Adaptador para envío por Telegram y alertas administrativas anti-caídas
export class TelegramAdapter implements IMessageProvider {
  private bots = new Map<string, { bot: Bot; token: string }>();

  invalidateCache(tenantId: string): void {
    this.bots.delete(tenantId);
  }

  private async getBotForTenant(tenantId: string): Promise<Bot> {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { telegramBotToken: true }
    });
    const token = tenant?.telegramBotToken || env.adminTelegramBotToken;

    if (!token) {
      throw new Error('El proyecto no tiene un telegramBotToken configurado');
    }

    const cached = this.bots.get(tenantId);
    if (cached && cached.token === token) {
      return cached.bot;
    }

    const bot = new Bot(token);
    this.bots.set(tenantId, { bot, token });
    return bot;
  }

  async send(options: SendMessageOptions): Promise<{ externalId?: string }> {
    const { tenantId, recipient, type, payload } = options;
    const bot = await this.getBotForTenant(tenantId);

    if (type === 'TEXT') {
      const res = await bot.api.sendMessage(recipient, payload.text || '');
      return { externalId: String(res.message_id) };
    }

    if (type === 'DOCUMENT') {
      const fileSource = payload.mediaBase64
        ? new InputFile(Buffer.from(payload.mediaBase64, 'base64'), payload.fileName || 'documento.pdf')
        : payload.mediaUrl || '';

      const res = await bot.api.sendDocument(recipient, fileSource, {
        caption: payload.caption || payload.text
      });
      return { externalId: String(res.message_id) };
    }

    if (type === 'IMAGE') {
      const imgSource = payload.mediaBase64
        ? new InputFile(Buffer.from(payload.mediaBase64, 'base64'), payload.fileName || 'imagen.png')
        : payload.mediaUrl || '';

      const res = await bot.api.sendPhoto(recipient, imgSource, {
        caption: payload.caption || payload.text
      });
      return { externalId: String(res.message_id) };
    }

    throw new Error(`Tipo de mensaje no soportado en Telegram: ${type}`);
  }

  async getStatus(tenantId: string): Promise<{ status: string; details?: Record<string, unknown> }> {
    try {
      const bot = await this.getBotForTenant(tenantId);
      const me = await bot.api.getMe();
      return { status: 'CONNECTED', details: { username: me.username, id: me.id } };
    } catch (error) {
      return { status: 'DISCONNECTED', details: { error: (error as Error).message } };
    }
  }

  // Envía alerta inmediata al administrador si una sesión de WhatsApp se desconecta
  async sendAdminAlert(message: string): Promise<void> {
    if (!env.adminTelegramBotToken || !env.adminTelegramChatId) return;
    try {
      const adminBot = new Bot(env.adminTelegramBotToken);
      await adminBot.api.sendMessage(env.adminTelegramChatId, message);
    } catch (err) {
      console.error('[TelegramAlert] Error enviando alerta administrativa:', err);
    }
  }
}

export const telegramAdapter = new TelegramAdapter();
