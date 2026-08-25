require('dotenv').config();

const crypto = require("crypto");
const chalk = require("chalk");
const express = require("express");

const sessionManager = require("./src/sessionManager");

// ─── Bot Branding ───
const BOT_NAME = "ZERO TRACE";
const AUTHOR = "ZERO TRACE";

// ─── Session Cookie ───
// Each browser gets its own opaque session id in an httpOnly cookie. This id
// keys an isolated WhatsApp connection in the sessionManager, so no two users
// ever share a socket, status, or auth state.
const COOKIE = "ztsid";

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// Reject anything that isn't a well-formed id we minted, so a hostile cookie
// can't steer the session id toward another user's state or the store's paths.
function isValidId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(id);
}

function getOrSetSessionId(req, res) {
  const existing = parseCookies(req)[COOKIE];
  if (existing && isValidId(existing)) return existing;
  const id = crypto.randomUUID();
  res.setHeader("Set-Cookie", `${COOKIE}=${id}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000`);
  return id;
}

// ─── Web Dashboard ───
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  getOrSetSessionId(req, res);
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${BOT_NAME}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { box-sizing: border-box; }
    body {
      background: #0a0a0f; color: #e8e8ee;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      margin: 0; min-height: 100vh; display: flex; justify-content: center; align-items: center;
      padding: 24px 16px; overflow-x: hidden; position: relative;
    }
    /* Ambient gradient glows */
    body::before, body::after {
      content: ""; position: fixed; border-radius: 50%; filter: blur(110px); z-index: 0; pointer-events: none;
    }
    body::before { width: 480px; height: 480px; top: -140px; left: -120px; background: rgba(99,102,241,.16); animation: drift 14s ease-in-out infinite alternate; }
    body::after { width: 420px; height: 420px; bottom: -140px; right: -100px; background: rgba(16,185,129,.13); animation: drift 18s ease-in-out infinite alternate-reverse; }
    @keyframes drift { from { transform: translate(0,0) scale(1); } to { transform: translate(60px,40px) scale(1.12); } }

    .container {
      position: relative; z-index: 1; width: 100%; max-width: 420px; padding: 44px 28px 32px;
      background: rgba(255,255,255,.035); backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px);
      border: 1px solid rgba(255,255,255,.08); border-radius: 26px;
      box-shadow: 0 30px 80px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
      text-align: center; animation: rise .6s cubic-bezier(.2,.9,.3,1) both;
    }
    @keyframes rise { from { opacity: 0; transform: translateY(22px) scale(.98); } to { opacity: 1; transform: none; } }

    .bot-icon {
      width: 86px; height: 86px; margin: 0 auto 18px; border-radius: 26px;
      display: flex; justify-content: center; align-items: center; font-size: 38px; color: #fff;
      background: linear-gradient(135deg, #6366f1, #10b981);
      box-shadow: 0 12px 34px rgba(99,102,241,.45); position: relative;
    }
    .bot-icon::after {
      content: ""; position: absolute; inset: -7px; border-radius: 32px;
      border: 1px solid rgba(99,102,241,.35); animation: pulse-ring 2.4s ease-out infinite;
    }
    @keyframes pulse-ring { 0% { opacity: .9; transform: scale(.96); } 70% { opacity: 0; transform: scale(1.14); } 100% { opacity: 0; } }

    h1 { font-size: 27px; margin: 0 0 6px; font-weight: 800; letter-spacing: -.4px;
      background: linear-gradient(90deg, #ffffff, #a5b4fc 55%, #6ee7b7);
      -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: #8b8ba3; font-size: 14px; margin: 0 0 22px; }

    /* Status pill */
    .status-badge {
      display: inline-flex; align-items: center; gap: 7px; padding: 6px 14px; border-radius: 999px;
      font-size: 11px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; margin-bottom: 14px;
      border: 1px solid transparent;
    }
    .status-badge .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .status-pairing { background: rgba(245,158,11,.12); color: #fbbf24; border-color: rgba(245,158,11,.3); }
    .status-pairing .dot { animation: blink 1.2s infinite; }
    .status-connected { background: rgba(16,185,129,.12); color: #34d399; border-color: rgba(16,185,129,.3); }
    .status-connected .dot { animation: blink 1.2s infinite; }
    .status-disconnected { background: rgba(239,68,68,.12); color: #f87171; border-color: rgba(239,68,68,.3); }
    .status-connecting { background: rgba(148,163,184,.12); color: #94a3b8; border-color: rgba(148,163,184,.3); }
    .status-starting { background: rgba(148,163,184,.12); color: #94a3b8; border-color: rgba(148,163,184,.3); }
    @keyframes blink { 50% { opacity: .25; } }

    /* Tabs */
    .tabs { display: flex; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.07); border-radius: 14px; padding: 5px; margin-bottom: 24px; }
    .tab {
      flex: 1; padding: 11px; border-radius: 10px; cursor: pointer; border: none; font-weight: 600; font-size: 14px;
      background: transparent; color: #8b8ba3; transition: all .25s ease; font-family: inherit;
    }
    .tab i { margin-right: 6px; }
    .tab:hover { color: #e8e8ee; }
    .tab.active { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; box-shadow: 0 6px 18px rgba(99,102,241,.4); }

    .panel { display: none; animation: fadein .35s ease both; }
    .panel.active { display: block; }
    @keyframes fadein { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

    .input-group { text-align: left; margin-bottom: 18px; }
    label { display: block; font-size: 12.5px; font-weight: 600; margin-bottom: 9px; color: #c7c7d9; letter-spacing:.2px; }
    input {
      width: 100%; padding: 14px 16px; border-radius: 13px; border: 1px solid rgba(255,255,255,.1);
      background: rgba(255,255,255,.05); color: #fff; font-size: 15px; outline: none; transition: all .2s ease;
    }
    input::placeholder { color: #55556b; }
    input:focus { border-color: #6366f1; background: rgba(99,102,241,.07); box-shadow: 0 0 0 4px rgba(99,102,241,.15); }

    .btn-main {
      width: 100%; padding: 14px; border-radius: 13px; border: none; cursor: pointer; margin-bottom: 16px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-weight: 700; font-size: 15px;
      font-family: inherit; transition: all .2s ease; box-shadow: 0 8px 24px rgba(99,102,241,.35);
    }
    .btn-main i { margin-right: 7px; }
    .btn-main:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(99,102,241,.5); }
    .btn-main:active:not(:disabled) { transform: translateY(0); }
    .btn-main:disabled { opacity: .45; cursor: not-allowed; box-shadow: none; }

    .display-box {
      background: rgba(255,255,255,.05); border: 1px dashed rgba(255,255,255,.14);
      padding: 17px 15px; border-radius: 13px; margin-bottom: 14px; font-weight: 600; font-size: 15px; color: #8b8ba3;
    }
    .code-text {
      color: #fff; letter-spacing: 5px; font-size: 21px; font-weight: 800;
      font-family: "SF Mono", "Consolas", monospace;
      background: linear-gradient(90deg, #a5b4fc, #6ee7b7);
      -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    }

    .row { display: flex; gap: 10px; }
    .btn-secondary {
      flex: 1; padding: 13px; border-radius: 13px; cursor: pointer; font-size: 14px; font-family: inherit;
      border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.05); color: #e8e8ee;
      font-weight: 600; transition: all .2s ease;
    }
    .btn-secondary i { margin-right: 7px; }
    .btn-secondary:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.25); }
    .btn-danger { border-color: rgba(239,68,68,.35); color: #f87171; background: rgba(239,68,68,.06); }
    .btn-danger:hover { background: rgba(239,68,68,.15); border-color: rgba(239,68,68,.5); }

    /* QR */
    .qr-frame {
      display: inline-block; padding: 16px; border-radius: 20px; background: #fff;
      box-shadow: 0 14px 40px rgba(0,0,0,.5); margin-bottom: 16px; max-width: 240px;
    }
    .qr-frame svg { display: block; }
    .qr-svg p { padding: 24px; color: #888; margin: 0; }
    .steps { text-align: left; margin: 18px 0 4px; padding: 0; list-style: none; }
    .steps li { color: #8b8ba3; font-size: 13px; padding: 5px 0; display: flex; gap: 10px; align-items: baseline; }
    .steps li b { color: #c7c7d9; }
    .steps .num {
      flex: none; width: 20px; height: 20px; border-radius: 50%; background: rgba(99,102,241,.15);
      color: #a5b4fc; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
      transform: translateY(3px);
    }

    footer { margin-top: 28px; font-size: 12px; color: #55556b; }
    footer .heart { color: #f43f5e; }

    /* Toast */
    #toast {
      position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%) translateY(20px);
      background: #16161f; color: #fff; border: 1px solid rgba(255,255,255,.12); padding: 12px 22px;
      border-radius: 999px; font-size: 14px; font-weight: 600; opacity: 0; pointer-events: none;
      transition: all .3s cubic-bezier(.2,.9,.3,1); z-index: 10; box-shadow: 0 14px 40px rgba(0,0,0,.6);
      white-space: nowrap;
    }
    #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    #toast.ok { border-color: rgba(16,185,129,.4); }
    #toast.err { border-color: rgba(239,68,68,.4); }

    .connected-info { margin: 4px 0 20px; }
    .connected-info .who { font-size: 16px; font-weight: 700; color: #fff; margin-bottom: 4px; }
    .connected-info .num { font-size: 13px; color: #8b8ba3; font-family: monospace; }

    .spinner { display: inline-block; width: 15px; height: 15px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -2px; margin-right: 8px; }
    @keyframes spin { to { transform: rotate(360deg); } }

    @media (max-width: 380px) { .container { padding: 34px 18px 26px; } h1 { font-size: 23px; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="bot-icon"><i class="fas fa-ghost"></i></div>
    <div class="status-badge status-disconnected" id="status-badge"><span class="dot"></span><span id="status-label">connecting</span></div>
    <h1>${BOT_NAME}</h1>

    <!-- Connected view -->
    <div id="connected-panel" style="display:none;">
      <p class="subtitle">WhatsApp linked successfully</p>
      <div class="connected-info">
        <div class="who" id="conn-name"></div>
        <div class="num" id="conn-id"></div>
      </div>
      <div class="row">
        <button class="btn-secondary btn-danger" onclick="resetSession()"><i class="fas fa-power-off"></i> Unlink / Reset</button>
      </div>
    </div>

    <!-- Linking view -->
    <div id="linking-panel">
      <p class="subtitle">Link your WhatsApp device</p>
      <div class="tabs">
        <button class="tab active" id="tab-btn-pair" onclick="switchTab('pair')"><i class="fas fa-key"></i> Pair Code</button>
        <button class="tab" id="tab-btn-qr" onclick="switchTab('qr')"><i class="fas fa-qrcode"></i> QR Code</button>
      </div>
      <div id="pair-section" class="panel active">
        <div class="input-group">
          <label>Enter your WhatsApp number with country code</label>
          <input type="tel" id="phone-input" placeholder="+1XXXXXXXXXX" autocomplete="tel">
        </div>
        <button class="btn-main" id="gen-btn" onclick="generatePairCode()"><i class="fas fa-bolt"></i> Generate Pair Code</button>
        <div class="display-box" id="code-box">Your pair code will appear here</div>
        <button class="btn-secondary" id="copy-btn" onclick="copyCode()" style="width:100%"><i class="fas fa-copy"></i> Copy Code</button>
      </div>
      <div id="qr-section" class="panel">
        <div class="qr-frame"><div class="qr-svg" id="qr-box"><p>Waiting for QR code...</p></div></div>
        <ul class="steps">
          <li><span class="num">1</span><span>Open <b>WhatsApp</b> on your phone</span></li>
          <li><span class="num">2</span><span>Go to <b>Settings &gt; Linked Devices</b></span></li>
          <li><span class="num">3</span><span>Tap <b>Link a Device</b> and scan this code</span></li>
        </ul>
      </div>
    </div>

    <footer>&copy; 2026 ${AUTHOR} &nbsp;&middot;&nbsp; Crafted with <span class="heart">&hearts;</span></footer>
  </div>

  <div id="toast"></div>

  <script>
    var initialStatus = 'connecting';
    var toastTimer = null;

    function showToast(msg, cls) {
      var t = document.getElementById('toast');
      t.innerText = msg;
      t.className = 'show ' + (cls || '');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.className = ''; }, 2600);
    }

    function setStatus(data) {
      var badge = document.getElementById('status-badge');
      var label = document.getElementById('status-label');
      badge.className = 'status-badge status-' + data.connection;
      label.innerText = data.connection;
      if (data.connection === 'connected') {
        document.getElementById('linking-panel').style.display = 'none';
        document.getElementById('connected-panel').style.display = 'block';
        document.getElementById('conn-name').innerText = data.botName || 'Connected';
        var id = data.botId || '';
        document.getElementById('conn-id').innerText = id.split(':')[0].split('@')[0];
      } else {
        document.getElementById('linking-panel').style.display = 'block';
        document.getElementById('connected-panel').style.display = 'none';
      }
    }

    function switchTab(type) {
      var pairSec = document.getElementById('pair-section');
      var qrSec = document.getElementById('qr-section');
      var pairBtn = document.getElementById('tab-btn-pair');
      var qrBtn = document.getElementById('tab-btn-qr');
      if (type === 'pair') {
        pairSec.classList.add('active'); qrSec.classList.remove('active');
        pairBtn.classList.add('active'); qrBtn.classList.remove('active');
      } else {
        pairSec.classList.remove('active'); qrSec.classList.add('active');
        pairBtn.classList.remove('active'); qrBtn.classList.add('active');
        pollOnce();
      }
    }

    async function generatePairCode() {
      var phoneInput = document.getElementById('phone-input');
      var phone = phoneInput.value.replace(/[^0-9]/g, '');
      if (!phone || phone.length < 7) return showToast('Enter a valid number with country code', 'err');
      var btn = document.getElementById('gen-btn');
      var box = document.getElementById('code-box');
      btn.disabled = true;
      box.innerHTML = '<span class="spinner"></span>Generating code...';
      try {
        var res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phone }) });
        var data = await res.json();
        if (data.code) {
          box.innerHTML = '<span class="code-text">' + data.code + '</span>';
          showToast('Pair code generated', 'ok');
          if (navigator.clipboard) navigator.clipboard.writeText(data.code.replace(/-/g, '')).catch(function(){});
        } else {
          box.innerText = 'Error: ' + (data.error || 'Failed to generate');
          showToast(data.error || 'Failed to generate code', 'err');
          btn.disabled = false;
        }
      } catch (e) {
        box.innerText = 'Error connecting to server';
        showToast('Could not reach the server', 'err');
        btn.disabled = false;
      }
    }

    function copyCode() {
      var box = document.getElementById('code-box');
      var code = box.innerText.trim();
      if (code.indexOf('appear') !== -1 || code.indexOf('Generating') !== -1 || code.indexOf('Error') !== -1) return;
      navigator.clipboard.writeText(code.replace(/-/g, '')).then(function () { showToast('Code copied to clipboard', 'ok'); });
    }

    function resetSession() {
      if (!confirm('Unlink the device and reset the session?')) return;
      showToast('Resetting session...', 'err');
      fetch('/reset', { method: 'POST' }).then(function () {
        setTimeout(function () { location.reload(); }, 500);
      }).catch(function () { location.reload(); });
    }

    async function pollOnce() {
      try {
        var res = await fetch('/status');
        var data = await res.json();
        setStatus(data);
        if (data.qrCodeSvg) document.getElementById('qr-box').innerHTML = data.qrCodeSvg;
      } catch (e) {}
    }

    setInterval(async function () {
      try {
        var res = await fetch('/status');
        var data = await res.json();
        if (initialStatus !== 'connected' && data.connection === 'connected') { location.reload(); return; }
        setStatus(data);
        if (document.getElementById('qr-section').classList.contains('active') && data.qrCodeSvg) {
          document.getElementById('qr-box').innerHTML = data.qrCodeSvg;
        }
      } catch (e) {}
    }, 5000);

    // Enter key submits the phone input
    document.getElementById('phone-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') generatePairCode();
    });

    // No server-injected status: always resolve this session's own state on load.
    pollOnce();
  </script>
</body>
</html>`);
});

// Every API route is scoped to the caller's own cookie session. A request can
// only ever read or mutate the session bound to its own ztsid cookie.
app.get("/status", (req, res) => {
  const id = getOrSetSessionId(req, res);
  sessionManager.startSession(id).catch(() => {});
  res.json(sessionManager.getStatus(id));
});

app.post("/api/pair", async (req, res) => {
  const id = getOrSetSessionId(req, res);
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "Phone number required" });
  const digits = String(phone).replace(/[^0-9]/g, "");
  if (digits.length < 7) return res.status(400).json({ error: "Invalid phone number" });
  try {
    const { code } = await sessionManager.requestPair(id, digits);
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/reset", async (req, res) => {
  const id = getOrSetSessionId(req, res);
  try {
    await sessionManager.resetSession(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Boot ───
(async () => {
  const restored = await sessionManager.restoreAll().catch((err) => {
    console.error("restoreAll failed:", err.message);
    return 0;
  });
  app.listen(PORT, () => {
    console.log(chalk.cyan(`Dashboard: http://localhost:${PORT}`));
    console.log(chalk.gray(`Restored ${restored} persisted session(s).`));
  });
})();
