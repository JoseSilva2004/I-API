import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WASocket
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { prisma } from '../../config/prisma.js';
import { IMessageProvider, SendMessageOptions } from '../provider.interface.js';
import { usePostgresAuthState } from './postgres.auth.js';
import { telegramAdapter } from '../telegram/telegram.adapter.js';

interface InstanceSession {
  socket: WASocket;
  status: 'CONNECTING' | 'QR_READY' | 'CONNECTED' | 'DISCONNECTED';
  qrBase64?: string;
  pairingCode?: string;
  phoneNumber?: string;
}

const logger = pino({ level: 'silent' });

const randomInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

// Polimorfismo de texto: resuelve Spintax {Hola|Buen día} y añade micro-referencia única anti-hash
function humanizeContent(text?: string, messageId?: string): string {
  if (!text) return '';
  const spun = text.replace(/\{([^{}]+)\}/g, (_, options: string) => {
    const parts = options.split('|');
    return parts[randomInt(0, parts.length - 1)];
  });
  const shortRef = (messageId || Math.random().toString(36).substring(2, 6)).slice(0, 4).toUpperCase();
  return `${spun}\n\n_Ref: #${shortRef}_`;
}

// Motor de WhatsApp Multi-Instancia con reconexión inteligente y soporte QR / Pairing Code
export class WhatsAppAdapter implements IMessageProvider {
  private sessions = new Map<string, InstanceSession>();

