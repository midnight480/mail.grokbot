import type { Sql } from "../../lib/db.ts";
import { abortTx, runWriteTx } from "../../lib/sql-tx.ts";
import { demoMode, sitePassword } from "../../lib/env.server.ts";
import type { Address, Attachment, Message } from "../../lib/mail/model.ts";
import {
  outboxTargetFromSendResult,
  outboxTransitionAllowed,
  parsePostedStatus,
  sentMessageIdForProvider,
  type OutboxStatus,
} from "../../lib/mail/outbox.ts";
import { normalizePath } from "../../lib/site-gate/paths.ts";
import { parseHtmlBody, type SendResult } from "./ingest.server.ts";
import { ingestTokenMatches, upsertMessage } from "./ingest-api.server.ts";
import { runDueWakes } from "./wake.server.ts";

export type OutboxApiDeps = {
  /** When set, this object is the only token source. A blank value rejects every bot call. */
  env?: { INGEST_TOKEN?: string };
  sql?: Sql;
  /** App routes only. Bot routes never call this. */
  session?: (request: Request) => Promise<boolean>;
  /** Clock for the stale-approval window. Defaults to Date.now. */
  now?: () => number;
};

type OutboundRow = {
  client_send_id: string;
  spec: string;
  status: string;
  error: string | null;
  reply_to_message_id: string | null;
  thread_key: string | null;
  provider_message_id: string | null;
};

type SpecMessage = Partial<Message> & { html?: unknown };

export type TransitionResult =
  | { ok: true; id: string; status: OutboxStatus }
  | { ok: false; status: 400 | 404 | 409; error: "invalid" | "not found" | "conflict" };

function json(status: number, body: unknown, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function ingestToken(deps: OutboxApiDeps): string | undefined {
  const raw = deps.env
    ? deps.env.INGEST_TOKEN
    : process.env.GBM_INGEST_TOKEN?.trim() || process.env.INGEST_TOKEN;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function providedBearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return "";
  return header.slice(prefix.length);
}

/** Bearer only. A session cookie is not a substitute. */
function authorizeBot(request: Request, deps: OutboxApiDeps): Response | null {
  const expected = ingestToken(deps);
  if (!expected) return json(503, { error: "unavailable" });
  if (!ingestTokenMatches(providedBearer(request), expected))
    return json(401, { error: "unauthorized" });
  return null;
}

async function openDatabase(): Promise<Sql> {
  const { getSql } = await import("../../lib/db.ts");
  return getSql();
}

async function database(deps: OutboxApiDeps): Promise<Sql> {
  return deps.sql ?? openDatabase();
}

async function sessionOpen(request: Request, deps: OutboxApiDeps): Promise<boolean> {
  if (deps.session) return deps.session(request);
  const { sessionAllowed } = await import("../../lib/site-gate/gate.ts");
  const { liveDeps } = await import("../../lib/site-gate/handle.server.ts");
  try {
    return await sessionAllowed(request, liveDeps());
  } catch {
    return false;
  }
}

function readSpec(text: string): SpecMessage | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as SpecMessage;
  } catch {
    return null;
  }
}

function emails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.includes("@")) {
      out.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const email = (item as { email?: unknown }).email;
    if (typeof email === "string" && email.includes("@")) out.push(email.trim());
  }
  return out;
}

function addresses(value: unknown): Address[] {
  if (!Array.isArray(value)) return [];
  const out: Address[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.includes("@")) {
      const email = item.trim();
      out.push({ name: email.split("@")[0] || email, email });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const email = (item as { email?: unknown }).email;
    const name = (item as { name?: unknown }).name;
    if (typeof email !== "string" || !email.includes("@")) continue;
    out.push({
      name: typeof name === "string" && name.trim() ? name.trim() : email.split("@")[0] || email,
      email: email.trim(),
    });
  }
  return out;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  const out: Attachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<Attachment>;
    if (typeof row.filename !== "string" || !row.filename) continue;
    out.push({
      id: typeof row.id === "string" && row.id ? row.id : `att_${row.filename}`,
      filename: row.filename,
      mime: typeof row.mime === "string" && row.mime ? row.mime : "application/octet-stream",
      bytes: typeof row.bytes === "number" && Number.isFinite(row.bytes) ? row.bytes : 0,
      path: typeof row.path === "string" ? row.path : "",
    });
  }
  return out;
}

type StatusInput = {
  status: OutboxStatus;
  providerMessageId: string | null;
  error: string | null;
};

