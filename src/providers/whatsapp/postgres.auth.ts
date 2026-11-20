import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  SignalDataTypeMap
} from '@whiskeysockets/baileys';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { encryptPayload, decryptPayload } from '../../utils/crypto.js';

// Reemplazo transaccional de useMultiFileAuthState sobre PostgreSQL (Cifrado AES-256-GCM para evitar robo de sesiones)
export async function usePostgresAuthState(tenantId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearSession: () => Promise<void>;
}> {
  const serialize = (data: unknown) => JSON.parse(JSON.stringify(data, BufferJSON.replacer));

  const writeData = async (keyId: string, data: unknown) => {
    const serialized = serialize(data);
    const encrypted = encryptPayload(serialized);

    await prisma.sessionCreds.upsert({
      where: {
        tenantId_channel_keyId: { tenantId, channel: 'WHATSAPP', keyId }
      },
      create: { tenantId, channel: 'WHATSAPP', keyId, data: encrypted as unknown as Prisma.InputJsonValue },
      update: { data: encrypted as unknown as Prisma.InputJsonValue }
    });
  };

  const readData = async (keyId: string) => {
    const row = await prisma.sessionCreds.findUnique({
      where: {
        tenantId_channel_keyId: { tenantId, channel: 'WHATSAPP', keyId }
      }
    });
    if (!row || !row.data) return null;
    const decrypted = decryptPayload(row.data);
    return JSON.parse(JSON.stringify(decrypted), BufferJSON.reviver);
  };

  const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          if (ids.length === 0) return data;

          const fullKeyIds = ids.map((id) => `${type}-${id}`);
          const rows = await prisma.sessionCreds.findMany({
            where: {
              tenantId,
              channel: 'WHATSAPP',
              keyId: { in: fullKeyIds }
            }
          });

          const rowMap = new Map(rows.map((r) => [r.keyId, r.data]));
          for (const id of ids) {
            const rawData = rowMap.get(`${type}-${id}`);
            if (!rawData) continue;
            const decrypted = decryptPayload(rawData);
            let value = JSON.parse(JSON.stringify(decrypted), BufferJSON.reviver);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const operations: Prisma.PrismaPromise<unknown>[] = [];
          for (const category in data) {
            const catKey = category as keyof SignalDataTypeMap;
            const categoryData = data[catKey];
            if (!categoryData) continue;

            for (const id in categoryData) {
              const value = categoryData[id];
              const keyId = `${category}-${id}`;
              if (value) {
                const serialized = serialize(value);
                const encrypted = encryptPayload(serialized);
                operations.push(
                  prisma.sessionCreds.upsert({
                    where: {
                      tenantId_channel_keyId: { tenantId, channel: 'WHATSAPP', keyId }
                    },
                    create: {
                      tenantId,
                      channel: 'WHATSAPP',
                      keyId,
                      data: encrypted as unknown as Prisma.InputJsonValue
                    },
                    update: { data: encrypted as unknown as Prisma.InputJsonValue }
                  })
                );
              } else {
                operations.push(
                  prisma.sessionCreds.deleteMany({
                    where: { tenantId, channel: 'WHATSAPP', keyId }
                  })
                );
              }
            }
          }
          if (operations.length > 0) {
            await prisma.$transaction(operations);
          }
        }
      }
    },
    saveCreds: () => writeData('creds', creds),
    clearSession: async () => {
      await prisma.sessionCreds.deleteMany({
        where: { tenantId, channel: 'WHATSAPP' }
      });
    }
  };
}
