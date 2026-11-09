const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
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
let pairingPhone = DEFAULT_PHONE;
let hasRequestedCodeForCurrentSocket = false;
let pairingLock = false;

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
    // Only restore if we have verified session keys (not empty or broken pairing attempts)
    if (docs && docs.length > 1) {
      console.log(`Restoring ${docs.length} verified auth files from MongoDB Atlas...`);
      for (const doc of docs) {
        if (doc.filename && doc.content) {
          const filePath = path.join(AUTH_DIR, doc.filename);
          fs.writeFileSync(filePath, Buffer.from(doc.content, 'base64'));
        }
      }
      console.log('Session restored successfully from MongoDB Atlas.');
    } else {
      console.log('No verified multi-file session in MongoDB. Ready for fresh pairing.');
    }
  } catch (e) {
    console.warn('Error restoring auth from MongoDB:', e.message);
  }
}

async function syncVerifiedAuthToMongo() {
  if (!db || !fs.existsSync(AUTH_DIR)) return;
  try {
    const authCol = db.collection('whatsapp_auth');
    const files = fs.readdirSync(AUTH_DIR);
    console.log(`Syncing ${files.length} authenticated session files to MongoDB Atlas...`);
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
    console.log('Authenticated session permanently preserved in MongoDB Atlas.');
  } catch (e) {
    console.warn('Error syncing auth to MongoDB:', e.message);
  }
}

// ================= CLOUD RUNNER COMMAND DISPATCH =================
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

// ================= ROCK-SOLID BAILEYS CLIENT =================
const logger = pino({ level: 'silent' });

