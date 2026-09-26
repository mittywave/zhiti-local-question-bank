import { env } from "cloudflare:workers";
import type { AuthUser } from "../../lib/types";

type AppEnv = {
  DB: D1Database;
  REGISTRATION_INVITE_CODE?: string;
  ADMIN_EMAIL?: string;
  LOCAL_ADMIN_MODE?: string;
};

const COOKIE_NAME = "zhiti_session";
const SESSION_DAYS = 30;
const LOCAL_ADMIN: AuthUser = { id: "local-admin", email: "localhost", role: "admin", local: true };
// Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000 iterations.
const PASSWORD_ITERATIONS = 100_000;

function appEnv(): AppEnv {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return bytesToBase64(new Uint8Array(bits));
}

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

export function validPassword(value: string) {
  return value.length >= 8 && value.length <= 128;
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await derivePassword(password, salt, PASSWORD_ITERATIONS), salt: bytesToBase64(salt), iterations: PASSWORD_ITERATIONS };
}

export async function verifyPassword(password: string, hash: string, salt: string, iterations: number) {
  const candidate = await derivePassword(password, base64ToBytes(salt), iterations);
  return constantTimeEqual(candidate, hash);
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const item of cookie.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return "";
}

export function isLocalRequest(request: Request) {
  // Production never grants automatic administrator access, even when the
  // request URL, Host or forwarding headers contain a loopback address.
  if (appEnv().LOCAL_ADMIN_MODE !== "true") return false;
  const localHost = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!localHost(hostname)) return false;
  // A reverse-proxy header is never authority to grant a role. When Host is
  // present it must agree with the actual request URL, not replace it.
  const host = request.headers.get("Host");
  if (host && host.toLowerCase() !== url.host.toLowerCase()) return false;
  return true;
}

async function ensureLocalAdmin() {
  await appEnv().DB.prepare(`
    INSERT OR IGNORE INTO users (id, email, password_hash, password_salt, password_iterations, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(LOCAL_ADMIN.id, "localhost@local.invalid", "local-only", "local-only", 1, LOCAL_ADMIN.role, 0).run();
}

export async function currentUser(request: Request): Promise<AuthUser | null> {
  if (isLocalRequest(request)) {
    await ensureLocalAdmin();
    return LOCAL_ADMIN;
  }
  const token = cookieValue(request, COOKIE_NAME);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Date.now();
  const row = await appEnv().DB.prepare(`
    SELECT users.id, users.email, users.role
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).bind(tokenHash, now).first<{ id: string; email: string; role: "admin" | "member" }>();
  return row ? { id: row.id, email: row.email, role: row.role } : null;
}

export async function requireUser(request: Request) {
  const user = await currentUser(request);
  if (!user) throw new Response(JSON.stringify({ error: "请先登录" }), { status: 401, headers: { "Content-Type": "application/json" } });
  return user;
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  const requestUrl = new URL(request.url);
  if (new URL(origin).host !== requestUrl.host) {
    throw new Response(JSON.stringify({ error: "请求来源不受信任" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
}

export async function createSession(userId: string) {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await appEnv().DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, expiresAt, now).run();
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export async function destroySession(request: Request) {
  const token = cookieValue(request, COOKIE_NAME);
  if (token) await appEnv().DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function authBindings() {
  return appEnv();
}

export function inviteMatches(candidate: string) {
  const expected = appEnv().REGISTRATION_INVITE_CODE ?? "";
  return expected.split(",").map((code) => code.trim()).filter(Boolean)
    .reduce((matched, code) => constantTimeEqual(candidate.trim(), code) || matched, false);
}

export function roleForEmail(email: string): "admin" | "member" {
  return normalizeEmail(appEnv().ADMIN_EMAIL ?? "") === normalizeEmail(email) ? "admin" : "member";
}

export async function authRateLimited(kind: "login" | "register", key: string) {
  const db = appEnv().DB;
  const since = Date.now() - 15 * 60 * 1000;
  const row = await db.prepare("SELECT COUNT(*) AS count FROM auth_attempts WHERE kind = ? AND attempt_key = ? AND created_at > ?")
    .bind(kind, key, since).first<{ count: number }>();
  return Number(row?.count ?? 0) >= (kind === "login" ? 12 : 6);
}

export async function recordAuthAttempt(kind: "login" | "register", key: string) {
  const db = appEnv().DB;
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO auth_attempts (kind, attempt_key, created_at) VALUES (?, ?, ?)").bind(kind, key, now),
    db.prepare("DELETE FROM auth_attempts WHERE created_at < ?").bind(now - 24 * 60 * 60 * 1000),
  ]);
}

export function clientAddress(request: Request) {
  return request.headers.get("CF-Connecting-IP") ?? "local";
}
