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

// Reemplazo transaccional de useMultiFileAuthState sobre PostgreSQL (Evita corrupción de llaves Signal)
export async function usePostgresAuthState(tenantId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearSession: () => Promise<void>;
}> {
  const serialize = (data: unknown) => JSON.parse(JSON.stringify(data, BufferJSON.replacer));

  const writeData = async (keyId: string, data: unknown) => {
    const serialized = serialize(data);
    await prisma.sessionCreds.upsert({
      where: {
        tenantId_channel_keyId: { tenantId, channel: 'WHATSAPP', keyId }
      },
      create: { tenantId, channel: 'WHATSAPP', keyId, data: serialized },
      update: { data: serialized }
    });
  };

  const readData = async (keyId: string) => {
    const row = await prisma.sessionCreds.findUnique({
      where: {
        tenantId_channel_keyId: { tenantId, channel: 'WHATSAPP', keyId }
      }
    });
    if (!row || !row.data) return null;
    return JSON.parse(JSON.stringify(row.data), BufferJSON.reviver);
  };

  const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
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
                operations.push(
                  prisma.sessionCreds.upsert({
                    where: {
                      tenantId_channel_keyId: { tenantId, channel: 'WHATSAPP', keyId }
                    },
                    create: { tenantId, channel: 'WHATSAPP', keyId, data: serialized },
                    update: { data: serialized }
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
