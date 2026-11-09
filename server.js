const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const { MongoClient } = require('mongodb');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://nxtzenmaker_db_user:r8ZyEmKrNjvhhLBx@cluster0.t0wluzt.mongodb.net/?retryWrites=true&w=majority';
const RUNNER_URL = process.env.RUNNER_URL || 'https://rjn-runner-production.up.railway.app';
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || 'rjn_live_runner_9a8b7c6d5e4f3a2b1';
const DEFAULT_PHONE = process.env.DEFAULT_PHONE || '918083797688';

const AUTH_DIR = path.join(__dirname, 'auth');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let mongoClient = null;
let db = null;
let sock = null;
let waStatus = 'initializing';
let activeUser = null;
let activePairingCode = null;
let latestQrString = null;
let latestQrImage = null;
let pairingPhone = DEFAULT_PHONE;
let rateLimitDetected = false;
let rateLimitMessage = '';

// ================= MONGODB SESSION STORAGE =================
async function initMongo() {
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db('rjn_holo');
    console.log('Connected to MongoDB Atlas: rjn_holo');
    await restoreAuthFromMongo();
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
  }
}

async function restoreAuthFromMongo() {
  if (!db) return;
  try {
    const authCol = db.collection('whatsapp_auth');
    const docs = await authCol.find({}).toArray();
    if (docs && docs.length > 1) { // Verified session has multiple key files
      console.log(`Restoring ${docs.length} verified session files from MongoDB Atlas...`);
      for (const doc of docs) {
        if (doc.filename && doc.content) {
          const filePath = path.join(AUTH_DIR, doc.filename);
          fs.writeFileSync(filePath, Buffer.from(doc.content, 'base64'));
        }
      }
      console.log('Verified WhatsApp session restored.');
    }
  } catch (e) {
    console.warn('Error restoring auth from MongoDB:', e.message);
  }
}

async function syncAuthToMongo() {
  if (!db || !activeUser) return;
  try {
    const authCol = db.collection('whatsapp_auth');
    if (!fs.existsSync(AUTH_DIR)) return;
    const files = fs.readdirSync(AUTH_DIR);
    for (const f of files) {
      const fullPath = path.join(AUTH_DIR, f);
      if (fs.statSync(fullPath).isFile()) {
        const content = fs.readFileSync(fullPath).toString('base64');
        await authCol.updateOne(
          { filename: f },
          { $set: { filename: f, content, updatedAt: new Date() } },
          { upsert: true }
        );
      }
    }
    console.log('Active authenticated WhatsApp session synced to MongoDB Atlas.');
  } catch (e) {
    console.warn('Error syncing auth to MongoDB:', e.message);
  }
}