  // Inicia o recupera una sesión de WhatsApp para un proyecto (Tenant)
  async connectInstance(
    tenantId: string,
    phoneForPairingCode?: string
  ): Promise<{
    status: string;
    qrBase64?: string;
    pairingCode?: string;
  }> {
    const existing = this.sessions.get(tenantId);
    if (existing && existing.status === 'CONNECTED') {
      return { status: 'CONNECTED' };
    }

    const { state, saveCreds, clearSession } = await usePostgresAuthState(tenantId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ['I-API Gateway', 'Chrome', '122.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    const instanceState: InstanceSession = {
      socket: sock,
      status: 'CONNECTING'
    };
    this.sessions.set(tenantId, instanceState);

    sock.ev.on('creds.update', saveCreds);

    // Auto-Read: marca como leídos los mensajes entrantes tras 3-8s para mejorar el Trust Score ante Meta
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.key.fromMe && msg.key.remoteJid && msg.key.remoteJid !== 'status@broadcast') {
          const readDelayMs = randomInt(3000, 8000);
          setTimeout(async () => {
            try {
              await sock.readMessages([msg.key]);
            } catch {
              // Ignorar si el socket se cerró durante la espera
            }
          }, readDelayMs);
        }
      }
    });

    // Promesa para capturar el primer QR o Pairing Code sin bloquear indefinidamente
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (data: { status: string; qrBase64?: string; pairingCode?: string }) => {
        if (!resolved) {
          resolved = true;
          resolve(data);
        }
      };

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          instanceState.status = 'QR_READY';
          instanceState.qrBase64 = await QRCode.toDataURL(qr);

          if (phoneForPairingCode && !state.creds.registered) {
            try {
              const cleanPhone = phoneForPairingCode.replace(/\D/g, '');
              instanceState.pairingCode = await sock.requestPairingCode(cleanPhone);
            } catch (err) {
              console.error(`[WhatsApp:${tenantId}] Error generando Pairing Code:`, err);
            }
          }

          finish({
            status: 'QR_READY',
            qrBase64: instanceState.qrBase64,
            pairingCode: instanceState.pairingCode
          });
        }

        if (connection === 'open') {
          instanceState.status = 'CONNECTED';
          instanceState.qrBase64 = undefined;
          instanceState.pairingCode = undefined;
          instanceState.phoneNumber = sock.user?.id.split(':')[0];
          console.log(`[WhatsApp:${tenantId}] Sesión CONECTADA (${instanceState.phoneNumber})`);
          finish({ status: 'CONNECTED' });
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;

          if (isLoggedOut) {
            instanceState.status = 'DISCONNECTED';
            this.sessions.delete(tenantId);
            await clearSession();
            await telegramAdapter.sendAdminAlert(
              `⚠️ [I-API] La sesión de WhatsApp del proyecto ${tenantId} cerró sesión (loggedOut). Requiere revinculación.`
            );
            finish({ status: 'DISCONNECTED' });
          } else {
            // Reconexión automática en cualquier corte de red o reinicio sin perder la sesión
            console.log(`[WhatsApp:${tenantId}] Reconectando socket automáticamente (code: ${statusCode})...`);
            setTimeout(() => {
              this.connectInstance(tenantId).catch((e) =>
                console.error(`[WhatsApp:${tenantId}] Fallo en reconexión:`, e)
              );
            }, 4000);
          }
        }
      });

      setTimeout(() => {
        finish({
          status: instanceState.status,
          qrBase64: instanceState.qrBase64,
          pairingCode: instanceState.pairingCode
        });
      }, 6000);
    });
  }

  // Restaura automáticamente todas las sesiones guardadas en PostgreSQL al arrancar Docker
  async restoreAllSessions(): Promise<void> {
    const savedTenants = await prisma.sessionCreds.findMany({
      where: { channel: 'WHATSAPP', keyId: 'creds' },
      select: { tenantId: true }
    });

    for (const { tenantId } of savedTenants) {
      console.log(`[WhatsApp] Restaurando sesión persistida para tenant: ${tenantId}`);
      this.connectInstance(tenantId).catch((err) =>
        console.error(`[WhatsApp:${tenantId}] Error restaurando sesión:`, err)
      );
    }
  }

  async getStatus(tenantId: string): Promise<{ status: string; details?: Record<string, unknown> }> {
    const session = this.sessions.get(tenantId);
    if (!session) {
      return { status: 'DISCONNECTED' };
    }
    return {
      status: session.status,
      details: {
        phoneNumber: session.phoneNumber,
        qrBase64: session.qrBase64,
        pairingCode: session.pairingCode
      }
    };
  }

  // Envía mensaje o documento con tiempo de escritura proporcional y huella polimórfica
  async send(options: SendMessageOptions): Promise<{ externalId?: string }> {
    const { tenantId, recipient, type, payload } = options;
    const session = this.sessions.get(tenantId);

    if (!session || session.status !== 'CONNECTED') {
      throw new Error('SESSION_NOT_CONNECTED');
    }

    const cleanNumber = recipient.replace(/\D/g, '');
    const results = await session.socket.onWhatsApp(cleanNumber);
    const check = results?.[0];

    if (!check || !check.exists) {
      throw new Error(`INVALID_WHATSAPP_NUMBER: El número ${cleanNumber} no tiene WhatsApp activo`);
    }

    const jid = check.jid;
    await session.socket.presenceSubscribe(jid);

    if (type === 'TEXT') {
      const finalText = humanizeContent(payload.text);
      // Calcula tiempo de escritura humano (~50ms por carácter, mínimo 1.8s, máximo 8.5s + variación)
      const baseTypingMs = Math.min(Math.max(finalText.length * 50, 1800), 8500);
      const typingMs = baseTypingMs + randomInt(200, 1100);

      await session.socket.sendPresenceUpdate('composing', jid);
      await new Promise((r) => setTimeout(r, typingMs));
      await session.socket.sendPresenceUpdate('paused', jid);

      const sent = await session.socket.sendMessage(jid, { text: finalText });
      return { externalId: sent?.key.id || undefined };
    }

    // Para archivos (PDF/Imagen): pausa corta de adjuntado sin fingir escritura larga
    await new Promise((r) => setTimeout(r, randomInt(1200, 2400)));
    const finalCaption = payload.caption || payload.text
      ? humanizeContent(payload.caption || payload.text)
      : undefined;

    if (type === 'DOCUMENT') {
      const buffer = payload.mediaBase64
        ? Buffer.from(payload.mediaBase64, 'base64')
        : { url: payload.mediaUrl || '' };

      const sent = await session.socket.sendMessage(jid, {
        document: buffer,
        mimetype: payload.mimeType || 'application/pdf',
        fileName: payload.fileName || 'documento.pdf',
        caption: finalCaption
      });
      return { externalId: sent?.key.id || undefined };
    }

    if (type === 'IMAGE') {
      const buffer = payload.mediaBase64
        ? Buffer.from(payload.mediaBase64, 'base64')
        : { url: payload.mediaUrl || '' };

      const sent = await session.socket.sendMessage(jid, {
        image: buffer,
        caption: finalCaption
      });
      return { externalId: sent?.key.id || undefined };
    }

    throw new Error(`Tipo de mensaje no soportado: ${type}`);
  }
}

export const whatsappAdapter = new WhatsAppAdapter();

