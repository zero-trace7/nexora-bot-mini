/**
 * ─── Auth-State Store (swappable) ────────────────────────────────────────────
 *
 * This module is the ONLY place that knows *where* a session's WhatsApp
 * credentials live. Everything else (sessionManager) talks to this interface,
 * so the persistence backend can be replaced without touching session logic.
 *
 * Default implementation: local files, one directory per session, via Baileys'
 * `useMultiFileAuthState`. This survives an ordinary process restart *only if
 * the filesystem is persistent*. On Render Free the disk is EPHEMERAL, so
 * credentials are wiped on spin-down/redeploy. To survive that you must either
 * mount a Render paid disk at SESSIONS_DIR, or implement a database-backed
 * store below (e.g. Postgres/Mongo/Redis/S3) that satisfies this same contract:
 *
 *   createAuthStore(sessionId) -> Promise<{ state, saveCreds }>
 *   listSessionIds()           -> Promise<string[]>   // sessions with saved creds
 *   deleteSession(sessionId)   -> Promise<void>
 *
 * No secrets are hard-coded here — the base directory comes from the
 * SESSIONS_DIR environment variable (falls back to ./sessions).
 */

const fs = require("fs");
const path = require("path");
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");

// Base directory that holds one sub-directory per session id.
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(process.cwd(), "sessions");

// Session ids are used as directory names, so reject anything that could
// escape the base directory (path traversal / separators / dotfiles).
function isSafeSessionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== "." && id !== "..";
}

function sessionPath(sessionId) {
  if (!isSafeSessionId(sessionId)) throw new Error("Invalid session id");
  return path.join(SESSIONS_DIR, sessionId);
}

function ensureBaseDir() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * Load (or lazily create) the auth state for one session.
 * Returns Baileys-compatible `{ state, saveCreds }`.
 */
async function createAuthStore(sessionId) {
  ensureBaseDir();
  const dir = sessionPath(sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  return { state, saveCreds, dir };
}

/**
 * All session ids that currently have persisted credentials (creds.json).
 * Used on boot to auto-restore previously linked sessions.
 */
async function listSessionIds() {
  ensureBaseDir();
  let entries;
  try {
    entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isSafeSessionId(e.name))
    .filter((e) => fs.existsSync(path.join(SESSIONS_DIR, e.name, "creds.json")))
    .map((e) => e.name);
}

/**
 * Permanently remove a single session's stored credentials. Only touches that
 * one session's directory — never anything else.
 */
async function deleteSession(sessionId) {
  const dir = sessionPath(sessionId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** True once a session has real persisted creds (i.e. it was linked before). */
function hasCreds(sessionId) {
  try {
    return fs.existsSync(path.join(sessionPath(sessionId), "creds.json"));
  } catch (_) {
    return false;
  }
}

module.exports = {
  SESSIONS_DIR,
  isSafeSessionId,
  createAuthStore,
  listSessionIds,
  deleteSession,
  hasCreds,
};
