import crypto from 'crypto';
import { env } from '../config/env.js';

export interface WebhookPayload {
  event: 'message.received' | 'message.status';
  tenantId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export async function dispatchWebhook(payload: WebhookPayload): Promise<void> {
  if (!env.webhookUrl) return;

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'I-API-Gateway/1.0'
  };

  if (env.webhookSecret) {
    const signature = crypto
      .createHmac('sha256', env.webhookSecret)
      .update(body)
      .digest('hex');
    headers['X-Hub-Signature-256'] = `sha256=${signature}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(env.webhookUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[Webhook] Entrega fallida (${res.status}): ${res.statusText}`);
    }
  } catch (err) {
    console.warn('[Webhook] Error enviando webhook:', (err as Error).message);
  }
}
