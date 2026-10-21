import { createHash, timingSafeEqual } from "node:crypto";
import type { Sql } from "../../lib/db.ts";
import { runWriteTx } from "../../lib/sql-tx.ts";
import type { Address, Alias, Attachment, Message } from "../../lib/mail/model.ts";
import { normalizePath } from "../../lib/site-gate/paths.ts";
import { runDueWakes } from "./wake.server.ts";
import {
  applySendResults,
  attachmentPathUnsafe,
  classifyIngestItem,
  fromJsonWithSignals,
  mergeLooseAttachment,
  readMailSignals,
  threadsFromMessages,
  type ClassifiedIngest,
  type IngestIdentity,
  type IngestLoad,
  type SendResult,
} from "./ingest.server.ts";
import {
  appSentKeys,
  bestSentCopy,
  copyKeys,
  dedupeSentCopies,
  fuzzySentDistance,
  isAppSentCopy,
  sentCopyMatch,
  type SentCopyCandidate,
} from "../../lib/mail/sent-copies.ts";

export const INGEST_MAX_ITEMS = 200;
export const INGEST_MAX_BYTES = 5 * 1024 * 1024;

const ACCOUNT_ID = "singleton";

export type IngestApiDeps = {
  /** When set, this object is the only token source. A blank value rejects every call. */
  env?: { INGEST_TOKEN?: string };
  sql?: Sql;
};

type StoredItem = Exclude<ClassifiedIngest, { ok: false } | { kind: "thread" }>;