// ================= CLOUD LINUX RUNNER =================
async function executeCloudCommand(command) {
  try {
    const resp = await fetch(`${RUNNER_URL}/execute`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RUNNER_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ command, timeout: 45000 })
    });
    return await resp.json();
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ================= BAILEYS SOCKET CLIENT =================
async function startWhatsApp(requestedPhone = DEFAULT_PHONE) {
  pairingPhone = requestedPhone.replace(/[^0-9]/g, '');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      if (activeUser && sock.authState?.creds?.registered) {
        syncAuthToMongo();
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQrString = qr;
        waStatus = 'awaiting_scan_or_code';
        try {
          latestQrImage = await QRCode.toDataURL(qr, { width: 340, margin: 2 });
        } catch(e){}
      }

      if (connection === 'connecting') {
        waStatus = activeUser ? 'reconnecting' : 'connecting';
      } else if (connection === 'open') {
        waStatus = 'connected';
        activeUser = sock.user;
        activePairingCode = null;
        latestQrString = null;
        latestQrImage = null;
        rateLimitDetected = false;
        console.log('WhatsApp connected successfully! User:', sock.user?.id || sock.user?.name);
        syncAuthToMongo();
        if (db) {
          await db.collection('whatsapp_status').updateOne(
            { _id: 'session' },
            { $set: { user: sock.user, status: 'connected', connectedAt: new Date() } },
            { upsert: true }
          );
        }
      } else if (connection === 'close') {
        waStatus = 'disconnected';
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`WhatsApp socket closed (code: ${statusCode}). Registered: ${!!activeUser}`);

        if (activeUser && statusCode === DisconnectReason.loggedOut) {
          activeUser = null;
          activePairingCode = null;
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          }
          if (db) await db.collection('whatsapp_auth').deleteMany({});
          setTimeout(() => startWhatsApp(DEFAULT_PHONE), 5000);
        } else if (!activeUser) {
          // Keep a healthy 10-second gap before reconnecting so we never trigger WhatsApp rate limits
          setTimeout(() => startWhatsApp(pairingPhone), 10000);
        } else {
          setTimeout(() => startWhatsApp(pairingPhone), 3000);
        }
      }
    });

    // ================= INCOMING WHATSAPP MESSAGES =================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const remoteJid = msg.key.remoteJid;
        if (remoteJid.endsWith('@broadcast') || remoteJid.includes('status')) continue;

        const text = msg.message.conversation ||
                     msg.message.extendedTextMessage?.text ||
                     msg.message.imageMessage?.caption || '';

        if (!text || text.trim() === '') continue;
        const cleanText = text.trim();
        console.log(`Message from ${remoteJid}: "${cleanText}"`);

        if (db) {
          try {
            await db.collection('whatsapp_messages').insertOne({
              from: remoteJid,
              senderName: msg.pushName || 'Unknown',
              text: cleanText,
              type: 'incoming',
              timestamp: new Date()
            });
          } catch(e){}
        }

        const lower = cleanText.toLowerCase();

        // 1. Cloud Terminal Execution
        if (cleanText.startsWith('$') || cleanText.startsWith('/') || lower.startsWith('run ') || lower.startsWith('exec ') || lower.startsWith('cmd ')) {
          let commandToRun = cleanText;
          if (cleanText.startsWith('$') || cleanText.startsWith('/')) {
            commandToRun = cleanText.substring(1).trim();
          } else {
            commandToRun = cleanText.replace(/^(run|exec|cmd)\s+/i, '').trim();
          }

          await sock.sendMessage(remoteJid, { text: `⚡ RJN Running Cloud Command:\n\`${commandToRun}\`...` });
          const execResult = await executeCloudCommand(commandToRun);
          let replyMsg = '';
          if (execResult.success) {
            const out = (execResult.stdout || '(no stdout)').trim();
            const err = (execResult.stderr || '').trim();
            replyMsg = `✅ RJN Execution Succeeded (${execResult.executionTimeMs}ms, code: ${execResult.exitCode}):\n\n\`\`\`\n${out}\n\`\`\``;
            if (err) replyMsg += `\n\nStderr:\n\`\`\`\n${err}\n\`\`\``;
          } else {
            replyMsg = `❌ RJN Command Failed:\n${execResult.error || 'Execution timeout or error'}`;
          }

          await sock.sendMessage(remoteJid, { text: replyMsg });
          if (db) {
            try {
              await db.collection('whatsapp_messages').insertOne({
                to: remoteJid,
                text: replyMsg,
                type: 'reply',
                command: commandToRun,
                result: execResult,
                timestamp: new Date()
              });
            } catch (e){}
          }
          continue;
        }

        // 2. Database Stats
        if (lower.includes('database') || lower.includes('db status') || lower.includes('stats')) {
          let count = 0;
          let turns = 0;
          if (db) {
            count = await db.collection('whatsapp_messages').countDocuments({});
            turns = await db.collection('conversations').countDocuments({});
          }
          const dbReply = `📊 RJN Database Access Active (MongoDB Atlas):\n• Database: rjn_holo\n• WhatsApp Messages: ${count}\n• Web Hologram Speech Turns: ${turns}\n• Cloud Runner: Online (${RUNNER_URL})\n\nमैं RJN हूँ! आप मुझे कोई भी command चलाने को कह सकते हैं।`;
          await sock.sendMessage(remoteJid, { text: dbReply });
          continue;
        }

        // 3. Conversational Reply
        let reply = '';
        if (lower.includes('kaun ho') || lower.includes('who are you') || lower.includes('naam kya')) {
          reply = 'नमस्ते! मैं RJN हूँ, आपकी AI साथी और systems engineer। मेरे पास आपके Railway cloud runner और MongoDB database का पूरा एक्सेस है।';
        } else if (lower.includes('namaste') || lower.includes('hello') || lower.includes('hi') || lower.includes('kaise ho')) {
          reply = 'नमस्ते! मैं बिल्कुल ठीक हूँ। बताइए, आज आपके cloud server पर कौन सा command run करना है?';
        } else {
          reply = `नमस्ते! मैं RJN हूँ। मैंने आपका संदेश प्राप्त किया: "${cleanText}"।\nमेरे पास Dedicated Cloud Server और MongoDB Atlas का पूर्ण एक्सेस है। 'run <command>' लिखकर कोई भी bash/python command चला सकते हैं!`;
        }

        await sock.sendMessage(remoteJid, { text: reply });
        if (db) {
          try {
            await db.collection('whatsapp_messages').insertOne({
              to: remoteJid,
              text: reply,
              type: 'reply',
              timestamp: new Date()
            });
          } catch(e){}
        }
      }
    });

  } catch (err) {
    console.error('startWhatsApp error:', err);
    waStatus = 'error';
    setTimeout(() => startWhatsApp(DEFAULT_PHONE), 10000);
  }
}

