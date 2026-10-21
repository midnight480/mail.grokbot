import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import {
  PasswordStoreUnavailable,
  databaseConfigured,
  sessionVersionFromEnv,
} from "./env-security.ts";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  changePassword,
  checkPassword,
  createRateLimiter,
  handleGate,
  hashPassword,
  safeEqual,
  signSession,
  verifySession,
  type GateDeps,
  type SecurityState,
} from "./gate.ts";
import { handleSiteRequest } from "./handle.server.ts";
import { resetDemoMailbox } from "../../server/mail/demo-state.server.ts";
import { localhostGateOpen } from "./localhost-gate.ts";
import { GATE_COPY } from "./messages.ts";
import { LOGIN_NEXT_FIELD, LOGIN_PASSWORD_FIELD } from "./paths.ts";
import { loadSecurity, passwordChangesEnabled, savePasswordHash } from "./store.server.ts";

const SECRET = "test-session-secret";
const APP_PASSWORD = "env-password";
const NOW = 1_700_000_000_000;

function memoryDeps(
  initial: SecurityState = { passwordHash: null, sessionVersion: 0 },
): GateDeps & {
  read: () => SecurityState;
} {
  let state = initial;
  return {
    now: () => NOW,
    appPassword: APP_PASSWORD,
    sessionSecret: SECRET,
    getSecurity: async () => state,
    savePassword: async (passwordHash) => {
      state = { passwordHash, sessionVersion: state.sessionVersion + 1 };
      return state;
    },
    rateLimit: createRateLimiter({ limit: 5, windowMs: 60_000 }),
    read: () => state,
  };
}

function loginRequest(password: string, next?: string): Request {
  const body = new URLSearchParams({ password });
  if (next) body.set("next", next);
  return new Request("https://mail.example/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": "203.0.113.8",
    },
    body,
  });
}

function get(path: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new Request(`https://mail.example${path}`, { method: "GET", headers });
}

function tokenFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`^${SESSION_COOKIE}=([^;]+)`));
  assert.ok(match, header);
  return match[1] ?? "";
}