function json(status: number, body: unknown, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function ingestToken(deps: IngestApiDeps): string | undefined {
  const raw = deps.env ? deps.env.INGEST_TOKEN : (process.env.GBM_INGEST_TOKEN?.trim() || process.env.INGEST_TOKEN);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Compare the bearer value to the configured token. Length is not leaked. */
export function ingestTokenMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

function providedBearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return "";
  return header.slice(prefix.length);
}

function authorize(request: Request, deps: IngestApiDeps): Response | null {
  const expected = ingestToken(deps);
  if (!expected) return json(503, { error: "unavailable" });
  if (!ingestTokenMatches(providedBearer(request), expected)) return json(401, { error: "unauthorized" });
  return null;
}

function asCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function textOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function boolValue(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true";
}

/** Open the app database only after auth. Tests inject `deps.sql` and never reach this. */
async function openDatabase(): Promise<Sql> {
  const { getSql } = await import("../../lib/db.ts");
  return getSql();
}

async function database(deps: IngestApiDeps): Promise<Sql> {
  return deps.sql ?? openDatabase();
}

async function upsertAccount(sql: Sql, identity: IngestIdentity, updatedAt: string): Promise<void> {
  await sql.query(
    `insert into mail_account (id, address, display_name, aliases_json, updated_at)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update set
       address = excluded.address,
       display_name = excluded.display_name,
       aliases_json = excluded.aliases_json,
       updated_at = excluded.updated_at`,
    [ACCOUNT_ID, identity.address, identity.displayName, JSON.stringify(identity.aliases), updatedAt],
  );
}

async function writeAttachments(
  sql: Sql,
  messageRef: string,
  attachments: Attachment[],
  content: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const safe = attachments.filter((file) => !attachmentPathUnsafe(file.path));
  const keep = new Set(safe.map((file) => file.id));
  const existing = await sql.query<{ id: string }>(`select id from mail_attachment where message_ref = $1`, [messageRef]);
  for (const row of existing) {
    if (!keep.has(String(row.id))) {
      await sql.query(`delete from mail_attachment where message_ref = $1 and id = $2`, [messageRef, row.id]);
    }
  }
  for (const file of safe) {
    const bytes = Number.isFinite(file.bytes) ? Math.max(0, Math.trunc(file.bytes)) : 0;
    const stored = content.get(file.id) ?? null;
    await sql.query(
      `insert into mail_attachment (id, message_ref, filename, mime, bytes, path, content_b64)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id, message_ref) do update set
         filename = excluded.filename,
         mime = excluded.mime,
         bytes = excluded.bytes,
         path = excluded.path,
         content_b64 = coalesce(excluded.content_b64, mail_attachment.content_b64)`,
      [file.id, messageRef, file.filename, file.mime, bytes, file.path, stored],
    );
  }
}

type TwinRow = SentCopyCandidate & {
  clientSendId: string | null;
  attachments: Attachment[];
  inReplyTo: string | null;
  references: string[];
};

type SentTwin = { kind: "copy-of-app"; row: TwinRow } | { kind: "app-of-copy"; row: TwinRow };

function placeholders(values: readonly unknown[], start: number): string {
  return values.map((_, index) => `$${index + start}`).join(", ");
}

/**
 * SQLite approximation of Postgres
 * `lower(regexp_replace(trim(subject), '\s+', ' ', 'g'))`: folds ASCII
 * whitespace to spaces, then collapses doubled spaces twice. A prefilter only
 * — the real twin ranking happens in `fuzzySentDistance` in JS.
 */
function sqliteSubjectNorm(): string {
  let expr = "trim(subject)";
  for (const code of [9, 10, 11, 12, 13]) {
    expr = `replace(${expr}, char(${code}), ' ')`;
  }
  return `lower(replace(replace(${expr}, '  ', ' '), '  ', ' '))`;
}

/**
 * The other copy of a sent email, when there is one: the app's own row for a
 * copy from the bot inbox, or the inbox copy for the app's row. Matched by
 * provider message id or Message-ID, then by from, to, subject, and a close time.
 */
async function findSentTwin(sql: Sql, message: Message): Promise<SentTwin | null> {
  const app = isAppSentCopy(message);
  if (!app && message.direction === "inbound") return null;
  const keys = app ? appSentKeys(message) : copyKeys(message);
  const idKeys = app ? keys : keys.map((item) => `msg_${item}`);
  const params: unknown[] = [message.id, message.subject.replace(/\s+/g, " ").trim().toLowerCase()];
  const sqlite = sql.dialect === "sqlite";
  const midNorm = sqlite
    ? "lower(trim(coalesce(message_id, ''), '<>'))"
    : "lower(trim(both '<>' from coalesce(message_id, '')))";
  const subjectNorm = sqlite
    ? sqliteSubjectNorm()
    : "lower(regexp_replace(trim(subject), '\\s+', ' ', 'g'))";
  const idList = idKeys.length > 0 ? `lower(id) in (${placeholders(idKeys, params.length + 1)})` : "false";
  params.push(...idKeys);
  const midList = keys.length > 0 ? `${midNorm} in (${placeholders(keys, params.length + 1)})` : "false";
  params.push(...keys);
  const side = app ? "client_send_id is null" : "client_send_id is not null";
  const rows = await sql.query<{
    id: string;
    message_id: string | null;
    client_send_id: string | null;
    from_json: string;
    to_json: string;
    subject: string;
    date: unknown;
    direction: string | null;
    in_reply_to: string | null;
    references_json: string;
    attachments_json: string;
  }>(
    `select id, message_id, client_send_id, from_json, to_json, subject, date, direction, in_reply_to, references_json,
            attachments_json
     from mail_message
     where id <> $1 and ${side}
       and (${idList} or ${midList} or ${subjectNorm} = $2)
     limit 50`,
    params,
  );
  const candidates: TwinRow[] = rows.map((row) => ({
    id: String(row.id),
    messageId: row.message_id,
    clientSendId: row.client_send_id,
    from: addressOf(readJson<unknown>(row.from_json)) ?? { name: "", email: "" },
    to: addressList(readJson<unknown>(row.to_json)),
    subject: row.subject ?? "",
    date: typeof row.date === "string" ? row.date : row.date instanceof Date ? row.date.toISOString() : "",
    direction: row.direction === "outbound" || row.direction === "inbound" ? row.direction : null,
    inReplyTo: row.in_reply_to,
    references: readJson<string[]>(row.references_json)?.filter((item) => typeof item === "string") ?? [],
    attachments: (readJson<Attachment[]>(row.attachments_json) ?? []).filter((file) => file && typeof file.filename === "string"),
  }));
  if (app) {
    const copy = bestSentCopy(message, candidates);
    return copy ? { kind: "app-of-copy", row: copy } : null;
  }
  let best: { row: TwinRow; rank: number } | null = null;
  for (const row of candidates) {
    const match = sentCopyMatch(row, message);
    if (match === "id") return { kind: "copy-of-app", row };
    if (match !== "fuzzy") continue;
    const rank = fuzzySentDistance(row, message) ?? Number.POSITIVE_INFINITY;
    if (!best || rank < best.rank) best = { row, rank };
  }
  return best ? { kind: "copy-of-app", row: best.row } : null;
}

/** Mark the stored inbox copy as this app send. Its headers and body stay as the inbox has them. */
async function linkSendToCopy(sql: Sql, copyId: string, app: Message): Promise<void> {
  await sql.query(
    `update mail_message set
       client_send_id = $2,
       direction = 'outbound',
       unread = false,
       thread_hint = coalesce(thread_hint, $3),
       in_reply_to = coalesce(in_reply_to, $4),
       references_json = case when references_json is null or references_json = '[]' then $5 else references_json end
     where id = $1`,
    [copyId, textOrNull(app.clientSendId), textOrNull(app.threadHint), textOrNull(app.inReplyTo), JSON.stringify(app.references)],
  );
}

export async function upsertMessage(
  sql: Sql,
  incoming: Message,
  unread: boolean,
  attachmentContent: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  let message = incoming;
  const messageId = textOrNull(message.messageId);
  const id = message.id;
  const matches = await sql.query<{ id: string }>(
    `select id from mail_message where id = $1 or message_id = $2`,
    [id, messageId],
  );
  const ids = matches.map((row) => String(row.id));
  let keep = ids.includes(id) ? id : (ids[0] ?? null);
  if (!keep) {
    const twin = await findSentTwin(sql, message);
    if (twin?.kind === "copy-of-app") {
      // The bot inbox copy of a send the app already stored: update that row in place.
      keep = twin.row.id;
      ids.push(twin.row.id);
      message = {
        ...message,
        clientSendId: message.clientSendId ?? twin.row.clientSendId,
        inReplyTo: message.inReplyTo ?? twin.row.inReplyTo,
        references: message.references.length > 0 ? message.references : twin.row.references,
        attachments: message.attachments.length > 0 ? message.attachments : twin.row.attachments,
        direction: message.direction ?? "outbound",
      };
    } else if (twin?.kind === "app-of-copy") {
      // The inbox copy came first. Link the app's send to it instead of storing a second copy.
      await linkSendToCopy(sql, twin.row.id, message);
      return;
    }
  }
  let stored = message;
  if (keep && (!stored.listUnsubscribe || !stored.autoSubmitted)) {
    const prior = await sql.query<{ from_json: string }>(`select from_json from mail_message where id = $1`, [keep]);
    const previous = readMailSignals(readJson<unknown>(prior[0]?.from_json ?? ""));
    if (!stored.listUnsubscribe && previous.listUnsubscribe) stored = { ...stored, listUnsubscribe: previous.listUnsubscribe };
    if (!stored.autoSubmitted && previous.autoSubmitted) stored = { ...stored, autoSubmitted: previous.autoSubmitted };
  }
  const safeAttachments = stored.attachments.filter((file) => !attachmentPathUnsafe(file.path));
  const content = [
    messageId,
    textOrNull(message.inReplyTo),
    JSON.stringify(message.references),
    textOrNull(message.deliveredTo),
    message.account || "primary",
    fromJsonWithSignals(stored),
    JSON.stringify(message.to),
    JSON.stringify(message.cc),
    JSON.stringify(message.bcc),
    message.subject,
    message.body,
    message.date || new Date(0).toISOString(),
  ];
  const tail = [
    JSON.stringify(safeAttachments),
    textOrNull(message.clientSendId),
    textOrNull(message.threadHint),
    message.direction ?? null,
    message.html ?? null,
  ];
  if (keep) {
    for (const extra of ids) {
      if (extra === keep) continue;
      await sql.query(
        `delete from mail_attachment where message_ref = $2 and id in (select id from mail_attachment where message_ref = $1)`,
        [keep, extra],
      );
      await sql.query(`update mail_attachment set message_ref = $1 where message_ref = $2`, [keep, extra]);
      await sql.query(`delete from mail_message where id = $1`, [extra]);
    }
    // Content updates. A missing threadHint, direction, html, List-Unsubscribe,
    // or Auto-Submitted keeps the stored value. unread stays as the row already
    // has it. Star, snooze, labels, folder, and trash live on mail_thread_state.
    await sql.query(
      `update mail_message set
         message_id = $2,
         in_reply_to = $3,
         references_json = $4,
         delivered_to = $5,
         account = $6,
         from_json = $7,
         to_json = $8,
         cc_json = $9,
         bcc_json = $10,
         subject = $11,
         body = $12,
         date = $13,
         attachments_json = $14,
         client_send_id = coalesce($15, client_send_id),
         thread_hint = coalesce($16, thread_hint),
         direction = coalesce($17, direction),
         html_body = coalesce($18, html_body)
       where id = $1`,
      [keep, ...content, ...tail],
    );
    await writeAttachments(sql, keep, safeAttachments, attachmentContent);
    return;
  }
  await sql.query(
    `insert into mail_message (
       id, message_id, in_reply_to, references_json, delivered_to, account,
       from_json, to_json, cc_json, bcc_json, subject, body, date, unread,
       attachments_json, client_send_id, thread_hint, direction, html_body
     ) values (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19
     )`,
    [id, ...content, unread, ...tail],
  );
  await writeAttachments(sql, id, safeAttachments, attachmentContent);
}

async function upsertSendResult(sql: Sql, result: SendResult): Promise<void> {
  await sql.query(
    `insert into mail_send_result (client_send_id, status, reply_to_message_id, sent_message_id, error)
     values ($1, $2, $3, $4, $5)
     on conflict (client_send_id) do update set
       status = excluded.status,
       reply_to_message_id = excluded.reply_to_message_id,
       sent_message_id = excluded.sent_message_id,
       error = excluded.error`,
    [
      result.clientSendId,
      result.status,
      result.replyToMessageId,
      result.sentMessageId,
      result.error,
    ],
  );
}

async function applyItems(sql: Sql, items: StoredItem[]): Promise<{ accepted: number; skipped: number }> {
  const updatedAt = new Date().toISOString();
  const accepted = await runWriteTx(sql, async () => {
    let count = 0;
    for (const item of items) {
      if (item.kind === "account") await upsertAccount(sql, item.identity, updatedAt);
      else if (item.kind === "message") await upsertMessage(sql, item.message, item.unread, item.attachmentContent);
      else if (item.kind === "attachment") {
        const bytes = Number.isFinite(item.attachment.bytes) ? Math.max(0, Math.trunc(item.attachment.bytes)) : 0;
        const messageRef = item.messageId ?? "";
        await sql.query(
          `insert into mail_attachment (id, message_ref, filename, mime, bytes, path, content_b64)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (id, message_ref) do update set
             filename = excluded.filename,
             mime = excluded.mime,
             bytes = excluded.bytes,
             path = excluded.path,
             content_b64 = coalesce(excluded.content_b64, mail_attachment.content_b64)`,
          [item.attachment.id, messageRef, item.attachment.filename, item.attachment.mime, bytes, item.attachment.path, item.contentB64],
        );
      } else {
        await upsertSendResult(sql, item.result);
        const { applySendResultToOutbound } = await import("./outbox-api.server.ts");
        await applySendResultToOutbound(sql, item.result);
      }
      count += 1;
    }
    return count;
  });
  return { accepted, skipped: 0 };
}

async function readState(sql: Sql): Promise<{ newest: string | null; counts: { messages: number; attachments: number; accounts: number; sendResults: number } }> {
  const counts = await sql.query<{
    messages: unknown;
    attachments: unknown;
    accounts: unknown;
    send_results: unknown;
  }>(
    `select
       (select count(*) from mail_message) as messages,
       (select count(*) from mail_attachment) as attachments,
       (select count(*) from mail_account) as accounts,
       (select count(*) from mail_send_result) as send_results`,
  );
  const row = counts[0];
  const dates = await sql.query<{ date: unknown }>(`select date from mail_message`);
  let newest: string | null = null;
  let best = Number.NEGATIVE_INFINITY;
  for (const item of dates) {
    const raw = typeof item.date === "string" ? item.date : item.date instanceof Date ? item.date.toISOString() : "";
    const ms = Date.parse(raw);
    if (!raw || Number.isNaN(ms) || ms < best) continue;
    best = ms;
    newest = raw;
  }
  return {
    newest,
    counts: {
      messages: asCount(row?.messages),
      attachments: asCount(row?.attachments),
      accounts: asCount(row?.accounts),
      sendResults: asCount(row?.send_results),
    },
  };
}

function addressOf(value: unknown): Address | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<Address>;
  if (typeof row.email !== "string" || !row.email.includes("@")) return null;
  return { name: typeof row.name === "string" && row.name ? row.name : row.email.split("@")[0] || row.email, email: row.email };
}