// ================= EXPRESS API & DASHBOARD =================

// Status API
app.get('/status', async (req, res) => {
  res.json({
    success: true,
    engine: 'Baileys Multi-Device',
    status: waStatus,
    pairingPhone,
    pairingCode: activePairingCode ? (activePairingCode.match(/.{1,4}/g)?.join('-') || activePairingCode) : null,
    rawPairingCode: activePairingCode,
    hasQr: !!latestQrString,
    qrImage: latestQrImage,
    rateLimitDetected,
    rateLimitMessage,
    user: activeUser,
    database: { connected: !!db, name: 'rjn_holo', cluster: 'MongoDB Atlas' },
    cloudRunner: { url: RUNNER_URL, status: 'active' }
  });
});

// QR Code Raw Image Endpoint
app.get('/qr', async (req, res) => {
  if (!latestQrString) {
    return res.status(404).send('QR code not available right now. Please check /status.');
  }
  try {
    const qrBuffer = await QRCode.toBuffer(latestQrString, { width: 380, margin: 2 });
    res.type('image/png').send(qrBuffer);
  } catch(e) {
    res.status(500).send('Error generating QR image');
  }
});

// Explicit Request for Pairing Code
app.get('/pair', async (req, res) => {
  const phone = req.query.phone || DEFAULT_PHONE;
  const cleanPhone = phone.replace(/[^0-9]/g, '');

  if (!cleanPhone || cleanPhone.length < 8) {
    return res.status(400).json({ success: false, error: 'Valid phone number required' });
  }

  if (waStatus === 'connected' && activeUser) {
    return res.json({
      success: true,
      status: 'already_connected',
      message: 'WhatsApp is already connected to: ' + activeUser.id,
      user: activeUser
    });
  }

  pairingPhone = cleanPhone;

  if (sock) {
    try {
      console.log(`Explicitly requesting pairing code for ${cleanPhone}...`);
      const code = await sock.requestPairingCode(cleanPhone);
      activePairingCode = code;
      rateLimitDetected = false;
      const formatted = code.match(/.{1,4}/g)?.join('-') || code;
      return res.json({
        success: true,
        phone: cleanPhone,
        pairingCode: formatted,
        rawCode: code
      });
    } catch (err) {
      console.error('Explicit pairing error:', err.message);
      if (err.message && (err.message.includes('429') || err.message.includes('rate-overlimit'))) {
        rateLimitDetected = true;
        rateLimitMessage = 'WhatsApp server rate-limit on phone number requests. Please scan the QR code instead.';
      }
      return res.json({
        success: false,
        error: err.message,
        rateLimited: rateLimitDetected,
        message: 'WhatsApp server temporarily rate-limited pairing codes. Please scan the live QR code on the dashboard!'
      });
    }
  }

  return res.status(503).json({ success: false, error: 'Socket initializing, please try again in 5 seconds' });
});

