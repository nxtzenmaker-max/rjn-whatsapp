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
  fetchLatestBaileysVersion,
  downloadMediaMessage
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

    // ================= INCOMING WHATSAPP MESSAGES & MEDIA =================
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

        // Detect images across direct, viewOnce, and ephemeral formats
        const imgObj = msg.message.imageMessage ||
                       msg.message.viewOnceMessage?.message?.imageMessage ||
                       msg.message.viewOnceMessageV2?.message?.imageMessage ||
                       msg.message.ephemeralMessage?.message?.imageMessage;

        const caption = imgObj?.caption ||
                        msg.message.conversation ||
                        msg.message.extendedTextMessage?.text || '';

        let mediaBase64 = null;
        let isImage = !!imgObj;

        if (imgObj) {
          try {
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              {
                logger: pino({ level: 'silent' }),
                reuploadRequest: sock.updateMediaMessage
              }
            );
            if (buffer && buffer.length > 0) {
              const mime = imgObj.mimetype || 'image/jpeg';
              mediaBase64 = `data:${mime};base64,${buffer.toString('base64')}`;
              console.log(`📸 Downloaded WhatsApp photo from ${remoteJid} (${buffer.length} bytes)`);
            }
          } catch (err) {
            console.warn(`Failed to download incoming WhatsApp image (${msg.key?.id}):`, err.message);
          }
        }

        const cleanText = caption.trim();
        // If neither text nor media, skip
        if (!cleanText && !mediaBase64) continue;

        const displayText = cleanText || (isImage ? '[फोटो / Image]' : '');
        console.log(`Message from ${remoteJid}: "${displayText}" ${isImage ? '(Media: YES)' : ''}`);

        if (db) {
          try {
            const doc = {
              msgId: msg.key.id,
              from: remoteJid,
              senderName: msg.pushName || 'Unknown',
              text: displayText,
              caption: cleanText,
              hasMedia: !!mediaBase64,
              mediaType: isImage ? 'image' : null,
              mediaBase64: mediaBase64,
              type: 'incoming',
              timestamp: new Date()
            };
            const insertRes = await db.collection('whatsapp_messages').insertOne(doc);

            // Trigger background Vision AI analysis on Railway runner
            if (mediaBase64 && insertRes.insertedId) {
              fetch(`${RUNNER_URL}/execute`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${RUNNER_TOKEN}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  command: `/root/vision_venv/bin/python3 /root/vision_analyzer.py latest`,
                  timeout: 30000
                })
              }).catch(e => console.warn('Async vision runner trigger error:', e.message));
            }
          } catch(e){
            console.warn('Error saving incoming message to MongoDB:', e.message);
          }
        }

        // ============================================================
        // AI AUTO-REPLY AUTOMATION IS DISABLED!
        // RJN only logs incoming messages and never auto-spams contacts.
        // Outgoing messages are ONLY sent when Boss explicitly commands
        // RJN via the Hologram voice assistant or via the POST /send API.
        // ============================================================
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
    database: { connected: !!db, status: 'secure_active' },
    cloudRunner: { status: 'active' }
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
  // Synthesize from recent messages if chats collection & map are empty
  if (chats.length === 0 && db) {
    try {
      const recentGroups = await db.collection('whatsapp_messages').aggregate([
        { $sort: { timestamp: -1 } },
        { $group: {
            _id: { $ifNull: ["$from", "$to"] },
            lastMessage: { $first: "$text" },
            lastTimestamp: { $first: "$timestamp" },
            senderName: { $first: "$senderName" },
            type: { $first: "$type" }
        }},
        { $sort: { lastTimestamp: -1 } },
        { $limit: 30 }
      ]).toArray();

      chats = recentGroups.map(g => ({
        id: g._id,
        name: g.senderName || g._id,
        lastMessage: g.lastMessage,
        updatedAt: g.lastTimestamp
      }));
    } catch (e) {
      console.warn('Error aggregating chats:', e.message);
    }
  }

  res.json({
    success: true,
    count: chats.length,
    chats
  });
});

// Recent WhatsApp Messages API (Retrieve logged messages)
app.all('/messages', async (req, res) => {
  let msgs = [];
  if (db) {
    try {
      const limit = Math.min(parseInt(req.query.limit || req.body?.limit) || 50, 200);
      const query = {};
      const targetPhone = req.query.phone || req.query.from || req.query.to || req.query.jid || req.body?.phone || req.body?.to;
      if (targetPhone) {
        const clean = String(targetPhone).replace(/[^0-9]/g, '');
        if (clean) {
          query.$or = [
            { from: { $regex: clean } },
            { to: { $regex: clean } }
          ];
        }
      }

      // Filter for media / photo messages if requested
      const onlyMedia = req.query.media === 'true' || req.query.type === 'image' || req.body?.media === true;
      if (onlyMedia) {
        query.$or = [
          { hasMedia: true },
          { mediaType: 'image' },
          { mediaBase64: { $exists: true, $ne: null } }
        ];
      }

      msgs = await db.collection('whatsapp_messages')
        .find(query)
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
    } catch (e) {
      console.warn('Error fetching messages from MongoDB:', e.message);
      return res.status(500).json({ success: false, error: e.message });
    }
  } else {
    return res.status(503).json({ success: false, error: 'Database disconnected' });
  }

  return res.json({
    success: true,
    count: msgs.length,
    messages: msgs
  });
});

