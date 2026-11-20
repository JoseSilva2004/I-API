import crypto from 'crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getEncryptionKey(): Buffer {
  return crypto.createHash('sha256').update(env.encryptionKey).digest();
}

export interface EncryptedData {
  _encrypted: true;
  iv: string;
  tag: string;
  data: string;
}

export function encryptPayload(data: unknown): EncryptedData {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const jsonStr = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    _encrypted: true,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

export function decryptPayload<T = unknown>(encrypted: unknown): T {
  if (
    !encrypted ||
    typeof encrypted !== 'object' ||
    !('_encrypted' in encrypted) ||
    (encrypted as EncryptedData)._encrypted !== true
  ) {
    // Si no está cifrado (legacy data), lo devuelve tal cual
    return encrypted as T;
  }

  const { iv, tag, data } = encrypted as EncryptedData;
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getEncryptionKey(),
    Buffer.from(iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final()
  ]);

  return JSON.parse(decrypted.toString('utf8')) as T;
}