// Web UI Dashboard
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RJN WhatsApp Hub | Instant Link</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: #12151f;
      --border: #23293a;
      --accent: #00d2ff;
      --success: #10b981;
      --warning: #f59e0b;
      --text: #f1f5f9;
      --subtext: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
    }
    .container {
      width: 100%;
      max-width: 600px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px 28px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.45);
    }
    .header { text-align: center; margin-bottom: 24px; }
    .title { font-size: 26px; font-weight: 700; color: #ffffff; margin-bottom: 6px; }
    .subtitle { font-size: 13px; color: var(--subtext); }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 20px;
    }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; }
    .status-connected {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .status-connected .status-dot { background: var(--success); }
    .status-pairing {
      background: rgba(0, 210, 255, 0.15);
      color: var(--accent);
      border: 1px solid rgba(0, 210, 255, 0.3);
    }
    .status-pairing .status-dot { background: var(--accent); animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.3); } }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
      background: #0d1017;
      padding: 4px;
      border-radius: 10px;
      border: 1px solid var(--border);
    }
    .tab-btn {
      flex: 1;
      padding: 10px;
      background: transparent;
      border: none;
      color: var(--subtext);
      font-size: 13px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .tab-btn.active {
      background: #1e2433;
      color: #ffffff;
      border: 1px solid var(--border);
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .qr-card {
      background: #0d1017;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      text-align: center;
      margin-bottom: 20px;
    }
    .qr-img {
      width: 260px;
      height: 260px;
      border-radius: 8px;
      background: #ffffff;
      padding: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }
    .qr-hint {
      margin-top: 14px;
      font-size: 13px;
      color: var(--subtext);
    }
    .code-card {
      background: #0d1017;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      text-align: center;
      margin-bottom: 20px;
    }
    .code-display {
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 36px;
      font-weight: 700;
      letter-spacing: 6px;
      color: #00ffcc;
      text-shadow: 0 0 15px rgba(0, 255, 204, 0.3);
      user-select: all;
    }
    .copy-btn {
      margin-top: 14px;
      background: #1e2433;
      color: var(--text);
      border: 1px solid var(--border);
      padding: 8px 18px;
      border-radius: 8px;
      font-size: 13px;
      cursor: pointer;
    }
    .notice {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.3);
      color: var(--warning);
      padding: 12px 14px;
      border-radius: 8px;
      font-size: 12px;
      margin-bottom: 16px;
      line-height: 1.5;
    }
    .steps-list {
      background: #0a0c12;
      border: 1px solid #1a202c;
      border-radius: 10px;
      padding: 16px 20px;
      font-size: 13px;
      line-height: 1.8;
      color: var(--subtext);
    }
    .steps-list strong { color: var(--text); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div id="statusBadge" class="status-badge status-pairing">
        <span class="status-dot"></span>
        <span id="statusText">AWAITING LINK...</span>
      </div>
      <h1 class="title">RJN WhatsApp Hub</h1>
      <p class="subtitle">Baileys WebSocket Bridge • MongoDB Atlas • Dedicated Linux Runner</p>
    </div>

    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('qrTab', this)">Instant QR Scanner</button>
      <button class="tab-btn" onclick="switchTab('codeTab', this)">Pairing Code</button>
    </div>

    <div id="qrTab" class="tab-content active">
      <div class="qr-card">
        <img id="qrImage" class="qr-img" src="/qr" alt="Scan QR Code in WhatsApp" />
        <div class="qr-hint">Scan with WhatsApp: <strong>Settings &gt; Linked Devices &gt; Link a Device</strong></div>
      </div>
      <div class="steps-list">
        <div><strong>Step 1:</strong> Open WhatsApp on your phone (8083797688).</div>
        <div><strong>Step 2:</strong> Tap <strong>Settings</strong> (or 3 dots) &gt; <strong>Linked Devices</strong>.</div>
        <div><strong>Step 3:</strong> Tap <strong>Link a Device</strong> and point your camera at the QR code above.</div>
        <div><strong>Step 4:</strong> Done! WhatsApp links instantly in 1 second.</div>
      </div>
    </div>

    <div id="codeTab" class="tab-content">
      <div class="notice">
        WhatsApp server limits phone number pairing codes to a few attempts per 15 minutes. If pairing code shows an error, please use the <strong>Instant QR Scanner</strong> tab.
      </div>
      <div class="code-card">
        <div style="font-size:12px; color:var(--subtext); text-transform:uppercase; margin-bottom:10px;">Pairing Code for +91 8083797688</div>
        <div id="codeDisplay" class="code-display">REQUESTING</div>
        <button id="copyBtn" class="copy-btn" onclick="copyCode()">Copy Code</button>
      </div>
      <div style="text-align:center; margin-bottom:16px;">
        <button onclick="requestPairingCode()" style="background:#00d2ff; color:#000; border:none; padding:10px 18px; border-radius:8px; font-weight:600; cursor:pointer;">Request New Code</button>
      </div>
    </div>
  </div>

  <script>
    let currentCode = '';
    function switchTab(tabId, btn) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    }

    async function checkStatus() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        const badge = document.getElementById('statusBadge');
        const statusText = document.getElementById('statusText');
        const qrImg = document.getElementById('qrImage');

        if (data.status === 'connected') {
          badge.className = 'status-badge status-connected';
          statusText.textContent = 'CONNECTED: ' + (data.user?.id ? data.user.id.split(':')[0] : 'ACTIVE');
          document.getElementById('codeDisplay').textContent = 'LINKED';
        } else {
          badge.className = 'status-badge status-pairing';
          statusText.textContent = data.status.toUpperCase();
          if (data.qrImage) {
            qrImg.src = data.qrImage;
          }
          if (data.pairingCode) {
            currentCode = data.rawPairingCode || data.pairingCode;
            document.getElementById('codeDisplay').textContent = data.pairingCode;
          }
        }
      } catch(e){}
    }

    async function requestPairingCode() {
      document.getElementById('codeDisplay').textContent = 'FETCHING...';
      try {
        const res = await fetch('/pair?phone=918083797688');
        const data = await res.json();
        if (data.pairingCode) {
          currentCode = data.rawCode || data.pairingCode;
          document.getElementById('codeDisplay').textContent = data.pairingCode;
        } else {
          alert(data.message || data.error);
          document.getElementById('codeDisplay').textContent = 'RATE LIMITED';
        }
      } catch(e) {
        alert('Request failed: ' + e.message);
      }
    }

    function copyCode() {
      if (!currentCode) return;
      navigator.clipboard.writeText(currentCode.replace(/-/g, '')).then(() => {
        const btn = document.getElementById('copyBtn');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy Code'; }, 2000);
      });
    }

    setInterval(checkStatus, 3000);
    checkStatus();
  </script>
</body>
</html>`);
});

// ================= BOOTSTRAP =================
app.listen(PORT, async () => {
  console.log(`RJN WhatsApp Hub running on port ${PORT}`);
  await initMongo();
  startWhatsApp(DEFAULT_PHONE);
});