function addressList(value: unknown): Address[] {
  if (!Array.isArray(value)) return [];
  return value.map(addressOf).filter((item): item is Address => item !== null);
}

/** Messages, loose attachment metadata, and send results currently stored. */
export async function loadStoredIngest(sql?: Sql): Promise<IngestLoad> {
  const db = sql ?? (await openDatabase());
  const accounts = await db.query<{ address: string; display_name: string; aliases_json: string }>(
    `select address, display_name, aliases_json from mail_account where id = $1`,
    [ACCOUNT_ID],
  );
  let identity: IngestIdentity | null = null;
  const account = accounts[0];
  if (account?.address?.includes("@")) {
    const aliases = readJson<Alias[]>(account.aliases_json) ?? [];
    identity = {
      address: account.address,
      displayName: account.display_name || account.address.split("@")[0] || "You",
      aliases: Array.isArray(aliases) ? aliases.filter((alias) => alias && typeof alias.email === "string" && alias.email.includes("@")) : [],
    };
  }
  const rows = await db.query<{
    id: string;
    message_id: string | null;
    in_reply_to: string | null;
    references_json: string;
    delivered_to: string | null;
    account: string;
    from_json: string;
    to_json: string;
    cc_json: string;
    bcc_json: string;
    subject: string;
    body: string;
    date: string;
    unread: unknown;
    attachments_json: string;
    client_send_id: string | null;
    thread_hint: string | null;
    direction: string | null;
    html_body: string | null;
  }>(
    `select id, message_id, in_reply_to, references_json, delivered_to, account, from_json, to_json, cc_json, bcc_json,
            subject, body, date, unread, attachments_json, client_send_id, thread_hint, direction, html_body
     from mail_message`,
  );
  const messages: Message[] = [];
  const unread = new Map<string, boolean>();
  for (const row of rows) {
    const rawFrom = readJson<unknown>(row.from_json);
    const from = addressOf(rawFrom);
    if (!from) continue;
    const signals = readMailSignals(rawFrom);
    const attachments = readJson<Attachment[]>(row.attachments_json) ?? [];
    const message: Message = {
      id: row.id,
      messageId: row.message_id,
      inReplyTo: row.in_reply_to,
      references: readJson<string[]>(row.references_json)?.filter((item) => typeof item === "string") ?? [],
      deliveredTo: row.delivered_to,
      account: row.account || "primary",
      from,
      to: addressList(readJson<unknown>(row.to_json)),
      cc: addressList(readJson<unknown>(row.cc_json)),
      bcc: addressList(readJson<unknown>(row.bcc_json)),
      subject: row.subject ?? "",
      body: row.body ?? "",
      html: typeof row.html_body === "string" && row.html_body.trim() ? row.html_body : null,
      date: typeof row.date === "string" ? row.date : new Date(0).toISOString(),
      attachments: Array.isArray(attachments)
        ? attachments.filter((file) => file && typeof file.filename === "string" && !attachmentPathUnsafe(file.path ?? ""))
        : [],
      delivery: null,
      clientSendId: row.client_send_id,
      threadHint: row.thread_hint,
      direction: row.direction === "outbound" || row.direction === "inbound" ? row.direction : null,
    };
    if (signals.listUnsubscribe) message.listUnsubscribe = signals.listUnsubscribe;
    if (signals.autoSubmitted) message.autoSubmitted = signals.autoSubmitted;
    messages.push(message);
    unread.set(message.id, boolValue(row.unread));
  }
  const loose = await db.query<{
    id: string;
    message_ref: string;
    filename: string;
    mime: string;
    bytes: unknown;
    path: string;
  }>(`select id, message_ref, filename, mime, bytes, path from mail_attachment`);
  for (const file of loose) {
    if (attachmentPathUnsafe(file.path ?? "")) continue;
    mergeLooseAttachment(
      messages,
      {
        id: file.id,
        filename: file.filename,
        mime: file.mime || "application/octet-stream",
        bytes: asCount(file.bytes),
        path: file.path ?? "",
      },
      file.message_ref || null,
    );
  }
  const results = await db.query<{
    client_send_id: string;
    status: string;
    reply_to_message_id: string | null;
    sent_message_id: string | null;
    error: string | null;
  }>(`select client_send_id, status, reply_to_message_id, sent_message_id, error from mail_send_result`);
  const sendResults: SendResult[] = results.map((row) => ({
    clientSendId: row.client_send_id,
    status: row.status,
    replyToMessageId: row.reply_to_message_id,
    sentMessageId: row.sent_message_id,
    error: row.error,
  }));
  // Rows stored before ingest linked sent copies can still hold both copies of one send.
  const folded = dedupeSentCopies(messages).messages;
  const withResults = applySendResults(folded, sendResults);
  return {
    identity,
    messages: withResults,
    sendResults,
    threads: threadsFromMessages(withResults, unread, identity?.address),
  };
}