function guardSql(target: OutboxStatus): string {
  if (target === "awaiting_approval" || target === "cancelled")
    return "status in ('queued', 'waiting', 'pending')";
  return "status = 'awaiting_approval'";
}

async function insertSentMessage(
  sql: Sql,
  row: OutboundRow,
  providerMessageId: string,
): Promise<void> {
  const spec = readSpec(row.spec) ?? {};
  let threadHint: string | null = null;
  let inReplyTo: string | null = null;
  let references: string[] = [];
  if (row.reply_to_message_id) {
    const found = await sql.query<{
      message_id: string | null;
      thread_hint: string | null;
      references_json: string;
    }>(`select message_id, thread_hint, references_json from mail_message where id = $1`, [
      row.reply_to_message_id,
    ]);
    const parent = found[0];
    if (parent) {
      threadHint = parent.thread_hint || null;
      inReplyTo = parent.message_id;
      let prior: string[] = [];
      try {
        prior = asStringList(JSON.parse(parent.references_json || "[]") as unknown);
      } catch {
        prior = [];
      }
      references = inReplyTo ? [...prior, inReplyTo] : prior;
    } else {
      threadHint = `outbox:${row.client_send_id}`;
    }
  } else {
    threadHint = `outbox:${row.client_send_id}`;
  }

  const fromList = addresses(spec.from ? [spec.from] : []);
  const from = fromList[0] ?? { name: "You", email: "you@example.com" };
  const message: Message = {
    id: sentMessageIdForProvider(providerMessageId),
    messageId: providerMessageId,
    inReplyTo,
    references,
    deliveredTo: null,
    account: "primary",
    from,
    to: addresses(spec.to),
    cc: addresses(spec.cc),
    bcc: [],
    subject: typeof spec.subject === "string" ? spec.subject : "",
    body: typeof spec.body === "string" ? spec.body : "",
    html: parseHtmlBody(spec.html),
    date: new Date().toISOString(),
    attachments: asAttachments(spec.attachments),
    delivery: "sent",
    clientSendId: row.client_send_id,
    threadHint,
    direction: "outbound",
  };
  await upsertMessage(sql, message, false);
}

/**
 * One status change. Callers own the transaction.
 * `sent` inserts `msg_<providerMessageId>` and a later ingest of that id updates it.
 */