async function startWhatsApp(targetPhone = DEFAULT_PHONE) {
  if (pairingLock) return;
  pairingLock = true;
  pairingPhone = targetPhone.replace(/[^0-9]/g, '');
  hasRequestedCodeForCurrentSocket = false;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      // Only sync to MongoDB Atlas if connection is officially registered!
      if (sock && sock.authState && sock.authState.creds && sock.authState.creds.registered) {
        syncVerifiedAuthToMongo();
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'connecting') {
        waStatus = 'connecting';
        console.log('WhatsApp connection status: connecting...');
      }

      // Socket is ready for pairing code
      if (qr && !sock.authState.creds.registered) {
        waStatus = 'awaiting_pairing';
        if (!hasRequestedCodeForCurrentSocket && pairingPhone) {
          hasRequestedCodeForCurrentSocket = true;
          try {
            console.log('Requesting fresh pairing code for phone:', pairingPhone);
            const code = await sock.requestPairingCode(pairingPhone);
            activePairingCode = code;
            console.log('ACTIVE PAIRING CODE READY:', code);

            if (db) {
              await db.collection('whatsapp_status').updateOne(
                { _id: 'pairing' },
                { $set: { phone: pairingPhone, code, generatedAt: new Date() } },
                { upsert: true }
              );
            }
          } catch (err) {
            console.error('requestPairingCode error:', err.message);
          }
        }
      }

      // Successfully authenticated & linked!
      if (connection === 'open') {
        waStatus = 'connected';
        activeUser = sock.user;
        activePairingCode = null;
        console.log('WHATSAPP LINKED & CONNECTED SUCCESSFULLY! User:', sock.user?.id || sock.user?.name);
        await syncVerifiedAuthToMongo();

        if (db) {
          await db.collection('whatsapp_status').updateOne(
            { _id: 'session' },
            { $set: { user: sock.user, status: 'connected', connectedAt: new Date() } },
            { upsert: true }
          );
        }
      }

      // Disconnected handling
      if (connection === 'close') {
        waStatus = 'disconnected';
        pairingLock = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed (statusCode: ${statusCode}). Registered: ${!!sock.authState?.creds?.registered}`);

        if (sock.authState?.creds?.registered) {
          // Normal reconnect for already-paired user
          console.log('Reconnecting registered session in 4s...');
          setTimeout(() => startWhatsApp(pairingPhone), 4000);
        } else {
          // Temporary pairing socket timeout. Wipe temporary unlinked creds so new handshake is clean!
          console.log('Pairing attempt timed out. Resetting local auth cache for fresh pairing in 3s...');
          if (fs.existsSync(AUTH_DIR)) {
            try {
              fs.rmSync(AUTH_DIR, { recursive: true, force: true });
              fs.mkdirSync(AUTH_DIR, { recursive: true });
            } catch (e) {}
          }
          setTimeout(() => startWhatsApp(pairingPhone), 3000);
        }
      }
    });

    // ================= INCOMING MESSAGES & AI AGENT =================
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
        const lower = cleanText.toLowerCase();
        console.log(`Incoming message from ${remoteJid}: "${cleanText}"`);

        // Save incoming message in MongoDB Atlas
        if (db) {
          try {
            await db.collection('whatsapp_messages').insertOne({
              from: remoteJid,
              senderName: msg.pushName || 'User',
              text: cleanText,
              type: 'incoming',
              timestamp: new Date()
            });
          } catch(e){}
        }

        // 1. Terminal / Shell command execution via Railway Runner
        if (cleanText.startsWith('$') || cleanText.startsWith('/') || lower.startsWith('run ') || lower.startsWith('exec ') || lower.startsWith('cmd ')) {
          let commandToRun = cleanText;
          if (cleanText.startsWith('$') || cleanText.startsWith('/')) {
            commandToRun = cleanText.substring(1).trim();
          } else {
            commandToRun = cleanText.replace(/^(run|exec|cmd)\s+/i, '').trim();
          }

          await sock.sendMessage(remoteJid, { text: `⚡ RJN: Cloud command run ho raha hai...\n\`${commandToRun}\`` });

          const execResult = await executeCloudCommand(commandToRun);
          let replyMsg = '';
          if (execResult.success) {
            const out = (execResult.stdout || '(no stdout)').trim();
            const err = (execResult.stderr || '').trim();
            replyMsg = `✅ RJN Execution Succeeded (${execResult.executionTimeMs || execResult.durationMs || 15}ms, exit code: ${execResult.exitCode}):\n\n\`\`\`\n${out}\n\`\`\``;
            if (err) replyMsg += `\n\nStderr:\n\`\`\`\n${err}\n\`\`\``;
          } else {
            replyMsg = `❌ RJN Command Failed:\n${execResult.error || execResult.stderr || 'Execution timeout or error'}`;
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
            } catch(e){}
          }
          continue;
        }

        // 2. Database Status Request
        if (lower.includes('database') || lower.includes('db status') || lower.includes('kitne message') || lower.includes('stats')) {
          let count = 0;
          let turns = 0;
          if (db) {
            count = await db.collection('whatsapp_messages').countDocuments({});
            turns = await db.collection('conversations').countDocuments({});
          }
          const dbReply = `📊 RJN Database Access Active (MongoDB Atlas):\n• Database: rjn_holo\n• WhatsApp Messages Logged: ${count}\n• Web Hologram Speech Turns: ${turns}\n• Cloud Runner: Online (${RUNNER_URL})\n\nमैं RJN हूँ! आप मुझे कोई भी Linux command, Python script, या git repository check karne ko bol sakte hain.`;
          await sock.sendMessage(remoteJid, { text: dbReply });
          continue;
        }

        // 3. Conversational AI Companion (RJN Persona)
        let reply = '';
        if (lower.includes('kaun ho') || lower.includes('who are you') || lower.includes('naam kya') || lower.includes('intro')) {
          reply = 'नमस्ते! मैं RJN हूँ, आपकी AI साथी और pair programmer। मेरे पास आपके Railway cloud Linux runner और MongoDB Atlas database का पूरा एक्सेस है। आप मुझसे कोई भी terminal command या code run करने को कह सकते हैं!';
        } else if (lower.includes('namaste') || lower.includes('hello') || lower.includes('hi') || lower.includes('kasi ho') || lower.includes('kaise ho')) {
          reply = 'नमस्ते! मैं बिल्कुल ठीक हूँ। बताइए, आज cloud runner पर कौन सा command चलाना है या क्या काम करना है?';
        } else {
          reply = `नमस्ते! मैं RJN हूँ। मैंने आपका संदेश प्राप्त किया: "${cleanText}"。\nमेरे पास Dedicated Cloud Linux Server और MongoDB Atlas का पूर्ण एक्सेस है। आप 'run <command>' लिखकर कोई भी bash/python command चला सकते हैं!`;
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
    pairingLock = false;
    waStatus = 'error';
    setTimeout(() => startWhatsApp(targetPhone), 5000);
  } finally {
    pairingLock = false;
  }
}

// ================= API ROUTES =================