// Serve raw image binary for any message with media
app.get('/media/:id', async (req, res) => {
  if (!db) return res.status(503).send('Database not connected');
  try {
    const id = req.params.id;
    let query = { msgId: id };
    try {
      const { ObjectId } = require('mongodb');
      if (ObjectId.isValid(id)) {
        query = { $or: [{ _id: new ObjectId(id) }, { msgId: id }] };
      }
    } catch (e) {}

    const msg = await db.collection('whatsapp_messages').findOne(query);
    if (!msg || !msg.mediaBase64) {
      return res.status(404).send('Media not found');
    }
    const matches = msg.mediaBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(500).send('Invalid media format');
    }
    const mime = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(buffer);
  } catch (err) {
    return res.status(500).send('Error serving media: ' + err.message);
  }
});

// Request New Pairing Code
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
      message: 'WhatsApp is already connected to: ' + (activeUser.id || activeUser.name),
      user: activeUser
    });
  }

  // If already have an active code for this exact phone number, return it immediately
  if (activePairingCode && pairingPhone === cleanPhone) {
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

  // Otherwise trigger fresh start for this phone number
  pairingPhone = cleanPhone;
  activePairingCode = null;
  if (fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch(e){}
  }
  startWhatsApp(cleanPhone);

  return res.json({
    success: true,
    status: 'generating',
    phone: cleanPhone,
    message: 'Pairing code generating. Please check /status in 3 seconds.'
  });
});

// Execute Cloud Command API
app.post('/execute', async (req, res) => {
  const command = req.body?.command || req.query?.command;
  if (!command) {
    return res.status(400).json({ success: false, error: 'Command required' });
  }
  const result = await executeCloudCommand(command);
  return res.json(result);
});

// Send WhatsApp Message or Image API
app.post('/send', async (req, res) => {
  const { to, message, imageUrl, image, caption } = req.body;
  if (!to || (!message && !imageUrl && !image)) {
    return res.status(400).json({ success: false, error: 'Missing "to" and ("message" or "imageUrl") field' });
  }

  if (waStatus !== 'connected' || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected yet' });
  }

  try {
    const rawTo = String(to).replace(/[^0-9]/g, '');
    const jid = rawTo.includes('@') ? rawTo : `${rawTo}@s.whatsapp.net`;
    const imgUrl = (imageUrl || image || '').trim();

    let result;
    if (imgUrl) {
      console.log(`📸 Sending WhatsApp image to ${jid}: ${imgUrl}`);
      result = await sock.sendMessage(jid, {
        image: { url: imgUrl },
        caption: caption || message || ''
      });
    } else {
      console.log(`💬 Sending WhatsApp text to ${jid}: ${message}`);
      result = await sock.sendMessage(jid, { text: message });
    }

    if (db) {
      try {
        await db.collection('whatsapp_messages').insertOne({
          to: jid,
          text: message || caption || (imgUrl ? '[Image Attachment]' : ''),
          imageUrl: imgUrl || null,
          type: 'outgoing',
          timestamp: new Date()
        });
      } catch (e) {}
    }

    return res.json({
      success: true,
      jid,
      messageId: result.key?.id,
      type: imgUrl ? 'image' : 'text'
    });
  } catch (err) {
    console.error('WhatsApp send error:', err);
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
      <p class="subtitle">Baileys Multi-Device • Secure Cloud Sync</p>
    </div>

    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('contactsTab', this)">Contacts Directory</button>
      <button class="tab-btn" onclick="switchTab('messagesTab', this)">Recent Messages</button>
      <button class="tab-btn" onclick="switchTab('systemTab', this)">System Status</button>
    </div>

    <div id="contactsTab" class="tab-content active">
      <input type="text" id="searchBox" class="search-box" placeholder="Search contacts by name or number..." oninput="filterContacts()" />
      <div id="contactsContainer" class="contacts-list">
        <div style="text-align:center; padding:20px; color:var(--subtext);">Loading synced contacts...</div>
      </div>
    </div>

    <div id="messagesTab" class="tab-content">
      <div id="messagesContainer" class="contacts-list">
        <div style="text-align:center; padding:20px; color:var(--subtext);">Loading recent messages...</div>
      </div>
    </div>

    <div id="systemTab" class="tab-content">
      <div class="grid">
        <div class="stat-card">
          <div class="stat-name">Database</div>
          <div class="stat-val">Secure Cloud Database</div>
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

    async function loadMessages() {
      try {
        const res = await fetch('/messages');
        const data = await res.json();
        const msgs = data.messages || [];
        const container = document.getElementById('messagesContainer');
        if (msgs.length === 0) {
          container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--subtext);">No messages logged yet</div>';
          return;
        }
        container.innerHTML = msgs.slice(0, 30).map(m => \`
          <div class="contact-card">
            <div>
              <div class="contact-name">\${m.senderName || m.from || m.to} <span style="font-size:11px; opacity:0.7;">(\${m.type || 'msg'})</span></div>
              <div style="font-size:13px; color:#e2e8f0; margin-top:4px;">\${m.text || ''}</div>
              <div class="contact-phone" style="margin-top:2px;">\${m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : ''}</div>
            </div>
          </div>
        \`).join('');
      } catch(e){}
    }

    loadContacts();
    loadMessages();
    setInterval(loadContacts, 8000);
    setInterval(loadMessages, 5000);
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
