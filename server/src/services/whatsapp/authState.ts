import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from 'baileys';
import type { Store } from '../../db/store.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';

export interface DbAuthState {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
}

/**
 * Baileys auth state (linked-device credentials + Signal keys) persisted in Postgres,
 * every value AES-256-GCM encrypted with ENCRYPTION_KEY. Railway containers have no
 * persistent disk, so the session must live in the database to survive deploys.
 * Everything is loaded once and served from memory; writes are queued in order.
 */
export async function useDbAuthState(store: Store, consultantId: string, key: Buffer): Promise<DbAuthState> {
  const values = new Map<string, unknown>();
  for (const [name, ciphertext] of Object.entries(await store.loadWhatsAppAuth(consultantId))) {
    try {
      values.set(name, JSON.parse(decryptSecret(ciphertext, key), BufferJSON.reviver));
    } catch {
      /* unreadable entry (e.g. ENCRYPTION_KEY changed): treated as missing */
    }
  }
  const encode = (value: unknown) => encryptSecret(JSON.stringify(value, BufferJSON.replacer), key);

  let queue: Promise<void> = Promise.resolve();
  const write = (entries: Record<string, string | null>): Promise<void> => {
    // A failed write must not block the ones after it.
    queue = queue.catch(() => undefined).then(() => store.saveWhatsAppAuth(consultantId, entries));
    return queue;
  };

  const creds = (values.get('creds') as AuthenticationCreds | undefined) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = values.get(`${type}:${id}`);
            if (value === undefined) continue;
            if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            out[id] = value as SignalDataTypeMap[T];
          }
          return out;
        },
        set: async (data: SignalDataSet) => {
          const entries: Record<string, string | null> = {};
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            for (const [id, value] of Object.entries(data[category] ?? {})) {
              const name = `${category}:${id}`;
              if (value) {
                values.set(name, value);
                entries[name] = encode(value);
              } else {
                values.delete(name);
                entries[name] = null;
              }
            }
          }
          if (Object.keys(entries).length) await write(entries);
        },
      },
    },
    saveCreds: () => write({ creds: encode(creds) }),
  };
}
