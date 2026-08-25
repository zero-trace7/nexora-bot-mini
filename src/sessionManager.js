/**
 * ─── Multi-Session Engine ────────────────────────────────────────────────────
 *
 * Owns one isolated WhatsApp connection PER user session. There is no global
 * socket and no global WhatsApp identity: every session id (a browser's `ztsid`
 * cookie) maps to its own Baileys socket, its own auth directory (via store.js),
 * and its own status/settings/message state. One user can never see, pair, or
 * reset another user's session.
 *
 * Public surface used by index.js:
 *   requestPair(id, phone)  -> { code }        // pairing code for THIS session
 *   getStatus(id)           -> sanitized view  // never returns creds
 *   resetSession(id)        -> Promise<void>    // only this session
 *   restoreAll()            -> Promise<void>    // re-link persisted sessions on boot
 *
 * Security notes:
 *   - getStatus returns a whitelisted, sanitized object only. Raw auth state,
 *     keys, and the live socket never leave this module.
 *   - Pairing codes are returned to the requesting session but never logged.
 */

const pino = require("pino");
const QRCode = require("qrcode");
const { Boom } = require("@hapi/boom");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestWaWebVersion,
} = require("@whiskeysockets/baileys");

const store = require("./store");
const { handleCommand } = require("./commands");

const startTime = Date.now();
const MAX_LINK_WARNINGS = 3;
const LINK_REGEX = /https?:\/\/\S+|www\.\S+\.\S+|wa\.me\/\S+/i;

// Test seam: when MOCK_WA=1, sockets are fabricated by a fake factory so the
// full pair -> status -> connected flow can be exercised without live WhatsApp.
const MOCK = process.env.MOCK_WA === "1";

// id -> session object. This Map is a runtime CACHE of live sockets only; the
// source of truth for "which sessions exist" is the persistent store (creds on
// disk / DB), never this Map alone.
const sessions = new Map();

function freshSettings() {
  return {
    autoreact: false,
    autostatus: true,
    antibadword: false,
    antilink: false,
    antidelete: false,
    anticall: false,
  };
}

function newSession(id) {
  const session = {
    id,
    sock: null,
    saveCreds: null,
    dir: null,
    status: {
      connection: "disconnected",
      pairingCode: null,
      qrCodeSvg: null,
      botName: null,
      botId: null,
      lastUpdate: new Date().toISOString(),
    },
    settings: freshSettings(),
    messageStore: {},
    linkWarnings: {},
    attempts: 0,
    starting: false,
  };
  sessions.set(id, session);
  return session;
}

function getOrCreate(id) {
  return sessions.get(id) || newSession(id);
}

function setStatus(session, patch) {
  Object.assign(session.status, patch, { lastUpdate: new Date().toISOString() });
}

