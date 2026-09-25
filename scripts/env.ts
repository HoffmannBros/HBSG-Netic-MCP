/** Minimal .env reader shared by the probe and smoke scripts. Never prints values. */
import fs from "node:fs";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");

export function readDotEnv(file = path.join(root, ".env")): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1]) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return out;
}

/** .env values, overridden by any NETIC_* variables already in the environment. */
export function neticEnv(): Record<string, string> {
  const env = readDotEnv();
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("NETIC_") && v !== undefined) env[k] = v;
  }
  return env;
}

/** Local calendar date, YYYY-MM-DD, `offset` days from today. */
export function localDate(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
