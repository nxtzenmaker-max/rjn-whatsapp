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

const contactsMap = new Map();
const chatsMap = new Map();

// ================= MONGODB SESSION STORAGE =================
async function initMongo() {
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db('rjn_holo');
    console.log('Connected to MongoDB Atlas: rjn_holo');
    await restoreAuthFromMongo();
    await loadInitialContactsFromMongo();
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
  }
}

async function restoreAuthFromMongo() {
  if (!db) return;
  try {
    const authCol = db.collection('whatsapp_auth');
    const docs = await authCol.find({}).toArray();
    if (docs && docs.length > 1) {
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

async function loadInitialContactsFromMongo() {
  if (!db) return;
  try {
    const docs = await db.collection('whatsapp_contacts').find({}).toArray();
    docs.forEach(c => contactsMap.set(c._id, c));
    console.log(`Loaded ${contactsMap.size} cached contacts from MongoDB.`);
  } catch(e){}
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

// ================= SAVE CONTACT HELPER =================
async function saveContact(c) {
  if (!c || !c.id || c.id.includes('@broadcast') || c.id.includes('status')) return;
  const phone = c.id.split('@')[0];
  const name = c.name || c.notify || c.verifiedName || '';
  const contactData = {
    _id: c.id,
    id: c.id,
    phone,
    name,
    notify: c.notify || '',
    verifiedName: c.verifiedName || '',
    updatedAt: new Date()
  };
  contactsMap.set(c.id, contactData);

  if (db) {
    try {
      await db.collection('whatsapp_contacts').updateOne(
        { _id: c.id },
        { $set: contactData },
        { upsert: true }
      );
    } catch(e){}
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
      syncFullHistory: true
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
          setTimeout(() => startWhatsApp(pairingPhone), 10000);
        } else {
          setTimeout(() => startWhatsApp(pairingPhone), 3000);
        }
      }
    });

    // ================= CONTACTS & CHAT HISTORY EVENTS =================
    sock.ev.on('contacts.upsert', async (contacts) => {
      console.log(`Received contacts.upsert: ${contacts.length} contacts`);
      for (const c of contacts) {
        await saveContact(c);
      }
    });

    sock.ev.on('contacts.update', async (updates) => {
      for (const u of updates) {
        await saveContact(u);
      }
    });

    sock.ev.on('chats.upsert', async (chats) => {
      for (const ch of chats) {
        if (!ch.id || ch.id.includes('@broadcast')) continue;
        chatsMap.set(ch.id, ch);
        if (db) {
          try {
            await db.collection('whatsapp_chats').updateOne(
              { _id: ch.id },
              { $set: { ...ch, updatedAt: new Date() } },
              { upsert: true }
            );
          } catch(e){}
        }
      }
    });

    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
      console.log(`History sync received: ${contacts?.length || 0} contacts, ${chats?.length || 0} chats, ${messages?.length || 0} messages`);
      if (contacts && Array.isArray(contacts)) {
        for (const c of contacts) {
          await saveContact(c);
        }
      }
      if (chats && Array.isArray(chats)) {
        for (const ch of chats) {
          if (!ch.id || ch.id.includes('@broadcast')) continue;
          chatsMap.set(ch.id, ch);
          if (db) {
            try {
              await db.collection('whatsapp_chats').updateOne(
                { _id: ch.id },
                { $set: { ...ch, updatedAt: new Date() } },
                { upsert: true }
              );
            } catch(e){}
          }
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

        // Auto-save sender contact if notify name present
        if (msg.pushName) {
          await saveContact({ id: remoteJid, notify: msg.pushName });
        }

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

        // 2. Contacts Query on WhatsApp
        if (lower.includes('contact') || lower.includes('contacts') || lower.includes('kis kis ke number') || lower.includes('kaun kaun se contact')) {
          let list = [];
          if (db) {
            try {
              list = await db.collection('whatsapp_contacts').find({}).sort({ name: 1 }).limit(30).toArray();
            } catch(e){}
          }
          if (list.length === 0) {
            list = Array.from(contactsMap.values()).slice(0, 30);
          }

          let contactReply = `📱 RJN WhatsApp Contacts Directory (${list.length} contacts):\n\n`;
          if (list.length === 0) {
            contactReply += 'Phone ke contacts sync ho rahe hain. Thodi der me dobara check karein!';
          } else {
            list.slice(0, 15).forEach((c, idx) => {
              const name = c.name || c.notify || 'Contact';
              const p = c.phone || c.id?.split('@')[0] || '';
              contactReply += `${idx + 1}. ${name} (+${p})\n`;
            });
            if (list.length > 15) {
              contactReply += `\n...aur ${list.length - 15} contacts hain. Dashboard par poori directory dekhein: ${RUNNER_URL.replace('rjn-runner', 'rjn-whatsapp')}`;
            }
          }
          await sock.sendMessage(remoteJid, { text: contactReply });
          continue;
        }

        // 3. Database Stats
        if (lower.includes('database') || lower.includes('db status') || lower.includes('stats')) {
          let count = 0;
          let turns = 0;
          let contactsCount = contactsMap.size;
          if (db) {
            count = await db.collection('whatsapp_messages').countDocuments({});
            turns = await db.collection('conversations').countDocuments({});
            contactsCount = await db.collection('whatsapp_contacts').countDocuments({});
          }
          const dbReply = `📊 RJN Database Access Active (MongoDB Atlas):\n• Database: rjn_holo\n• Contacts Synced: ${contactsCount}\n• WhatsApp Messages: ${count}\n• Web Hologram Speech Turns: ${turns}\n• Cloud Runner: Online (${RUNNER_URL})\n\nमैं RJN हूँ! आप मुझसे कोई भी command चलाने या data query करने को कह सकते हैं।`;
          await sock.sendMessage(remoteJid, { text: dbReply });
          continue;
        }

        // 4. Conversational Reply
        let reply = '';
        if (lower.includes('kaun ho') || lower.includes('who are you') || lower.includes('naam kya')) {
          reply = 'नमस्ते! मैं RJN हूँ, आपकी AI साथी और systems engineer। मेरे पास आपके Railway cloud runner और MongoDB database ka poora access hai!';
        } else if (lower.includes('namaste') || lower.includes('hello') || lower.includes('hi') || lower.includes('kaise ho')) {
          reply = 'नमस्ते! मैं बिल्कुल ठीक हूँ। बताइए, आज आपके cloud server par kaun sa command run karna hai ya kis contact ko message bhejna hai?';
        } else {
          reply = `नमस्ते! मैंने आपका संदेश प्राप्त किया: "${cleanText}"।\nमेरे पास Dedicated Cloud Server aur MongoDB Atlas ka poora access hai. 'run <command>' likhkar koi bhi command chala sakte hain!`;
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
  let contactsCount = contactsMap.size;
  let chatsCount = chatsMap.size;
  if (db) {
    try {
      contactsCount = await db.collection('whatsapp_contacts').countDocuments({});
      chatsCount = await db.collection('whatsapp_chats').countDocuments({});
    } catch(e){}
  }

  res.json({
    success: true,
    engine: 'Baileys Multi-Device',
    status: waStatus,
    pairingPhone,
    user: activeUser,
    stats: {
      contactsSynced: contactsCount,
      chatsSynced: chatsCount
    },
    database: { connected: !!db, name: 'rjn_holo', cluster: 'MongoDB Atlas' },
    cloudRunner: { url: RUNNER_URL, status: 'active' }
  });
});

// Contacts Directory API
app.get('/contacts', async (req, res) => {
  let contacts = [];
  if (db) {
    try {
      contacts = await db.collection('whatsapp_contacts').find({}).sort({ name: 1 }).toArray();
    } catch(e){}
  }
  if (contacts.length === 0) {
    contacts = Array.from(contactsMap.values());
  }

  res.json({
    success: true,
    count: contacts.length,
    contacts: contacts.map(c => ({
      id: c._id || c.id,
      phone: c.phone || c.id?.split('@')[0],
      name: c.name || c.notify || 'Unknown Contact',
      notify: c.notify || '',
      verifiedName: c.verifiedName || ''
    }))
  });
});

// Chats Directory API
app.get('/chats', async (req, res) => {
  let chats = [];
  if (db) {
    try {
      chats = await db.collection('whatsapp_chats').find({}).sort({ updatedAt: -1 }).toArray();
    } catch(e){}
  }
  if (chats.length === 0) {
    chats = Array.from(chatsMap.values());
  }
  res.json({
    success: true,
    count: chats.length,
    chats
  });
});

// Send WhatsApp Message API
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

// Web UI Dashboard
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RJN WhatsApp Hub | Connected</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: #12151f;
      --border: #23293a;
      --accent: #00d2ff;
      --success: #10b981;
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
      padding: 32px 16px;
    }
    .container {
      width: 100%;
      max-width: 680px;
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
    }
    .tab-btn.active {
      background: #1e2433;
      color: #ffffff;
      border: 1px solid var(--border);
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .contacts-list {
      max-height: 400px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .contact-card {
      background: #0d1017;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .contact-name { font-weight: 600; font-size: 14px; color: #ffffff; }
    .contact-phone { font-size: 12px; color: var(--subtext); font-family: ui-monospace, monospace; }
    .search-box {
      width: 100%;
      background: #0d1017;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 14px;
      color: #fff;
      font-size: 14px;
      margin-bottom: 12px;
      outline: none;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
    .stat-card { background: #0b0e16; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
    .stat-name { font-size: 11px; color: var(--subtext); text-transform: uppercase; }
    .stat-val { font-size: 15px; font-weight: 600; color: #fff; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div id="statusBadge" class="status-badge status-connected">
        <span class="status-dot"></span>
        <span id="statusText">CONNECTED: 8083797688</span>
      </div>
      <h1 class="title">RJN WhatsApp Hub</h1>
      <p class="subtitle">Baileys Multi-Device • MongoDB Atlas • Dedicated Linux Runner</p>
    </div>

    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('contactsTab', this)">Contacts Directory</button>
      <button class="tab-btn" onclick="switchTab('systemTab', this)">System Status</button>
    </div>

    <div id="contactsTab" class="tab-content active">
      <input type="text" id="searchBox" class="search-box" placeholder="Search contacts by name or number..." oninput="filterContacts()" />
      <div id="contactsContainer" class="contacts-list">
        <div style="text-align:center; padding:20px; color:var(--subtext);">Loading synced contacts...</div>
      </div>
    </div>

    <div id="systemTab" class="tab-content">
      <div class="grid">
        <div class="stat-card">
          <div class="stat-name">Database</div>
          <div class="stat-val">MongoDB Atlas (rjn_holo)</div>
        </div>
        <div class="stat-card">
          <div class="stat-name">Total Contacts</div>
          <div class="stat-val" id="totalContactsStat">Syncing...</div>
        </div>
        <div class="stat-card">
          <div class="stat-name">Cloud Runner</div>
          <div class="stat-val">Online (Railway)</div>
        </div>
        <div class="stat-card">
          <div class="stat-name">Session Persistence</div>
          <div class="stat-val">Permanent (Cloud Synced)</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let allContacts = [];

    function switchTab(tabId, btn) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    }

    async function loadContacts() {
      try {
        const res = await fetch('/contacts');
        const data = await res.json();
        allContacts = data.contacts || [];
        document.getElementById('totalContactsStat').textContent = allContacts.length;
        renderContacts(allContacts);
      } catch(e){}
    }

    function renderContacts(list) {
      const container = document.getElementById('contactsContainer');
      if (list.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--subtext);">Syncing contacts with WhatsApp... check back in a few seconds!</div>';
        return;
      }
      container.innerHTML = list.map(c => \`
        <div class="contact-card">
          <div>
            <div class="contact-name">\${c.name || c.notify || 'Contact'}</div>
            <div class="contact-phone">+\${c.phone}</div>
          </div>
        </div>
      \`).join('');
    }

    function filterContacts() {
      const q = document.getElementById('searchBox').value.toLowerCase().trim();
      if (!q) return renderContacts(allContacts);
      const filtered = allContacts.filter(c =>
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.notify && c.notify.toLowerCase().includes(q)) ||
        (c.phone && c.phone.includes(q))
      );
      renderContacts(filtered);
    }

    loadContacts();
    setInterval(loadContacts, 8000);
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