describe("site gate", () => {
  it("blocks a route and a server function when the cookie is missing", async () => {
    const deps = memoryDeps();
    const page = await handleGate(
      get("/"),
      { pathname: "/", handlerType: "router", dev: false },
      deps,
    );
    assert.ok(page);
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/login?next=%2F");
    assert.equal(page.headers.get("set-cookie"), null);

    const fn = await handleGate(
      new Request("https://mail.example/_serverFn/fetchPublicMailConfig", { method: "POST" }),
      { pathname: "/_serverFn/fetchPublicMailConfig", handlerType: "serverFn", dev: false },
      deps,
    );
    assert.ok(fn);
    assert.equal(fn.status, 401);
    assert.equal(fn.headers.get("set-cookie"), null);
  });

  it("rejects the wrong password and does not set a cookie", async () => {
    const deps = memoryDeps();
    const password = "not-the-password";
    const response = await handleGate(
      loginRequest(password),
      { pathname: "/login", handlerType: "router", dev: false },
      deps,
    );
    assert.ok(response);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/login?e=wrong");
    assert.equal(response.headers.get("set-cookie"), null);
    const location = response.headers.get("location") ?? "";
    assert.equal(location.includes(password), false);
    assert.equal((await response.text()).includes(password), false);
  });

  it("sets an HttpOnly Secure SameSite=Lax cookie for the right password", async () => {
    const deps = memoryDeps();
    const response = await handleGate(
      loginRequest(APP_PASSWORD, "/inbox"),
      { pathname: "/login", handlerType: "router", dev: false },
      deps,
    );
    assert.ok(response);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/inbox");
    const header = response.headers.get("set-cookie") ?? "";
    assert.match(header, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, new RegExp(`Max-Age=${SESSION_MAX_AGE}`));
    assert.equal(header.includes(APP_PASSWORD), false);

    const claims = verifySession(tokenFrom(response), SECRET, NOW);
    assert.deepEqual(claims, { v: 0, exp: NOW + SESSION_MAX_AGE * 1000 });

    const allowed = await handleGate(
      get("/", `${SESSION_COOKIE}=${tokenFrom(response)}`),
      { pathname: "/", handlerType: "router", dev: false },
      deps,
    );
    assert.equal(allowed, null);
  });

  it("keeps a deep link across the login redirect and rejects an off-site next", async () => {
    const deps = memoryDeps();
    const ctx = { handlerType: "router" as const, dev: false };
    const message = await handleGate(
      get("/m/msg_859543"),
      { ...ctx, pathname: "/m/msg_859543" },
      deps,
    );
    assert.equal(message?.status, 302);
    assert.equal(message?.headers.get("location"), "/login?next=%2Fm%2Fmsg_859543");
    const thread = await handleGate(
      get("/t/thr_a_example_test"),
      { ...ctx, pathname: "/t/thr_a_example_test" },
      deps,
    );
    assert.equal(thread?.status, 302);
    assert.equal(thread?.headers.get("location"), "/login?next=%2Ft%2Fthr_a_example_test");
    const queued = await handleGate(get("/o/send_1"), { ...ctx, pathname: "/o/send_1" }, deps);
    assert.equal(queued?.status, 302);
    assert.equal(queued?.headers.get("location"), "/login?next=%2Fo%2Fsend_1");

    const wrong = await handleGate(
      loginRequest("not-the-password", "/m/msg_859543"),
      { ...ctx, pathname: "/login" },
      deps,
    );
    assert.equal(wrong?.status, 303);
    assert.equal(wrong?.headers.get("location"), "/login?e=wrong&next=%2Fm%2Fmsg_859543");
    assert.equal(wrong?.headers.get("set-cookie"), null);

    const signedIn = await handleGate(
      loginRequest(APP_PASSWORD, "/m/msg_859543"),
      { ...ctx, pathname: "/login" },
      deps,
    );
    assert.equal(signedIn?.status, 303);
    assert.equal(signedIn?.headers.get("location"), "/m/msg_859543");
    const cookie = `${SESSION_COOKIE}=${tokenFrom(signedIn!)}`;
    const opened = await handleGate(
      get("/m/msg_859543", cookie),
      { ...ctx, pathname: "/m/msg_859543" },
      deps,
    );
    assert.equal(opened, null);
    const openedOutbox = await handleGate(
      get("/o/send_1", cookie),
      { ...ctx, pathname: "/o/send_1" },
      deps,
    );
    assert.equal(openedOutbox, null);
    const already = await handleGate(
      get("/login?next=%2Ft%2Fthr_a_example_test", cookie),
      { ...ctx, pathname: "/login" },
      deps,
    );
    assert.equal(already?.status, 302);
    assert.equal(already?.headers.get("location"), "/t/thr_a_example_test");

    for (const next of [
      "https://evil.example/phish",
      "//evil.example",
      "/\\evil.example",
      "/login",
    ]) {
      const response = await handleGate(
        loginRequest(APP_PASSWORD, next),
        { ...ctx, pathname: "/login" },
        deps,
      );
      assert.equal(response?.headers.get("location"), "/", next);
    }
  });

  it("accepts a changed password, rejects the old one, and drops old cookies", async () => {
    const deps = memoryDeps();
    const first = await handleGate(
      loginRequest(APP_PASSWORD),
      { pathname: "/login", handlerType: "router", dev: false },
      deps,
    );
    assert.ok(first);
    const oldToken = tokenFrom(first);

    const nextPassword = "new-password-10";
    const changed = await changePassword(
      { current: APP_PASSWORD, next: nextPassword, ip: "203.0.113.8" },
      deps,
    );
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.equal(deps.read().sessionVersion, 1);
    assert.ok(deps.read().passwordHash);
    const stored = await checkPassword(nextPassword, deps.read(), APP_PASSWORD);
    assert.equal(stored, "match");
    const previous = await checkPassword(APP_PASSWORD, deps.read(), APP_PASSWORD);
    assert.equal(previous, "miss");

    const oldLogin = await handleGate(
      loginRequest(APP_PASSWORD),
      { pathname: "/login", handlerType: "router", dev: false },
      deps,
    );
    assert.ok(oldLogin);
    assert.equal(oldLogin.headers.get("location"), "/login?e=wrong");
    assert.equal(oldLogin.headers.get("set-cookie"), null);

    const newLogin = await handleGate(
      loginRequest(nextPassword),
      { pathname: "/login", handlerType: "router", dev: false },
      deps,
    );
    assert.ok(newLogin);
    const newToken = tokenFrom(newLogin);
    assert.equal(verifySession(newToken, SECRET, NOW)?.v, 1);
    assert.equal(newLogin.headers.get("set-cookie")?.includes(nextPassword), false);

    const stale = await handleGate(
      get("/", `${SESSION_COOKIE}=${oldToken}`),
      { pathname: "/", handlerType: "router", dev: false },
      deps,
    );
    assert.ok(stale);
    assert.equal(stale.status, 302);

    const fresh = await handleGate(
      get("/", `${SESSION_COOKIE}=${newToken}`),
      { pathname: "/_serverFn/bridgeSync", handlerType: "serverFn", dev: false },
      deps,
    );
    assert.equal(fresh, null);

    const issued = verifySession(changed.token, SECRET, NOW);
    assert.equal(issued?.v, 1);
  });

  it("refuses a new password shorter than 10 characters and keeps the old one", async () => {
    const deps = memoryDeps();
    const result = await changePassword(
      { current: APP_PASSWORD, next: "short", ip: "203.0.113.9" },
      deps,
    );
    assert.deepEqual(result, { ok: false, error: GATE_COPY.tooShort });
    assert.equal(deps.read().passwordHash, null);
    assert.equal(deps.read().sessionVersion, 0);
  });

  it("rate-limits repeated failures for one IP", async () => {
    const deps = memoryDeps();
    deps.rateLimit = createRateLimiter({ limit: 2, windowMs: 60_000 });
    const ctx = { pathname: "/login", handlerType: "router" as const, dev: false };
    const first = await handleGate(loginRequest("nope-1"), ctx, deps);
    const second = await handleGate(loginRequest("nope-2"), ctx, deps);
    const blocked = await handleGate(loginRequest(APP_PASSWORD), ctx, deps);
    assert.equal(first?.headers.get("location"), "/login?e=wrong");
    assert.equal(second?.headers.get("location"), "/login?e=wrong");
    assert.equal(blocked?.status, 303);
    assert.equal(blocked?.headers.get("location"), "/login?e=rate");
    assert.equal(blocked?.headers.get("set-cookie"), null);
  });

  it("rejects a tampered or expired cookie", async () => {
    const deps = memoryDeps();
    const token = signSession({ v: 0, exp: NOW + 1000 }, SECRET);
    const tampered = `${token.slice(0, -2)}aa`;
    const bad = await handleGate(
      get("/", `${SESSION_COOKIE}=${tampered}`),
      { pathname: "/", handlerType: "router", dev: false },
      deps,
    );
    assert.equal(bad?.status, 302);

    const expired = signSession({ v: 0, exp: NOW - 1 }, SECRET);
    assert.equal(verifySession(expired, SECRET, NOW), null);
  });

  it("leaves /login and static assets open, and keeps source paths gated in production", async () => {
    const deps = memoryDeps();
    const login = await handleGate(
      get("/login"),
      { pathname: "/login", handlerType: "router", dev: false },
      deps,
    );
    assert.equal(login, null);
    const icon = await handleGate(
      get("/favicon.svg"),
      { pathname: "/favicon.svg", handlerType: "router", dev: false },
      deps,
    );
    assert.equal(icon, null);
    const source = await handleGate(
      get("/src/routes/index.tsx"),
      { pathname: "/src/routes/index.tsx", handlerType: "router", dev: false },
      deps,
    );
    assert.equal(source?.status, 302);
    const devSource = await handleGate(
      get("/src/routes/login.tsx"),
      { pathname: "/src/routes/login.tsx", handlerType: "router", dev: true },
      deps,
    );
    assert.equal(devSource, null);
  });

  it("exempts only /api/ingest from the cookie gate", async () => {
    const deps = memoryDeps();
    const ctx = { handlerType: "router" as const, dev: false };
    assert.equal(
      await handleGate(get("/api/ingest"), { ...ctx, pathname: "/api/ingest" }, deps),
      null,
    );
    assert.equal(
      await handleGate(get("/api/ingest/state"), { ...ctx, pathname: "/api/ingest/state" }, deps),
      null,
    );
    assert.equal(
      await handleGate(get("/api/ingest/other"), { ...ctx, pathname: "/api/ingest/other" }, deps),
      null,
    );
    const other = await handleGate(get("/api/other"), { ...ctx, pathname: "/api/other" }, deps);
    assert.equal(other?.status, 302);
    const mail = await handleGate(get("/api/mail"), { ...ctx, pathname: "/api/mail" }, deps);
    assert.equal(mail?.status, 302);
    const fn = await handleGate(
      get("/api/ingest"),
      { pathname: "/api/ingest", handlerType: "serverFn", dev: false },
      deps,
    );
    assert.equal(fn?.status, 401);
  });

  it("compares unequal strings without throwing", () => {
    assert.equal(safeEqual("a", "ab"), false);
    assert.equal(safeEqual("same", "same"), true);
    assert.equal(safeEqual("", "x"), false);
  });

  it("stores a hash that does not contain the password", async () => {
    const password = "a-brand-new-password";
    const hash = await hashPassword(password);
    assert.equal(hash.startsWith("scrypt$"), true);
    assert.equal(hash.includes(password), false);
    assert.equal(
      await checkPassword(password, { passwordHash: hash, sessionVersion: 1 }, "other"),
      "match",
    );
    assert.equal(
      await checkPassword("other", { passwordHash: hash, sessionVersion: 1 }, "other"),
      "miss",
    );
  });

  it("posts the password field name the server reads", () => {
    const source = readFileSync(new URL("../../routes/login.tsx", import.meta.url), "utf8");
    assert.match(source, /name=\{LOGIN_PASSWORD_FIELD\}/);
    assert.match(source, /name=\{LOGIN_NEXT_FIELD\}/);
    assert.equal(LOGIN_PASSWORD_FIELD, "password");
    assert.equal(LOGIN_NEXT_FIELD, "next");
    const settings = readFileSync(
      new URL("../../components/mail/overlays.tsx", import.meta.url),
      "utf8",
    );
    assert.match(settings, /GATE_COPY\.needsDatabase/);
  });

  it("signs in with APP_PASSWORD when the store throws, and does not throw", async () => {
    const deps = memoryDeps();
    deps.getSecurity = async () => {
      throw new Error("store down");
    };
    const response = await handleGate(
      loginRequest(APP_PASSWORD, "/"),
      { pathname: "/login", handlerType: "router", dev: false },
      deps,
    );
    assert.ok(response);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    assert.notEqual(response.status, 503);
    assert.equal(verifySession(tokenFrom(response), SECRET, NOW)?.v, 1);

    const bare = new Request("https://mail.example/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "203.0.113.77",
      },
      body: new URLSearchParams({ next: "/" }),
    });
    const empty = await handleGate(
      bare,
      { pathname: "/login", handlerType: "router", dev: false },
      deps,
    );
    assert.ok(empty);
    assert.equal(empty.status, 303);
    assert.equal(empty.headers.get("location"), "/login?e=wrong&next=%2F");
    assert.equal(empty.headers.get("set-cookie"), null);

    const home = await handleGate(
      get("/"),
      { pathname: "/", handlerType: "router", dev: false },
      deps,
    );
    assert.equal(home?.status, 302);
    assert.equal(home?.headers.get("location"), "/login?next=%2F");
  });

  it("uses the fallback session version when the store throws", async () => {
    const deps = memoryDeps();
    deps.fallbackVersion = 2;
    deps.getSecurity = async () => {
      throw new Error("store down");
    };
    const response = await handleGate(
      loginRequest(APP_PASSWORD),
      { pathname: "/login", handlerType: "router", dev: false },
      deps,
    );
    assert.ok(response);
    assert.equal(verifySession(tokenFrom(response), SECRET, NOW)?.v, 2);
  });

  it("returns the database message when a password change cannot be stored", async () => {
    const deps = memoryDeps();
    deps.savePassword = async () => {
      throw new PasswordStoreUnavailable();
    };
    const result = await changePassword(
      { current: APP_PASSWORD, next: "new-password-10", ip: "203.0.113.41" },
      deps,
    );
    assert.deepEqual(result, { ok: false, error: GATE_COPY.needsDatabase });
    assert.equal(deps.read().passwordHash, null);
  });
});

