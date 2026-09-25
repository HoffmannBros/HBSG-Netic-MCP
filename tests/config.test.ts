import { describe, expect, it } from "vitest";
import path from "node:path";
import { DEFAULT_BASE_URL, expandPathTokens, loadConfig } from "../src/config.js";
import { createContext } from "../src/context.js";

const home = path.resolve("/Users/example");

describe("expandPathTokens", () => {
  it("expands the MCPB placeholders that Claude Desktop leaves literal", () => {
    expect(expandPathTokens("${DOCUMENTS}/Netic Reports", home)).toBe(path.join(home, "Documents", "Netic Reports"));
    expect(expandPathTokens("${HOME}/x", home)).toBe(path.join(home, "x"));
    expect(expandPathTokens("${DESKTOP}", home)).toBe(path.join(home, "Desktop"));
    expect(expandPathTokens("${DOWNLOADS}", home)).toBe(path.join(home, "Downloads"));
  });

  it("expands a leading tilde and trims whitespace", () => {
    expect(expandPathTokens("  ~/reports ", home)).toBe(path.join(home, "reports"));
  });
});

describe("loadConfig", () => {
  it("applies defaults and configures no tenant when nothing is set", () => {
    const cfg = loadConfig({}, home);
    expect(cfg.tenants.size).toBe(0);
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.outputDir).toBe(path.join(home, "Documents", "Netic Reports"));
    expect(cfg.timeoutMs).toBe(120_000);
  });

  it("reads NETIC_TENANTS plus one token per slug, lowercasing names", () => {
    const cfg = loadConfig(
      {
        NETIC_TENANTS: " STL, nash ,blue-sky,",
        NETIC_TENANT_STL_TOKEN: "t-stl",
        NETIC_TENANT_NASH_TOKEN: "t-nash",
        NETIC_TENANT_BLUE_SKY_TOKEN: "t-blue",
      },
      home,
    );
    expect([...cfg.tenants.keys()]).toEqual(["stl", "nash", "blue-sky"]);
    expect(cfg.tenants.get("blue-sky")?.token).toBe("t-blue");
    expect(cfg.warnings).toEqual([]);
  });

  it("skips a listed tenant with no token and warns without echoing anything secret", () => {
    const cfg = loadConfig({ NETIC_TENANTS: "stl,ferg", NETIC_TENANT_STL_TOKEN: "secret-stl" }, home);
    expect([...cfg.tenants.keys()]).toEqual(["stl"]);
    expect(cfg.warnings.join(" ")).toMatch(/ferg/);
    expect(cfg.warnings.join(" ")).not.toMatch(/secret/);
  });

  it("reads manifest slots and treats blanks and unsubstituted placeholders as absent", () => {
    const cfg = loadConfig(
      {
        NETIC_TENANT_SLOT1_NAME: "stl",
        NETIC_TENANT_SLOT1_TOKEN: "t1",
        NETIC_TENANT_SLOT2_NAME: "${user_config.tenant2_name}",
        NETIC_TENANT_SLOT2_TOKEN: "${user_config.tenant2_token}",
        NETIC_TENANT_SLOT3_NAME: "  ",
        NETIC_TENANT_SLOT3_TOKEN: "",
        NETIC_TENANT_SLOT4_NAME: "Ferg",
        NETIC_TENANT_SLOT4_TOKEN: "t4",
      },
      home,
    );
    expect([...cfg.tenants.keys()]).toEqual(["stl", "ferg"]);
    expect(cfg.warnings).toEqual([]);
  });

  it("warns on a slot with a token but no name, and on invalid names", () => {
    const cfg = loadConfig(
      { NETIC_TENANT_SLOT1_TOKEN: "t1", NETIC_TENANT_SLOT2_NAME: "Blue Sky!", NETIC_TENANT_SLOT2_TOKEN: "t2" },
      home,
    );
    expect(cfg.tenants.size).toBe(0);
    expect(cfg.warnings).toHaveLength(2);
  });

  it("strips trailing slashes from the base URL and ignores a bad timeout", () => {
    const cfg = loadConfig({ NETIC_BASE_URL: "https://example.test//", NETIC_TIMEOUT_MS: "abc" }, home);
    expect(cfg.baseUrl).toBe("https://example.test");
    expect(cfg.timeoutMs).toBe(120_000);
  });
});

describe("createContext", () => {
  it("has no default tenant and lists valid names on an unknown one", () => {
    const ctx = createContext({ NETIC_TENANTS: "stl,nash", NETIC_TENANT_STL_TOKEN: "a", NETIC_TENANT_NASH_TOKEN: "b" });
    expect(ctx.clientFor(" STL ").tenant).toBe("stl");
    expect(() => ctx.clientFor("")).toThrow(/stl, nash/);
    expect(() => ctx.clientFor("blue")).toThrow(/Unknown tenant "blue"\. Configured tenants: stl, nash/);
  });

  it("explains how to configure when no tenant is set", () => {
    const ctx = createContext({});
    expect(() => ctx.clientFor("stl")).toThrow(/No Netic tenants are configured/);
  });
});
