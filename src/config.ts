import os from "node:os";
import path from "node:path";

export interface TenantConfig {
  /** Lowercase slug the tools take as `tenant`, e.g. "stl". */
  name: string;
  /** Tenant-scoped bearer JWT. Never log or echo it. */
  token: string;
}

export interface Config {
  /** Keyed by tenant name, in configuration order. */
  tenants: Map<string, TenantConfig>;
  baseUrl: string;
  outputDir: string;
  timeoutMs: number;
  /** Problems found while loading, for stderr. Never contains a token. */
  warnings: string[];
}

export const DEFAULT_BASE_URL = "https://app.netic.ai";
export const DEFAULT_OUTPUT_DIR = "${DOCUMENTS}/Netic Reports";
/** The manifest exposes this many fixed tenant slots. */
export const SLOT_COUNT = 4;

const TENANT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Expand the MCPB path placeholders ourselves. Claude Desktop passes
 * user_config defaults such as "${DOCUMENTS}/..." through literally
 * (observed on the ServiceTitan bundle), so the server must resolve them.
 */
export function expandPathTokens(raw: string, home: string = os.homedir()): string {
  const replacements: Array<[string, string]> = [
    ["${HOME}", home],
    ["${DOCUMENTS}", path.join(home, "Documents")],
    ["${DESKTOP}", path.join(home, "Desktop")],
    ["${DOWNLOADS}", path.join(home, "Downloads")],
  ];
  let out = raw.trim();
  for (const [token, value] of replacements) {
    out = out.split(token).join(value);
  }
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    out = path.join(home, out.slice(1));
  }
  return path.resolve(out);
}

/**
 * Blank values and unsubstituted manifest placeholders count as absent.
 * Claude Desktop passes `${user_config.x}` through literally when the user
 * leaves an optional field empty.
 */
export function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("${user_config")) return undefined;
  return trimmed;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** `blue-sky` -> `BLUE_SKY`, for the `NETIC_TENANT_<SLUG>_TOKEN` variable name. */
export function envKeyFor(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}

function addTenant(tenants: Map<string, TenantConfig>, warnings: string[], rawName: string, token: string | undefined, source: string): void {
  const name = rawName.trim().toLowerCase();
  if (!TENANT_NAME.test(name)) {
    warnings.push(`${source}: tenant name "${rawName}" is not a valid slug (lowercase letters, digits, - or _); skipped.`);
    return;
  }
  if (!token) {
    warnings.push(`${source}: tenant "${name}" has no token; skipped.`);
    return;
  }
  if (tenants.has(name)) {
    warnings.push(`${source}: tenant "${name}" is configured more than once; the later entry wins.`);
  }
  tenants.set(name, { name, token });
}

/**
 * Tenants come from two places, merged in this order:
 * 1. `.env` style: `NETIC_TENANTS=stl,nash` plus `NETIC_TENANT_<SLUG>_TOKEN`.
 * 2. Manifest slots: `NETIC_TENANT_SLOT<n>_NAME` and `NETIC_TENANT_SLOT<n>_TOKEN`.
 * There is deliberately no default tenant.
 */
export function loadTenants(env: NodeJS.ProcessEnv, warnings: string[] = []): Map<string, TenantConfig> {
  const tenants = new Map<string, TenantConfig>();
  const list = blankToUndefined(env.NETIC_TENANTS);
  if (list) {
    for (const raw of list.split(",")) {
      if (!raw.trim()) continue;
      const key = `NETIC_TENANT_${envKeyFor(raw.trim())}_TOKEN`;
      addTenant(tenants, warnings, raw, blankToUndefined(env[key]), key);
    }
  }
  for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
    const name = blankToUndefined(env[`NETIC_TENANT_SLOT${slot}_NAME`]);
    const token = blankToUndefined(env[`NETIC_TENANT_SLOT${slot}_TOKEN`]);
    if (!name && !token) continue;
    if (!name) {
      warnings.push(`Tenant slot ${slot} has a token but no name; skipped.`);
      continue;
    }
    addTenant(tenants, warnings, name, token, `Tenant slot ${slot}`);
  }
  return tenants;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Config {
  const warnings: string[] = [];
  const tenants = loadTenants(env, warnings);
  return {
    tenants,
    baseUrl: (blankToUndefined(env.NETIC_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    outputDir: expandPathTokens(blankToUndefined(env.NETIC_OUTPUT_DIR) ?? DEFAULT_OUTPUT_DIR, home),
    timeoutMs: positiveInt(env.NETIC_TIMEOUT_MS, 120_000),
    warnings,
  };
}