describe("site gate without a database", () => {
  const envKeys = [
    "DATABASE_URL",
    "SESSION_VERSION",
    "APP_PASSWORD",
    "SESSION_SECRET",
    "INGEST_TOKEN",
    "NODE_ENV",
    "MAIL_LOCALHOST_GATE",
    "GBM_DEMO",
    "GBM_SITE_PASSWORD",
  ] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
    (typeof envKeys)[number],
    string | undefined
  >;

  function restoreEnv(): void {
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  afterEach(() => {
    restoreEnv();
  });

  function pgliteStarted(): boolean {
    const marker = globalThis as typeof globalThis & {
      __pgliteInstance__?: unknown;
      __pgBootstrapPromise__?: unknown;
      __pgSqlPromise__?: unknown;
    };
    return (
      marker.__pgliteInstance__ !== undefined ||
      marker.__pgBootstrapPromise__ !== undefined ||
      marker.__pgSqlPromise__ !== undefined
    );
  }

  it("parses SESSION_VERSION and treats a blank DATABASE_URL as unset", () => {
    assert.equal(sessionVersionFromEnv(undefined), 1);
    assert.equal(sessionVersionFromEnv(""), 1);
    assert.equal(sessionVersionFromEnv("  "), 1);
    assert.equal(sessionVersionFromEnv("nope"), 1);
    assert.equal(sessionVersionFromEnv("-1"), 1);
    assert.equal(sessionVersionFromEnv("1.5"), 1);
    assert.equal(sessionVersionFromEnv("0"), 0);
    assert.equal(sessionVersionFromEnv("4"), 4);
    assert.equal(sessionVersionFromEnv(" 7 "), 7);
    assert.equal(databaseConfigured(undefined), false);
    assert.equal(databaseConfigured(""), false);
    assert.equal(databaseConfigured("   "), false);
    assert.equal(databaseConfigured("postgres://db.example/mail"), true);
    assert.equal(
      GATE_COPY.needsDatabase,
      "Connect a database to change your password here, or have your bot update APP_PASSWORD",
    );
  });

  it("signs in with APP_PASSWORD and does not open a database or return 503", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.SESSION_VERSION;
    process.env.APP_PASSWORD = APP_PASSWORD;
    process.env.SESSION_SECRET = SECRET;
    assert.equal(pgliteStarted(), false);

    const home = await handleSiteRequest({
      request: get("/"),
      pathname: "/",
      handlerType: "router",
    });
    assert.equal(home?.status, 302);
    assert.equal(home?.headers.get("location"), "/login?next=%2F");

    assert.equal(passwordChangesEnabled(), false);
    assert.deepEqual(await loadSecurity(), { passwordHash: null, sessionVersion: 1 });
    await assert.rejects(savePasswordHash("not-a-stored-hash"), PasswordStoreUnavailable);
    assert.equal(pgliteStarted(), false);

    const response = await handleSiteRequest({
      request: loginRequest(APP_PASSWORD, "/inbox"),
      pathname: "/login",
      handlerType: "router",
    });
    assert.ok(response);
    assert.equal(response.status, 303);
    assert.notEqual(response.status, 503);
    assert.equal(response.headers.get("location"), "/inbox");
    assert.notEqual(await response.text(), "Unavailable");
    const token = tokenFrom(response);
    assert.equal(verifySession(token, SECRET, Date.now())?.v, 1);

    const allowed = await handleSiteRequest({
      request: get("/", `${SESSION_COOKIE}=${token}`),
      pathname: "/",
      handlerType: "router",
    });
    assert.equal(allowed, null);

    const bare = new Request("https://mail.example/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "203.0.113.90",
      },
      body: new URLSearchParams({ [LOGIN_NEXT_FIELD]: "/" }),
    });
    const empty = await handleSiteRequest({
      request: bare,
      pathname: "/login",
      handlerType: "router",
    });
    assert.ok(empty);
    assert.equal(empty.status, 303);
    assert.equal(empty.headers.get("location"), "/login?e=wrong&next=%2F");
    assert.equal(empty.headers.get("set-cookie"), null);
    assert.equal(pgliteStarted(), false);
  });

  it("uses SESSION_VERSION for the cookie when DATABASE_URL is whitespace", async () => {
    process.env.DATABASE_URL = "   ";
    process.env.SESSION_VERSION = "4";
    process.env.APP_PASSWORD = APP_PASSWORD;
    process.env.SESSION_SECRET = SECRET;

    assert.equal(passwordChangesEnabled(), false);
    assert.deepEqual(await loadSecurity(), { passwordHash: null, sessionVersion: 4 });

    const response = await handleSiteRequest({
      request: loginRequest(APP_PASSWORD, "/"),
      pathname: "/login",
      handlerType: "router",
    });
    assert.ok(response);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    assert.equal(verifySession(tokenFrom(response), SECRET, Date.now())?.v, 4);
    assert.equal(pgliteStarted(), false);
  });

  it("uses the app database client and skips PGLite when DATABASE_URL is set", () => {
    const store = readFileSync(new URL("./store.server.ts", import.meta.url), "utf8");
    const db = readFileSync(new URL("../db.ts", import.meta.url), "utf8");
    const settings = readFileSync(
      new URL("../../components/mail/overlays.tsx", import.meta.url),
      "utf8",
    );
    assert.match(store, /await import\("\.\.\/db\.ts"\)/);
    assert.doesNotMatch(store, /pglite|PGlite|@electric-sql\/pglite/);
    assert.match(db, /if \(dbSource === "neon"\) return createNeonSql\(\)/);
    assert.match(db, /return createPgliteSql\(\)/);
    assert.match(db, /neonPoolConfig\(/);
    assert.match(settings, /editable === true/);
    assert.match(settings, /Change password/);
    process.env.DATABASE_URL = "postgres://db.example/mail";
    assert.equal(passwordChangesEnabled(), true);
    assert.equal(pgliteStarted(), false);
  });

  it("keeps the password gate in production, including loopback with the dev flag", async () => {
    assert.equal(
      localhostGateOpen({
        nodeEnv: "production",
        flag: "open",
        urlHost: "127.0.0.1",
        headerHost: "127.0.0.1",
      }),
      false,
    );
    assert.equal(
      localhostGateOpen({
        nodeEnv: "production",
        flag: "open",
        urlHost: "localhost",
        headerHost: null,
      }),
      false,
    );
    assert.equal(
      localhostGateOpen({
        nodeEnv: "development",
        flag: "open",
        urlHost: "127.0.0.1:9",
        headerHost: "127.0.0.1:9",
      }),
      true,
    );
    assert.equal(
      localhostGateOpen({
        nodeEnv: "development",
        flag: "open",
        urlHost: "mail.example",
        headerHost: "127.0.0.1",
      }),
      false,
    );
    assert.equal(
      localhostGateOpen({
        nodeEnv: "development",
        flag: "open",
        urlHost: "127.0.0.1",
        headerHost: "mail.example",
      }),
      false,
    );
    assert.equal(
      localhostGateOpen({
        nodeEnv: "development",
        flag: "yes",
        urlHost: "127.0.0.1",
        headerHost: "127.0.0.1",
      }),
      false,
    );
    assert.equal(
      localhostGateOpen({
        nodeEnv: undefined,
        flag: "open",
        urlHost: "127.0.0.1",
        headerHost: "127.0.0.1",
      }),
      false,
    );

    process.env.MAIL_LOCALHOST_GATE = "open";
    process.env.GBM_DEMO = "0";
    delete process.env.APP_PASSWORD;
    delete process.env.GBM_SITE_PASSWORD;
    delete process.env.SESSION_SECRET;
    try {
      process.env.NODE_ENV = "production";
      const prod = await handleSiteRequest({
        request: new Request("http://127.0.0.1/", { headers: { host: "127.0.0.1" } }),
        pathname: "/",
        handlerType: "router",
      });
      assert.equal(prod?.status, 302);
      assert.equal(prod?.headers.get("location"), "/login?next=%2F");

      process.env.NODE_ENV = "development";
      const remote = await handleSiteRequest({
        request: new Request("https://mail.example/", {
          headers: { host: "mail.example", "x-forwarded-host": "127.0.0.1" },
        }),
        pathname: "/",
        handlerType: "router",
      });
      assert.equal(remote?.status, 302);

      const open = await handleSiteRequest({
        request: new Request("http://127.0.0.1:9/", { headers: { host: "127.0.0.1:9" } }),
        pathname: "/",
        handlerType: "router",
      });
      assert.equal(open, null);
    } finally {
      restoreEnv();
    }
  });

  it("rejects ingest when INGEST_TOKEN is unset and does not open a database", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.INGEST_TOKEN;
    delete process.env.GBM_SITE_PASSWORD;
    process.env.GBM_DEMO = "0";
    assert.equal(pgliteStarted(), false);
    const post = await handleSiteRequest({
      request: new Request("https://mail.example/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"items":[]}',
      }),
      pathname: "/api/ingest",
      handlerType: "router",
    });
    assert.equal(post?.status, 503);
    assert.equal(pgliteStarted(), false);
    const state = await handleSiteRequest({
      request: get("/api/ingest/state"),
      pathname: "/api/ingest/state",
      handlerType: "router",
    });
    assert.equal(state?.status, 503);
    const other = await handleSiteRequest({
      request: get("/api/other"),
      pathname: "/api/other",
      handlerType: "router",
    });
    assert.equal(other?.status, 302);
    assert.equal(pgliteStarted(), false);
  });

  it("answers /api/outbox with JSON and does not redirect to login", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.INGEST_TOKEN;
    delete process.env.GBM_SITE_PASSWORD;
    process.env.GBM_DEMO = "0";
    assert.equal(pgliteStarted(), false);
    const queued = await handleSiteRequest({
      request: new Request("https://mail.example/api/outbox?status=queued", {
        method: "GET",
        headers: { cookie: "gb_session=not-a-session" },
      }),
      pathname: "/api/outbox",
      handlerType: "router",
    });
    assert.equal(queued?.status, 503);
    assert.match(queued?.headers.get("content-type") ?? "", /json/);
    assert.equal(queued?.headers.get("location"), null);
    assert.deepEqual(await queued?.json(), { error: "unavailable" });
    assert.equal(pgliteStarted(), false);

    process.env.INGEST_TOKEN = "bridge-test-token";
    const denied = await handleSiteRequest({
      request: new Request("https://mail.example/api/outbox/send_1/status", {
        method: "POST",
        headers: {
          cookie: "gb_session=not-a-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "awaiting_approval" }),
      }),
      pathname: "/api/outbox/send_1/status",
      handlerType: "router",
    });
    assert.equal(denied?.status, 401);
    assert.equal(denied?.headers.get("location"), null);
    assert.deepEqual(await denied?.json(), { error: "unauthorized" });
    assert.equal(pgliteStarted(), false);

    const cancel = await handleSiteRequest({
      request: new Request("https://mail.example/api/outbox/send_1", {
        method: "DELETE",
        headers: { authorization: "Bearer bridge-test-token" },
      }),
      pathname: "/api/outbox/send_1",
      handlerType: "router",
    });
    assert.equal(cancel?.status, 401);
    assert.equal(cancel?.headers.get("location"), null);
    assert.deepEqual(await cancel?.json(), { error: "unauthorized" });
    assert.equal(pgliteStarted(), false);
  });

  it("opens the sample inbox when no database and no password are set", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.APP_PASSWORD;
    delete process.env.GBM_SITE_PASSWORD;
    delete process.env.SESSION_SECRET;
    delete process.env.GBM_DEMO;
    resetDemoMailbox();
    const home = await handleSiteRequest({
      request: get("/"),
      pathname: "/",
      handlerType: "router",
    });
    assert.equal(home, null);
    const preview = await handleSiteRequest({
      request: get("/api/demo"),
      pathname: "/api/demo",
      handlerType: "router",
    });
    assert.equal(preview?.status, 200);
    const body = (await preview?.json()) as {
      sample?: boolean;
      note?: string;
      subjects?: string[];
    };
    assert.equal(body.sample, true);
    assert.ok(body.subjects?.includes("Saturday picnic"));
    assert.match(body.note ?? "", /example\.com/);
    assert.equal(pgliteStarted(), false);
  });

  it("keeps the sample inbox behind a password and hides it when demo mode is off", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.GBM_DEMO;
    delete process.env.GBM_SITE_PASSWORD;
    process.env.APP_PASSWORD = APP_PASSWORD;
    process.env.SESSION_SECRET = SECRET;
    const locked = await handleSiteRequest({
      request: get("/api/demo"),
      pathname: "/api/demo",
      handlerType: "router",
    });
    assert.equal(locked?.status, 302);
    process.env.GBM_DEMO = "0";
    delete process.env.APP_PASSWORD;
    const hidden = await handleSiteRequest({
      request: get("/api/demo"),
      pathname: "/api/demo",
      handlerType: "router",
    });
    assert.equal(hidden?.status, 404);
    const home = await handleSiteRequest({
      request: get("/"),
      pathname: "/",
      handlerType: "router",
    });
    assert.equal(home?.status, 302);
  });

  it("cancels a sample outbox row without a session when demo mode is open", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.APP_PASSWORD;
    delete process.env.GBM_SITE_PASSWORD;
    delete process.env.GBM_DEMO;
    delete process.env.INGEST_TOKEN;
    resetDemoMailbox();
    const cancel = await handleSiteRequest({
      request: new Request("https://mail.example/api/outbox/send_demo_1", { method: "DELETE" }),
      pathname: "/api/outbox/send_demo_1",
      handlerType: "router",
    });
    assert.equal(cancel?.status, 200);
    assert.deepEqual(await cancel?.json(), { id: "send_demo_1", status: "cancelled" });
    assert.equal(pgliteStarted(), false);
    resetDemoMailbox();
  });
});