// Status API
app.get('/status', async (req, res) => {
  let messageCount = 0;
  let holoConversationsCount = 0;
  if (db) {
    try {
      messageCount = await db.collection('whatsapp_messages').countDocuments({});
      holoConversationsCount = await db.collection('conversations').countDocuments({});
    } catch(e){}
  }

  res.json({
    success: true,
    engine: 'Baileys Multi-Device',
    status: waStatus,
    pairingPhone,
    pairingCode: activePairingCode ? (activePairingCode.match(/.{1,4}/g)?.join('-') || activePairingCode) : null,
    rawPairingCode: activePairingCode,
    user: activeUser,
    database: {
      connected: !!db,
      name: 'rjn_holo',
      cluster: 'MongoDB Atlas',
      whatsappMessages: messageCount,
      hologramTurns: holoConversationsCount
    },
    cloudRunner: {
      url: RUNNER_URL,
      status: 'active'
    }
  });
});

// Request / Refresh Pairing Code
app.get('/pair', async (req, res) => {
  const phone = req.query.phone || DEFAULT_PHONE;
  const cleanPhone = phone.replace(/[^0-9]/g, '');

  if (!cleanPhone || cleanPhone.length < 8) {
    return res.status(400).json({ success: false, error: 'Valid phone number required' });
  }

  // If already paired
  if (waStatus === 'connected' && activeUser) {
    return res.json({
      success: true,
      status: 'already_connected',
      message: 'WhatsApp is already linked to: ' + activeUser.id,
      user: activeUser
    });
  }

  // If we already have an active pairing code for this exact phone
  if (pairingPhone === cleanPhone && activePairingCode && waStatus === 'awaiting_pairing') {
    const formatted = activePairingCode.match(/.{1,4}/g)?.join('-') || activePairingCode;
    return res.json({
      success: true,
      phone: cleanPhone,
      pairingCode: formatted,
      rawCode: activePairingCode,
      cached: true,
      instructions: [
        '1. Open WhatsApp on phone ' + cleanPhone,
        '2. Tap Settings > Linked Devices',
        '3. Tap Link with phone number instead',
        '4. Enter pairing code: ' + formatted
      ]
    });
  }

  // Trigger fresh socket initialization for the requested number
  pairingPhone = cleanPhone;
  activePairingCode = null;
  hasRequestedCodeForCurrentSocket = false;

  if (fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch(e){}
  }

  if (sock) {
    try {
      sock.end(undefined);
    } catch(e){}
  }

  setTimeout(() => startWhatsApp(cleanPhone), 500);

  // Poll for code to be generated within 4 seconds
  let attempts = 0;
  const pollInterval = setInterval(() => {
    attempts++;
    if (activePairingCode) {
      clearInterval(pollInterval);
      const formatted = activePairingCode.match(/.{1,4}/g)?.join('-') || activePairingCode;
      return res.json({
        success: true,
        phone: cleanPhone,
        pairingCode: formatted,
        rawCode: activePairingCode,
        instructions: [
          '1. Open WhatsApp on phone ' + cleanPhone,
          '2. Tap Settings > Linked Devices',
          '3. Tap Link with phone number instead',
          '4. Enter pairing code: ' + formatted
        ]
      });
    }
    if (attempts >= 10) {
      clearInterval(pollInterval);
      return res.json({
        success: true,
        status: 'initializing',
        phone: cleanPhone,
        message: 'Socket starting up. Please check status in 2 seconds.'
      });
    }
  }, 400);
});

