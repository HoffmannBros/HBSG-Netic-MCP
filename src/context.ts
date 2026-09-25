import { NeticClient, NeticConfigError } from "./client.js";
import { loadConfig, type Config } from "./config.js";

export interface AppContext {
  config: Config;
  /** The client for a configured tenant. Throws, listing the valid names, for anything else. */
  clientFor(tenant: string): NeticClient;
  tenantNames(): string[];
}

export function createContext(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): AppContext {
  const config = loadConfig(env);
  const clients = new Map<string, NeticClient>();
  for (const t of config.tenants.values()) {
    clients.set(
      t.name,
      new NeticClient({
        tenant: t.name,
        token: t.token,
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs,
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    );
  }
  const tenantNames = () => [...clients.keys()];
  return {
    config,
    tenantNames,
    clientFor(tenant: string): NeticClient {
      const name = tenant.trim().toLowerCase();
      const client = clients.get(name);
      if (client) return client;
      if (clients.size === 0) {
        throw new NeticConfigError(
          "No Netic tenants are configured. In Claude Desktop open Settings, Extensions, Netic and fill in a tenant name and token, or set NETIC_TENANTS and NETIC_TENANT_<NAME>_TOKEN in .env.",
        );
      }
      throw new NeticConfigError(`Unknown tenant "${tenant}". Configured tenants: ${tenantNames().join(", ")}. There is no default tenant; pass one of these.`);
    },
  };
}
