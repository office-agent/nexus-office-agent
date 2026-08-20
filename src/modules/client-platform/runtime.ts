import { randomBytes } from "node:crypto";
import { ClientPlatformService } from "@/src/modules/client-platform/application/service";
import { InMemoryClientPlatformRepository } from "@/src/modules/client-platform/infrastructure/in-memory-repository";
import { PostgresClientPlatformRepository } from "@/src/modules/client-platform/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { ManagedSecretClient } from "@/src/platform/secrets/managed-secret-client";

const runtime=globalThis as typeof globalThis & {__nexusClientService?:ClientPlatformService;__nexusClientRepo?:InMemoryClientPlatformRepository;__nexusClientKey?:Buffer};

export function getClientPlatformService():ClientPlatformService {
  runtime.__nexusClientService??=new ClientPlatformService(process.env.DATABASE_URL?new PostgresClientPlatformRepository(createPostgresDatabase(process.env.DATABASE_URL)):(runtime.__nexusClientRepo??=new InMemoryClientPlatformRepository()));
  return runtime.__nexusClientService;
}

export async function getClientDataEncryptionKey():Promise<{key:Buffer;keyRef:string}> {
  const keyRef=process.env.CLIENT_DATA_ENCRYPTION_KEY_REF;
  if(process.env.NODE_ENV==="production") {
    if(!keyRef || process.env.SECRET_PROVIDER!=="managed-http") throw new Error("CLIENT_DATA_ENCRYPTION_KEY_REQUIRED");
    const encoded=await new ManagedSecretClient().resolveString(keyRef,"client-push-encryption"); const key=Buffer.from(encoded,"base64");
    if(key.length!==32) throw new Error("DATA_ENCRYPTION_KEY_INVALID"); return {key,keyRef};
  }
  runtime.__nexusClientKey??=randomBytes(32); return {key:runtime.__nexusClientKey,keyRef:"secret://development/ephemeral-client-key"};
}
