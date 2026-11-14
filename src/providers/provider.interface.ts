export interface MessagePayload {
  text?: string;
  caption?: string;
  mediaUrl?: string;
  mediaBase64?: string;
  fileName?: string;
  mimeType?: string;
}

export interface SendMessageOptions {
  tenantId: string;
  recipient: string;
  type: 'TEXT' | 'DOCUMENT' | 'IMAGE';
  payload: MessagePayload;
  simulateTypingMs?: number;
}

// Contrato único para cualquier canal (WhatsApp, Telegram, Messenger)
export interface IMessageProvider {
  send(options: SendMessageOptions): Promise<{ externalId?: string }>;
  getStatus(tenantId: string): Promise<{ status: string; details?: Record<string, unknown> }>;
}

