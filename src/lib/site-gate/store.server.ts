import type { SecurityState } from "./gate.ts";
import {
  PasswordStoreUnavailable,
  databaseConfigured,
  securityWithoutDatabase,
} from "./env-security.ts";

interface SecurityRow {
  password_hash: string | null;
  session_version: number | string;
}

function asState(row: SecurityRow | undefined): SecurityState {
  if (!row) return { passwordHash: null, sessionVersion: 0 };
  const version = Number(row.session_version);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error("invalid session version");
  }
  const hash = row.password_hash;
  return {
    passwordHash: typeof hash === "string" && hash.length > 0 ? hash : null,
    sessionVersion: version,
  };
}

/** True when a real database backs the app — DATABASE_URL, or D1 on Workers. */
export function passwordChangesEnabled(): boolean {
  if (databaseConfigured(process.env.DATABASE_URL)) return true;
  return (
    typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers"
  );
}

function envSecurity(): SecurityState {
  return securityWithoutDatabase(process.env.SESSION_VERSION);
}

/**
 * Password-check state.
 * No database: do not open PGLite. That open is what turned every POST /login into 503.
 */
export async function loadSecurity(): Promise<SecurityState> {
  if (!passwordChangesEnabled()) return envSecurity();
  const { getSql } = await import("../db.ts");
  const sql = await getSql();
  const rows = await sql<SecurityRow>`
    select password_hash, session_version from site_security where id = 'site'
  `;
  return asState(rows[0]);
}

/** Replace the site password and bump the session version in one statement. */
export async function savePasswordHash(passwordHash: string): Promise<SecurityState> {
  if (!passwordChangesEnabled()) throw new PasswordStoreUnavailable();
  const { getSql } = await import("../db.ts");
  const sql = await getSql();
  const rows = await sql<SecurityRow>`
    insert into site_security (id, password_hash, session_version, updated_at)
    values ('site', ${passwordHash}, 1, current_timestamp)
    on conflict (id) do update set
      password_hash = excluded.password_hash,
      session_version = site_security.session_version + 1,
      updated_at = current_timestamp
    returning password_hash, session_version
  `;
  const state = asState(rows[0]);
  if (!state.passwordHash) throw new Error("could not store password");
  return state;
}