/**
 * Bearer ingest API. The cookie gate does not cover these paths.
 * Bodies and the token are never logged.
 */
export async function handleIngestApi(request: Request, deps: IngestApiDeps = {}): Promise<Response> {
  const path = normalizePath(new URL(request.url).pathname);
  const method = request.method.toUpperCase();
  const denied = authorize(request, deps);
  if (denied) return denied;
  try {
    await runDueWakes(await database(deps));
  } catch {
    // A due wake must not fail ingest.
  }
  if (path !== "/api/ingest" && path !== "/api/ingest/state") return json(404, { error: "not found" });

  if (path === "/api/ingest/state") {
    if (method !== "GET") return json(405, { error: "method" }, { allow: "GET" });
    try {
      return json(200, await readState(await database(deps)));
    } catch (err) {
      console.error("[ingest] state failed", err instanceof Error ? err.name : "error");
      return json(503, { error: "unavailable" });
    }
  }

  if (method !== "POST") return json(405, { error: "method" }, { allow: "POST" });

  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > INGEST_MAX_BYTES) return json(413, { error: "too large" });

  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch (err) {
    console.error("[ingest] read failed", err instanceof Error ? err.name : "error");
    return json(400, { error: "invalid" });
  }
  if (bytes.byteLength > INGEST_MAX_BYTES) return json(413, { error: "too large" });

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return json(400, { error: "invalid" });
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { items?: unknown }) : null;
  if (!record || !Array.isArray(record.items)) return json(400, { error: "invalid" });
  if (record.items.length > INGEST_MAX_ITEMS) return json(413, { error: "too large" });

  let skipped = 0;
  const pending: StoredItem[] = [];
  for (const item of record.items) {
    const classified = classifyIngestItem(item);
    if (!classified.ok || classified.kind === "thread") {
      skipped += 1;
      continue;
    }
    if (classified.kind === "attachment" && attachmentPathUnsafe(classified.attachment.path)) {
      skipped += 1;
      continue;
    }
    pending.push(classified);
  }
  if (pending.length === 0) return json(200, { accepted: 0, skipped });

  try {
    const wrote = await applyItems(await database(deps), pending);
    return json(200, { accepted: wrote.accepted, skipped });
  } catch (err) {
    console.error("[ingest] write failed", err instanceof Error ? err.name : "error");
    return json(503, { error: "unavailable" });
  }
}
