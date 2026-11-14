import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
   proto,
  SignalDataTypeMap
} from '@whiskeysockets/baileys';
import { prisma } from '../../config/prisma.js';

// Reemplazo transaccional de useMultiFileAuthState sobre PostgreSQL (Evita corrupción de llaves Signal)
export async function usePostgresAuthState(tenantId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearSession: () => Promise<void>;
}> {
  const writeData = async (keyId: string, data: unknown) => {
    const serialized = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
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

  const removeData = async (keyId: string) => {
    await prisma.sessionCreds.deleteMany({
      where: { tenantId, channel: 'WHATSAPP', keyId }
    });
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
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const catKey = category as keyof SignalDataTypeMap;
            const categoryData = data[catKey];
            if (!categoryData) continue;

            for (const id in categoryData) {
              const value = categoryData[id];
              const keyId = `${category}-${id}`;
              tasks.push(value ? writeData(keyId, value) : removeData(keyId));
            }
          }
          await Promise.all(tasks);
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

