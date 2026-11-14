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

  // Envía mensaje o documento simulando presencia ("Escribiendo...")
  async send(options: SendMessageOptions): Promise<{ externalId?: string }> {
    const { tenantId, recipient, type, payload, simulateTypingMs = 3500 } = options;
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

    // Simulación humana: "Escribiendo..."
    await session.socket.presenceSubscribe(jid);
    await session.socket.sendPresenceUpdate('composing', jid);
    await new Promise((r) => setTimeout(r, simulateTypingMs));
    await session.socket.sendPresenceUpdate('paused', jid);

    if (type === 'TEXT') {
      const sent = await session.socket.sendMessage(jid, { text: payload.text || '' });
      return { externalId: sent?.key.id || undefined };
    }

    if (type === 'DOCUMENT') {
      const buffer = payload.mediaBase64
        ? Buffer.from(payload.mediaBase64, 'base64')
        : { url: payload.mediaUrl || '' };

      const sent = await session.socket.sendMessage(jid, {
        document: buffer,
        mimetype: payload.mimeType || 'application/pdf',
        fileName: payload.fileName || 'documento.pdf',
        caption: payload.caption || payload.text
      });
      return { externalId: sent?.key.id || undefined };
    }

    if (type === 'IMAGE') {
      const buffer = payload.mediaBase64
        ? Buffer.from(payload.mediaBase64, 'base64')
        : { url: payload.mediaUrl || '' };

      const sent = await session.socket.sendMessage(jid, {
        image: buffer,
        caption: payload.caption || payload.text
      });
      return { externalId: sent?.key.id || undefined };
    }

    throw new Error(`Tipo de mensaje no soportado: ${type}`);
  }
}

export const whatsappAdapter = new WhatsAppAdapter();