async function buildQrSvg(qrString) {
  return QRCode.toString(qrString, {
    type: "svg",
    width: 280,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

// ─── Fake socket for MOCK_WA test mode ───
function makeMockSocket(session) {
  const listeners = {};
  const sock = {
    user: null,
    authState: { creds: { registered: store.hasCreds(session.id) } },
    ev: {
      on: (evt, fn) => {
        (listeners[evt] = listeners[evt] || []).push(fn);
      },
      emit: (evt, arg) => {
        (listeners[evt] || []).forEach((fn) => fn(arg));
      },
    },
    async requestPairingCode() {
      return "ABCD1234";
    },
    // Test driver calls this to simulate the phone completing the link.
    __mockConnect(number, name) {
      sock.user = { id: `${number}:1@s.whatsapp.net`, name: name || "Mock User" };
      sock.authState.creds.registered = true;
      sock.ev.emit("connection.update", { connection: "open" });
    },
    async logout() {},
    end() {},
  };
  return sock;
}

async function realSocket(session) {
  const { state, saveCreds, dir } = await store.createAuthStore(session.id);
  session.saveCreds = saveCreds;
  session.dir = dir;
  const { version } = await fetchLatestWaWebVersion();
  return makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: state,
    browser: ["Windows", "Chrome", "110.0.5481.177"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });
}

/**
 * Start (or ensure) the live socket for a session. Deduped: a session that is
 * already starting, connecting, or open is left alone.
 */
async function startSession(id) {
  const session = getOrCreate(id);

  if (session.starting) return session;
  if (session.sock && (session.status.connection === "connected" || session.status.connection === "pairing")) {
    return session;
  }

  session.starting = true;
  try {
    let sock;
    if (MOCK) {
      sock = makeMockSocket(session);
      session.saveCreds = async () => {};
    } else {
      sock = await realSocket(session);
    }
    session.sock = sock;

    if (!sock.authState.creds.registered) {
      setStatus(session, { connection: "pairing" });
      const qrListener = async (update) => {
        const { qr } = update;
        if (!qr) return;
        try {
          setStatus(session, { qrCodeSvg: await buildQrSvg(qr) });
        } catch (_) {}
      };
      sock.ev.on("connection.update", qrListener);
    } else {
      setStatus(session, { connection: "connecting" });
    }

    wireEvents(session);
  } finally {
    session.starting = false;
  }
  return session;
}

function wireEvents(session) {
  const sock = session.sock;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      setStatus(session, { connection: "disconnected", pairingCode: null, qrCodeSvg: null });
      session.sock = null;
      if (code === DisconnectReason.loggedOut) {
        // Only THIS session is logged out — wipe its creds, never the process.
        await store.deleteSession(session.id).catch(() => {});
        sessions.delete(session.id);
      } else {
        // Exponential backoff, capped at 30s, per session.
        session.attempts = (session.attempts || 0) + 1;
        const delay = Math.min(30000, 5000 * 2 ** (session.attempts - 1));
        setTimeout(() => {
          startSession(session.id).catch(() => {});
        }, delay);
      }
    } else if (connection === "open") {
      session.attempts = 0;
      setStatus(session, {
        connection: "connected",
        pairingCode: null,
        qrCodeSvg: null,
        botName: sock.user?.name || null,
        botId: sock.user?.id || null,
      });
    }
  });

  if (session.saveCreds) sock.ev.on("creds.update", session.saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();
      const { settings, messageStore, linkWarnings } = session;

      if (settings.antidelete && !msg.key.fromMe) messageStore[msg.key.id] = msg;

      if (settings.autostatus && jid === "status@broadcast") {
        try {
          await sock.readMessages([msg.key]);
        } catch (err) {
          console.error("autostatus: failed to view status:", err.message);
        }
      }

      if (settings.antilink && jid.endsWith("@g.us") && !msg.key.fromMe && LINK_REGEX.test(text)) {
        try {
          const groupMeta = await sock.groupMetadata(jid);
          const sender = msg.key.participant;
          const isAdmin = groupMeta.participants.find((p) => p.id === sender)?.admin;
          const isBot = sender?.split("@")[0] === sock.user?.id?.split(":")[0];
          if (!isAdmin && !isBot && sender) {
            await sock.sendMessage(jid, { delete: msg.key });
            const key = `${jid}:${sender}`;
            const count = (linkWarnings[key] || 0) + 1;
            linkWarnings[key] = count;
            if (count >= MAX_LINK_WARNINGS) {
              delete linkWarnings[key];
              await sock.sendMessage(jid, {
                text: `🚫 *Anti-Link:* @${sender.split("@")[0]} hit ${MAX_LINK_WARNINGS}/${MAX_LINK_WARNINGS} warnings for sending links and has been removed.`,
                mentions: [sender],
              });
              await sock.groupParticipantsUpdate(jid, [sender], "remove");
            } else {
              await sock.sendMessage(jid, {
                text: `⚠️ *Anti-Link:* @${sender.split("@")[0]}, links aren't allowed here.\n*Warning ${count}/${MAX_LINK_WARNINGS}* — one more and you'll be removed.`,
                mentions: [sender],
              });
            }
          }
        } catch (err) {
          console.error("antilink: failed to process link:", err.message);
        }
      }
      await handleCommand(sock, msg, { startTime, settings });
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    if (!session.settings.antidelete) return;
    for (const update of updates) {
      if (update.update.protocolMessage?.type === 0) {
        const deletedId = update.update.protocolMessage.key.id;
        const oldMsg = session.messageStore[deletedId];
        if (oldMsg) {
          const jid = oldMsg.key.remoteJid;
          const sender = oldMsg.key.participant || jid;
          await sock.sendMessage(jid, { text: `🛡️ *Anti-Delete Active*\n👤 *Sender:* @${sender.split("@")[0]}`, mentions: [sender] });
          await sock.copyNForward(jid, oldMsg, false);
        }
      }
    }
  });

  sock.ev.on("call", async (calls) => {
    if (!session.settings.anticall) return;
    for (const call of calls) {
      if (call.status === "offer") {
        await sock.rejectCall(call.id, call.from);
        await sock.sendMessage(call.from, { text: `⚠️ *Anti-Call Active:* Calls are not allowed.` });
      }
    }
  });
}

/**
 * Request a pairing code for THIS session's number. Ensures the socket exists
 * first. The returned code is never logged.
 */
async function requestPair(id, phone) {
  const session = await startSession(id);
  const sock = session.sock;
  if (!sock) throw new Error("Session not initialized");
  if (!MOCK) await new Promise((r) => setTimeout(r, 2000));
  const raw = await sock.requestPairingCode(phone);
  const fmt = raw.match(/.{1,4}/g).join("-");
  setStatus(session, { pairingCode: fmt });
  return { code: fmt };
}

/**
 * Sanitized status for one session. Whitelist only — auth creds, keys, and the
 * live socket object are NEVER included.
 */
function getStatus(id) {
  const session = sessions.get(id);
  if (!session) {
    return {
      connection: "disconnected",
      pairingCode: null,
      qrCodeSvg: null,
      botName: null,
      botId: null,
      lastUpdate: new Date().toISOString(),
    };
  }
  const s = session.status;
  const botId = s.botId ? String(s.botId).split(":")[0].split("@")[0] : null;
  return {
    connection: s.connection,
    pairingCode: s.pairingCode,
    qrCodeSvg: s.qrCodeSvg,
    botName: s.botName,
    botId,
    lastUpdate: s.lastUpdate,
  };
}

/** Tear down and permanently remove ONLY this session. */
async function resetSession(id) {
  const session = sessions.get(id);
  if (session && session.sock) {
    try {
      if (typeof session.sock.logout === "function") await session.sock.logout();
    } catch (_) {}
    try {
      if (typeof session.sock.end === "function") session.sock.end();
    } catch (_) {}
  }
  await store.deleteSession(id).catch(() => {});
  sessions.delete(id);
}

/** On boot, re-link every session that has persisted credentials. */
async function restoreAll() {
  const ids = await store.listSessionIds();
  for (const id of ids) {
    try {
      await startSession(id);
    } catch (err) {
      console.error(`restore: failed for a session:`, err.message);
    }
  }
  return ids.length;
}

// Exposed for the MOCK_WA test driver only.
function _getSessionForTest(id) {
  return sessions.get(id);
}

module.exports = {
  startSession,
  requestPair,
  getStatus,
  resetSession,
  restoreAll,
  _getSessionForTest,
};