// Send Message API
app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, error: 'Missing "to" or "message" field' });
  }

  if (waStatus !== 'connected' || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected yet' });
  }

  try {
    const rawTo = to.replace(/[^0-9]/g, '');
    const jid = rawTo.includes('@') ? rawTo : `${rawTo}@s.whatsapp.net`;
    const result = await sock.sendMessage(jid, { text: message });
    return res.json({ success: true, jid, messageId: result.key.id });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Execute Cloud Command API
app.post('/execute', async (req, res) => {
  const command = req.body.command || req.query.command;
  if (!command) return res.status(400).json({ success: false, error: 'Command required' });
  const result = await executeCloudCommand(command);
  return res.json(result);
});

// Recent Messages
app.get('/messages', async (req, res) => {
  if (!db) return res.json({ success: false, error: 'Database offline' });
  try {
    const msgs = await db.collection('whatsapp_messages').find({}).sort({ timestamp: -1 }).limit(50).toArray();
    return res.json({ success: true, count: msgs.length, messages: msgs });
  } catch(e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Dashboard UI
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RJN WhatsApp Hub | Baileys Cloud Bridge</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: #12151f;
      --border: #23293a;
      --accent: #00d2ff;
      --success: #10b981;
      --danger: #ef4444;
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
      max-width: 580px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 32px 28px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.45);
    }
    .header { text-align: center; margin-bottom: 24px; }
    .title { font-size: 24px; font-weight: 700; color: #ffffff; margin-bottom: 6px; }
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
    .status-disconnected {
      background: rgba(239, 68, 68, 0.15);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .status-disconnected .status-dot { background: var(--danger); }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.3); } }
    .code-card {
      background: #0d1017;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      text-align: center;
      margin-bottom: 24px;
    }
    .code-label { font-size: 12px; color: var(--subtext); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
    .code-display {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
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
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .copy-btn:hover { background: #2b3347; border-color: var(--accent); }
    .input-group { display: flex; gap: 10px; margin-bottom: 24px; }
    .input-field {
      flex: 1;
      background: #0d1017;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      color: #ffffff;
      font-size: 14px;
      outline: none;
    }
    .input-field:focus { border-color: var(--accent); }
    .primary-btn {
      background: #00d2ff;
      color: #090a0f;
      border: none;
      border-radius: 8px;
      padding: 12px 20px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .primary-btn:hover { opacity: 0.9; }
    .steps-list {
      background: #0a0c12;
      border: 1px solid #1a202c;
      border-radius: 10px;
      padding: 16px 20px;
      font-size: 13px;
      line-height: 1.8;
      color: var(--subtext);
      margin-bottom: 24px;
    }
    .steps-list strong { color: var(--text); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div id="statusBadge" class="status-badge status-pairing">
        <span class="status-dot"></span>
        <span id="statusText">CONNECTING...</span>
      </div>
      <h1 class="title">RJN WhatsApp Agent</h1>
      <p class="subtitle">Baileys WebSocket Bridge • Dedicated Linux Runner • MongoDB Atlas</p>
    </div>

    <div class="code-card">
      <div class="code-label">WhatsApp Linking Pairing Code</div>
      <div id="codeDisplay" class="code-display">--------</div>
      <button id="copyBtn" class="copy-btn" onclick="copyCode()">Copy Code</button>
    </div>

    <div class="input-group">
      <input type="text" id="phoneInput" class="input-field" placeholder="Enter Phone (e.g. 918083797688)" value="${DEFAULT_PHONE}" />
      <button class="primary-btn" onclick="requestNewCode()">Request Code</button>
    </div>

    <div class="steps-list">
      <div><strong>Step 1:</strong> Open WhatsApp on your phone.</div>
      <div><strong>Step 2:</strong> Tap <strong>Settings</strong> &gt; <strong>Linked Devices</strong>.</div>
      <div><strong>Step 3:</strong> Tap <strong>Link with phone number instead</strong>.</div>
      <div><strong>Step 4:</strong> Enter the 8-character pairing code shown above.</div>
    </div>
  </div>

  <script>
    let currentCode = '';

    async function checkStatus() {
      try {
        const res = await fetch('/status');
        const data = await res.json();

        const badge = document.getElementById('statusBadge');
        const statusText = document.getElementById('statusText');
        const codeDisplay = document.getElementById('codeDisplay');

        if (data.status === 'connected') {
          badge.className = 'status-badge status-connected';
          statusText.textContent = 'CONNECTED: ' + (data.user?.id ? data.user.id.split(':')[0] : 'ACTIVE');
          codeDisplay.textContent = 'LINKED';
          codeDisplay.style.color = '#10b981';
          document.getElementById('copyBtn').style.display = 'none';
        } else {
          badge.className = 'status-badge status-pairing';
          statusText.textContent = data.status.toUpperCase();
          if (data.pairingCode) {
            currentCode = data.rawPairingCode || data.pairingCode;
            codeDisplay.textContent = data.pairingCode;
            codeDisplay.style.color = '#00ffcc';
            document.getElementById('copyBtn').style.display = 'inline-block';
          }
        }
      } catch (e) {
        console.warn('Status check failed:', e);
      }
    }

    async function requestNewCode() {
      const phone = document.getElementById('phoneInput').value.trim();
      if (!phone) return alert('Please enter phone number');
      document.getElementById('codeDisplay').textContent = 'GENERATING...';
      try {
        const res = await fetch('/pair?phone=' + encodeURIComponent(phone));
        const data = await res.json();
        if (data.pairingCode) {
          currentCode = data.rawCode || data.pairingCode;
          document.getElementById('codeDisplay').textContent = data.pairingCode;
        } else {
          setTimeout(checkStatus, 2000);
        }
      } catch(e) {
        alert('Request error: ' + e.message);
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

    setInterval(checkStatus, 2500);
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
