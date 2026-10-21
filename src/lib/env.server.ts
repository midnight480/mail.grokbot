export function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

/**
 * Workspace preview vs deployed app. The deployer writes GROK_PROJECT_ID on
 * every publish; the sandbox preview never has it. Single source of truth for
 * the split — gate audience, gate endpoints and connector-token semantics all
 * key off this predicate.
 */
export function isWorkspacePreview(): boolean {
  return !env("GROK_PROJECT_ID");
}

/*
 * Grokbot Mail configuration. Every deploy sets its own values; nothing here
 * names a person, an inbox, or a host. The older names (APP_PASSWORD,
 * SESSION_SECRET, INGEST_TOKEN) still work so existing deploys keep running.
 */

/** Site password. GBM_SITE_PASSWORD, or the older APP_PASSWORD. */
export function sitePassword(): string | undefined {
  return env("GBM_SITE_PASSWORD") ?? env("APP_PASSWORD");
}

/** Session cookie signing secret. GBM_SESSION_SECRET, or the older SESSION_SECRET. */
export function sessionSecret(): string | undefined {
  return env("GBM_SESSION_SECRET") ?? env("SESSION_SECRET");
}

/** Bearer token for the bot routes. GBM_INGEST_TOKEN, or the older INGEST_TOKEN. */
export function ingestTokenFromEnv(): string | undefined {
  return env("GBM_INGEST_TOKEN") ?? env("INGEST_TOKEN");
}

/**
 * Cloudflare Workers: the D1 `DB` binding is the database there, so "no
 * DATABASE_URL" must not silently mean demo. `process.env` still exists under
 * nodejs_compat — GBM_* vars work as usual.
 */
const isWorkers =
  typeof navigator !== "undefined" &&
  navigator.userAgent === "Cloudflare-Workers";

/**
 * Demo mode serves invented sample mail so anyone can try the app.
 * On with GBM_DEMO=1, or when no database is available (no DATABASE_URL, not
 * on Workers/D1, no Aurora DSQL endpoint). GBM_DEMO=0 turns it off.
 */
export function demoMode(): boolean {
  const flag = env("GBM_DEMO");
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return !env("DATABASE_URL") && !isWorkers && !env("DSQL_CLUSTER_ENDPOINT");
}

export type OwnerConfig = {
  address: string;
  displayName: string;
  /** Plus tags from GBM_TAGS. Null when GBM_TAGS is unset. */
  tags: { tag: string; name: string }[] | null;
};

/** `ops,books:Reading` → [{ tag: "ops", name: "Ops" }, { tag: "books", name: "Reading" }]. */
export function parseTags(raw: string | undefined): { tag: string; name: string }[] | null {
  if (raw === undefined) return null;
  const out: { tag: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const [rawTag, ...rest] = part.split(":");
    const tag = (rawTag ?? "").trim().toLowerCase().replace(/^\+/, "");
    if (!/^[a-z0-9._-]{1,64}$/.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    const label = rest.join(":").trim();
    out.push({ tag, name: label || tag.charAt(0).toUpperCase() + tag.slice(1) });
  }
  return out;
}

/** The mailbox owner from GBM_INBOX_ADDRESS, GBM_OWNER_NAME, and GBM_TAGS. Null without an address. */
export function ownerFromEnv(): OwnerConfig | null {
  const address = env("GBM_INBOX_ADDRESS");
  if (!address || !/^[^@\s]+@[^@\s]+$/.test(address)) return null;
  const local = address.split("@")[0] ?? "";
  return {
    address,
    displayName: env("GBM_OWNER_NAME") ?? local,
    tags: parseTags(process.env.GBM_TAGS),
  };
}