export async function transitionOutbound(
  sql: Sql,
  id: string,
  input: StatusInput,
): Promise<TransitionResult> {
  if (input.status === "sent" && !input.providerMessageId)
    return { ok: false, status: 400, error: "invalid" };
  if (
    !outboxTransitionAllowed("queued", input.status) &&
    !outboxTransitionAllowed("awaiting_approval", input.status)
  ) {
    return { ok: false, status: 400, error: "invalid" };
  }
  const rows = await sql.query<OutboundRow>(
    `select client_send_id, spec, status, error, reply_to_message_id, thread_key, provider_message_id
     from mail_outbound where client_send_id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "not found" };
  if (!outboxTransitionAllowed(row.status, input.status))
    return { ok: false, status: 409, error: "conflict" };

  const error =
    input.status === "failed"
      ? (input.error ?? "")
      : input.status === "declined"
        ? input.error
        : null;
  const updated = await sql.query<{ client_send_id: string }>(
    `update mail_outbound set
       status = $2,
       provider_message_id = coalesce($3, provider_message_id),
       error = $4,
       last_error = case when $2 = 'failed' then $4 else last_error end,
       next_attempt_at = null,
       updated_at = $5
     where client_send_id = $1 and ${guardSql(input.status)}
     returning client_send_id`,
    [id, input.status, input.providerMessageId, error, new Date().toISOString()],
  );
  if (!updated.length) return { ok: false, status: 409, error: "conflict" };
  if (input.status === "sent" && input.providerMessageId)
    await insertSentMessage(sql, row, input.providerMessageId);
  return { ok: true, id, status: input.status };
}

/** Ingest send-result uses the same transition rules. A refused move leaves the row alone. */
export async function applySendResultToOutbound(sql: Sql, result: SendResult): Promise<void> {
  const status = outboxTargetFromSendResult(result.status);
  if (!status) return;
  await transitionOutbound(sql, result.clientSendId, {
    status,
    providerMessageId: result.sentMessageId,
    error: result.error,
  });
}

function botItem(row: OutboundRow, subjects: Map<string, string>) {
  const spec = readSpec(row.spec) ?? {};
  const from = addresses(spec.from ? [spec.from] : []);
  const replyId = row.reply_to_message_id?.trim() || "";
  return {
    id: row.client_send_id,
    fromAddress: from[0]?.email ?? "",
    to: emails(spec.to),
    cc: emails(spec.cc),
    subject: typeof spec.subject === "string" ? spec.subject : "",
    text: typeof spec.body === "string" ? spec.body : "",
    html: typeof spec.html === "string" ? spec.html : null,
    replyTo: replyId ? { ingestId: replyId, subject: subjects.get(replyId) ?? "" } : null,
  };
}

const STALE_DEFAULT_MINUTES = 10;

/** Whole minutes, default 10. Blank, negative, and non-integers are invalid. */
export function staleMinutes(raw: string | null): number | null {
  if (raw === null) return STALE_DEFAULT_MINUTES;
  const text = raw.trim();
  if (!/^(0|[1-9]\d{0,7})$/.test(text)) return null;
  return Number(text);
}

function rowMillis(row: { created_at?: string | null; updated_at?: string | null }): number | null {
  const updated = typeof row.updated_at === "string" ? row.updated_at.trim() : "";
  const created = typeof row.created_at === "string" ? row.created_at.trim() : "";
  const raw = updated || created;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

async function replySubjects(
  sql: Sql,
  rows: readonly { reply_to_message_id: string | null }[],
): Promise<Map<string, string>> {
  const replyIds = [
    ...new Set(
      rows.map((row) => row.reply_to_message_id).filter((id): id is string => Boolean(id)),
    ),
  ];
  const subjects = new Map<string, string>();
  if (replyIds.length === 0) return subjects;
  const marks = replyIds.map((_, index) => `$${index + 1}`).join(", ");
  const found = await sql.query<{ id: string; subject: string }>(
    `select id, subject from mail_message where id in (${marks})`,
    replyIds,
  );
  for (const item of found) subjects.set(item.id, item.subject ?? "");
  return subjects;
}

async function listQueued(sql: Sql): Promise<Response> {
  const rows = await sql.query<OutboundRow>(
    `select client_send_id, spec, status, error, reply_to_message_id, thread_key, provider_message_id
     from mail_outbound
     where status in ('queued', 'waiting', 'pending')
     order by created_at asc, client_send_id asc`,
  );
  const subjects = await replySubjects(sql, rows);
  return json(
    200,
    rows.map((row) => botItem(row, subjects)),
  );
}

type StaleRow = OutboundRow & { created_at: string; updated_at: string | null };

/** awaiting_approval strictly older than cutoffMs. Age uses updated_at, then created_at. */
async function listStale(sql: Sql, cutoffMs: number): Promise<Response> {
  const rows = await sql.query<StaleRow>(
    `select client_send_id, spec, status, error, reply_to_message_id, thread_key, provider_message_id,
            created_at, updated_at
     from mail_outbound
     where status = 'awaiting_approval'`,
  );
  const stale = rows
    .filter((row) => {
      const ms = rowMillis(row);
      return ms !== null && ms < cutoffMs;
    })
    .sort((a, b) => {
      const am = rowMillis(a) ?? 0;
      const bm = rowMillis(b) ?? 0;
      if (am !== bm) return am - bm;
      if (a.client_send_id < b.client_send_id) return -1;
      if (a.client_send_id > b.client_send_id) return 1;
      return 0;
    });
  const subjects = await replySubjects(sql, stale);
  return json(
    200,
    stale.map((row) => botItem(row, subjects)),
  );
}

function cleanProvider(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || trimmed.includes("\0")) return null;
  return trimmed;
}

function cleanError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.slice(0, 2000);
}

async function readStatusBody(request: Request): Promise<StatusInput | Response> {
  let payload: unknown;
  try {
    payload = (await request.json()) as unknown;
  } catch {
    return json(400, { error: "invalid" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return json(400, { error: "invalid" });
  const row = payload as { status?: unknown; providerMessageId?: unknown; error?: unknown };
  const status = parsePostedStatus(row.status);
  if (!status) return json(400, { error: "invalid" });
  return {
    status,
    providerMessageId: cleanProvider(row.providerMessageId),
    error: cleanError(row.error),
  };
}

/**
 * `run` inside a write transaction where the backend has one (Postgres);
 * sequential statements on D1. A refused transition aborts the write the same
 * way either way — the guarded UPDATE in `transitionOutbound` stays the
 * correctness boundary (status compare-and-swap is atomic per row).
 */
async function withTransaction(sql: Sql, run: () => Promise<TransitionResult>): Promise<Response> {
  try {
    const result = await runWriteTx<TransitionResult>(sql, async () => {
      const next = await run();
      if (!next.ok) abortTx(next);
      return next;
    });
    if (!result.ok) return json(result.status, { error: result.error });
    return json(200, { id: result.id, status: result.status });
  } catch (err) {
    console.error("[outbox] write failed", err instanceof Error ? err.name : "error");
    return json(503, { error: "unavailable" });
  }
}

async function runDueQuiet(sql: Sql): Promise<void> {
  try {
    await runDueWakes(sql);
  } catch {
    // A missing column or a wake error must not fail this request.
  }
}

function decodeId(value: string): string | null {
  try {
    const id = decodeURIComponent(value);
    if (!id || id.length > 512 || id.includes("\0") || id.includes("/")) return null;
    return id;
  } catch {
    return null;
  }
}

/**
 * `/api/outbox` for the bot (bearer) and cancel for the app (session cookie).
 * The two credentials are not interchangeable.
 */
export async function handleOutboxApi(
  request: Request,
  deps: OutboxApiDeps = {},
): Promise<Response> {
  const path = normalizePath(new URL(request.url).pathname);
  const method = request.method.toUpperCase();

  if (path === "/api/outbox") {
    const denied = authorizeBot(request, deps);
    if (denied) return denied;
    if (method !== "GET") return json(405, { error: "method" }, { allow: "GET" });
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    if (status !== "queued" && status !== "stale") return json(400, { error: "invalid" });
    const minutes = status === "stale" ? staleMinutes(url.searchParams.get("older-than")) : null;
    if (status === "stale" && minutes === null) return json(400, { error: "invalid" });
    try {
      const sql = await database(deps);
      await runDueQuiet(sql);
      if (status === "queued") return await listQueued(sql);
      const nowMs = deps.now?.() ?? Date.now();
      const cutoffMs = nowMs - (minutes ?? STALE_DEFAULT_MINUTES) * 60_000;
      if (!Number.isFinite(cutoffMs)) return json(400, { error: "invalid" });
      return await listStale(sql, cutoffMs);
    } catch (err) {
      console.error("[outbox] list failed", err instanceof Error ? err.name : "error");
      return json(503, { error: "unavailable" });
    }
  }

  const statusMatch = /^\/api\/outbox\/([^/]+)\/status$/.exec(path);
  if (statusMatch) {
    const denied = authorizeBot(request, deps);
    if (denied) return denied;
    if (method !== "POST") return json(405, { error: "method" }, { allow: "POST" });
    const id = decodeId(statusMatch[1] ?? "");
    if (!id) return json(404, { error: "not found" });
    const body = await readStatusBody(request);
    if (body instanceof Response) return body;
    try {
      const sql = await database(deps);
      await runDueQuiet(sql);
      return await withTransaction(sql, () => transitionOutbound(sql, id, body));
    } catch (err) {
      console.error("[outbox] status failed", err instanceof Error ? err.name : "error");
      return json(503, { error: "unavailable" });
    }
  }

  const itemMatch = /^\/api\/outbox\/([^/]+)$/.exec(path);
  if (itemMatch) {
    if (method !== "DELETE") return json(405, { error: "method" }, { allow: "DELETE" });
    // Live calls pass no sql. Tests that inject sql keep the database path.
    if (demoMode() && deps.sql === undefined && deps.session === undefined) {
      if (sitePassword()) {
        let open = false;
        try {
          open = await sessionOpen(request, deps);
        } catch {
          open = false;
        }
        if (!open) return json(401, { error: "unauthorized" });
      }
      const id = decodeId(itemMatch[1] ?? "");
      if (!id) return json(404, { error: "not found" });
      const { cancelDemoOutbox } = await import("./demo-state.server.ts");
      const result = cancelDemoOutbox(id);
      if (!result.ok) return json(result.status, { error: result.error });
      return json(200, { id: result.id, status: result.status });
    }
    let allowed = false;
    try {
      allowed = await sessionOpen(request, deps);
    } catch {
      allowed = false;
    }
    if (!allowed) return json(401, { error: "unauthorized" });
    const id = decodeId(itemMatch[1] ?? "");
    if (!id) return json(404, { error: "not found" });
    try {
      const sql = await database(deps);
      await runDueQuiet(sql);
      return await withTransaction(sql, () =>
        transitionOutbound(sql, id, { status: "cancelled", providerMessageId: null, error: null }),
      );
    } catch (err) {
      console.error("[outbox] cancel failed", err instanceof Error ? err.name : "error");
      return json(503, { error: "unavailable" });
    }
  }

  return json(404, { error: "not found" });
}
