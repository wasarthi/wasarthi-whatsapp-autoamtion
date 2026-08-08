const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs     = require('fs');
const path   = require('path');
const { processMessage } = require('./chatbot');

// ─── Per-user session registry ─────────────────────────────────
// Each signed-up account gets its own isolated whatsapp-web.js Client,
// its own LocalAuth session folder, its own QR/connection state, and its
// own set of SSE listeners — so scanning a QR code for one account never
// touches another account's WhatsApp number.
const sessions = new Map(); // userId -> session state object

// Each live WhatsApp session spins up its own headless Chrome (Puppeteer)
// process. Since signup is open (no email verification/CAPTCHA), a cap keeps
// a burst of new accounts from exhausting server memory/CPU. Raise via env
// var if you're running on a bigger box; 0 or unset uses the default below.
const MAX_CONCURRENT_SESSIONS = parseInt(process.env.MAX_CONCURRENT_WHATSAPP_SESSIONS, 10) || 25;

function countActiveSessions() {
    let n = 0;
    for (const s of sessions.values()) {
        if (s.client || s.isInitializing) n++;
    }
    return n;
}

function authDataPath(userId) {
    return path.join(__dirname, '..', '.wwebjs_auth', `user_${userId}`);
}

function newSessionState() {
    return {
        client: null,
        currentQR: null,
        isConnected: false,
        sseClients: [],
        keepAliveTimer: null,
        watchdogTimer: null,
        isInitializing: false,
        restartTimer: null,
        crashCount: 0,
        lastCrashTime: Date.now()
    };
}

function getSession(userId, createIfMissing = true) {
    if (!sessions.has(userId) && createIfMissing) {
        sessions.set(userId, newSessionState());
    }
    return sessions.get(userId);
}

// ─── Stale lock-file cleanup ──────────────────────────────────
// If Chrome crashes it leaves a SingletonLock file that blocks the next launch.
function clearStaleLocks(userId) {
    const authDir   = authDataPath(userId);
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    try {
        if (!fs.existsSync(authDir)) return;
        const sessionDirs = fs.readdirSync(authDir);
        for (const sess of sessionDirs) {
            for (const lockFile of lockFiles) {
                const p = path.join(authDir, sess, lockFile);
                if (fs.existsSync(p)) {
                    fs.rmSync(p, { force: true });
                    console.log(`🧹 [user ${userId}] Removed stale lock: ${p}`);
                }
            }
        }
    } catch (e) {
        // Auth dir may not exist yet on first run — that's fine
    }
}

// ─── SSE broadcast (scoped to one user's listeners) ────────────
function broadcastSSE(userId, data) {
    const s = getSession(userId, false);
    if (!s) return;
    const dead = [];
    s.sseClients.forEach(c => {
        try { c.res.write(`data: ${JSON.stringify(data)}\n\n`); }
        catch (e) { dead.push(c); }
    });
    s.sseClients = s.sseClients.filter(c => !dead.includes(c));
}

// ─── Timers ───────────────────────────────────────────────────
function clearTimers(s) {
    if (s.keepAliveTimer) { clearInterval(s.keepAliveTimer); s.keepAliveTimer = null; }
    if (s.watchdogTimer)  { clearInterval(s.watchdogTimer);  s.watchdogTimer  = null; }
    if (s.restartTimer)   { clearTimeout(s.restartTimer);    s.restartTimer   = null; }
}

// ─── Safe client destroy ──────────────────────────────────────
async function safeDestroyClient(s) {
    if (!s.client) return;
    const c = s.client;
    s.client = null;
    try {
        await Promise.race([
            c.destroy(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('destroy timeout')), 8000))
        ]);
    } catch (e) {
        console.warn('⚠️ client.destroy() warning (non-fatal):', e.message?.split('\n')[0]);
    }
}

// ─── Exponential back-off restart ────────────────────────────
function scheduleRestart(userId, baseDelayMs = 8000) {
    const s = getSession(userId);
    clearTimers(s);
    s.isConnected    = false;
    s.isInitializing = false;

    const now = Date.now();
    if (now - s.lastCrashTime < 30000) {
        s.crashCount = Math.min(s.crashCount + 1, 6);
    } else {
        s.crashCount = 0;
    }
    s.lastCrashTime = now;

    const backoff = Math.min(baseDelayMs * Math.pow(2, Math.floor(s.crashCount / 3)), 60000);
    console.log(`🔄 [user ${userId}] Scheduling WhatsApp restart in ${(backoff / 1000).toFixed(0)}s (crash #${s.crashCount})...`);

    broadcastSSE(userId, { type: 'disconnected' });

    s.restartTimer = setTimeout(async () => {
        await safeDestroyClient(s);
        s.isInitializing = false;
        initWhatsAppClient(userId);
    }, backoff);
}

// ─── Main init (per user) ───────────────────────────────────────
function initWhatsAppClient(userId) {
    userId = Number(userId);
    if (!userId) throw new Error('initWhatsAppClient requires a userId');
    const s = getSession(userId);

    if (s.isInitializing) {
        console.log(`⏳ [user ${userId}] Already initializing, skipping duplicate call.`);
        return;
    }
    if (s.isConnected && s.client) {
        console.log(`✅ [user ${userId}] Already connected, skipping re-init.`);
        return;
    }
    if (!s.client && !s.isInitializing && countActiveSessions() >= MAX_CONCURRENT_SESSIONS) {
        console.warn(`⚠️ [user ${userId}] Refusing to start WhatsApp client — server is at the concurrent-session limit (${MAX_CONCURRENT_SESSIONS}).`);
        broadcastSSE(userId, { type: 'error', data: 'Server is at capacity for concurrent WhatsApp connections right now. Please try again shortly.' });
        return;
    }
    s.isInitializing = true;
    clearTimers(s);

    console.log(`🔧 [user ${userId}] Starting WhatsApp Web client...`);
    broadcastSSE(userId, { type: 'loading' });

    clearStaleLocks(userId);

    try {
        s.client = new Client({
            authStrategy: new LocalAuth({ dataPath: authDataPath(userId) }),
            restartOnAuthFail: true,
            takeoverOnConflict: true,
            takeoverTimeoutMs: 0,
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
            },
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            }
        });
    } catch (err) {
        console.error(`❌ [user ${userId}] Failed to create WhatsApp client:`, err.message);
        s.isInitializing = false;
        scheduleRestart(userId, 10000);
        return;
    }

    const client = s.client;

    // ── QR ──────────────────────────────────────────────────
    client.on('qr', async (qr) => {
        console.log(`📱 [user ${userId}] QR Code ready — open Settings → WhatsApp QR to scan.`);
        s.isConnected = false;
        try {
            s.currentQR = await qrcode.toDataURL(qr);
            broadcastSSE(userId, { type: 'qr', data: s.currentQR });
        } catch (err) {
            console.error(`[user ${userId}] Failed to generate QR data URL:`, err.message);
        }
    });

    // ── Auth ────────────────────────────────────────────────
    client.on('authenticated', () => {
        console.log(`✅ [user ${userId}] WhatsApp Authenticated!`);
        s.currentQR = null;
    });

    // ── Ready ───────────────────────────────────────────────
    client.on('ready', () => {
        console.log(`✅ [user ${userId}] WhatsApp Client is READY!`);
        s.isConnected    = true;
        s.isInitializing = false;
        s.currentQR      = null;
        s.crashCount     = 0;

        try {
            broadcastSSE(userId, { type: 'ready', phone: client.info?.wid?.user || 'unknown' });
        } catch (e) {}

        clearTimers(s);

        s.keepAliveTimer = setInterval(async () => {
            try {
                const state = await Promise.race([
                    client.getState(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('getState timeout')), 5000))
                ]);
                if (state !== 'CONNECTED') {
                    console.warn(`⚠️ [user ${userId}] WhatsApp state is`, state, '— scheduling reconnect.');
                    scheduleRestart(userId, 5000);
                }
            } catch (e) {
                const msg = e.message || '';
                const isTransient = msg.includes('Execution context') || msg.includes('Target closed') || msg.includes('timeout');
                if (isTransient) {
                    console.warn(`⚠️ [user ${userId}] Keep-alive transient error (will retry next interval):`, msg.split('\n')[0]);
                } else {
                    console.warn(`⚠️ [user ${userId}] Keep-alive fatal error:`, msg.split('\n')[0]);
                    scheduleRestart(userId, 5000);
                }
            }
        }, 30000);

        s.watchdogTimer = setInterval(() => {
            if (!s.isConnected && !s.isInitializing && !s.restartTimer) {
                console.warn(`🐕 [user ${userId}] Watchdog: not connected and not restarting — triggering restart.`);
                scheduleRestart(userId, 5000);
            }
        }, 90000);
    });

    // ── Auth failure ─────────────────────────────────────────
    client.on('auth_failure', msg => {
        console.error(`❌ [user ${userId}] WhatsApp Auth failure:`, msg);
        s.isConnected    = false;
        s.isInitializing = false;
        broadcastSSE(userId, { type: 'error', data: 'Authentication Failed' });
        scheduleRestart(userId, 15000);
    });

    // ── Disconnected ─────────────────────────────────────────
    client.on('disconnected', (reason) => {
        console.log(`❌ [user ${userId}] WhatsApp disconnected:`, reason);
        s.isConnected    = false;
        s.isInitializing = false;
        s.currentQR      = null;
        scheduleRestart(userId, 8000);
    });

    // ── Client error (Puppeteer level) ───────────────────────
    client.on('error', (err) => {
        const msg = err?.message || String(err);
        const ignorable = ['Target closed', 'Session closed', 'Execution context', 'Protocol error'];
        if (ignorable.some(s2 => msg.includes(s2))) {
            console.warn(`⚠️ [user ${userId}] Ignorable Puppeteer error:`, msg.split('\n')[0]);
            return;
        }
        console.error(`❌ [user ${userId}] WhatsApp client error:`, msg.split('\n')[0]);
    });

    // ── Incoming message ─────────────────────────────────────
    client.on('message', async msg => {
        console.log(`\n📨 [user ${userId}] Message received from:`, msg.from, '| type:', msg.type);

        if (msg.isGroupMsg || msg.isStatus || msg.from.endsWith('@g.us')) {
            console.log('   ⏭️ Skipping: group / status message');
            return;
        }
        if (!msg.body || msg.body.trim() === '') {
            console.log('   ⏭️ Skipping: empty body');
            return;
        }
        if (msg.fromMe) {
            console.log('   ⏭️ Skipping: sent by me');
            return;
        }

        const phone = msg.from.split('@')[0];
        let contactName = '';
        try {
            const contact = await msg.getContact();
            contactName = contact?.pushname || contact?.name || '';
        } catch (e) {
            console.log('   ⚠️ Could not fetch contact name (non-fatal)');
        }

        console.log(`   ✅ Processing from ${contactName || phone}: "${msg.body?.substring(0, 80)}"`);

        try {
            await Promise.race([
                processMessage(userId, phone, msg.body, contactName, client, msg),
                new Promise((_, rej) => setTimeout(() => rej(new Error('processMessage timeout after 45s')), 45000))
            ]);
        } catch (error) {
            console.error('   ❌ processMessage error (non-fatal):', error.message?.split('\n')[0]);
        }
    });

    client.on('message_create', msg => {
        if (msg.fromMe) console.log(`📤 [user ${userId}] Bot sent:`, msg.body?.substring(0, 60));
    });

    // ── Initialize ───────────────────────────────────────────
    console.log(`⏳ [user ${userId}] Initializing WhatsApp Web client...`);
    client.initialize().catch(err => {
        console.error(`❌ [user ${userId}] client.initialize() error:`, err.message?.split('\n')[0]);
        s.isInitializing = false;
        scheduleRestart(userId, 12000);
    });
}

// ─── Tear down a user's session entirely (suspend / delete) ───
async function destroyClientForUser(userId) {
    userId = Number(userId);
    const s = getSession(userId, false);
    if (!s) return;
    clearTimers(s);
    s.isConnected = false;
    s.isInitializing = false;
    s.currentQR = null;
    broadcastSSE(userId, { type: 'disconnected' });
    // Close any open SSE streams for this user
    s.sseClients.forEach(c => { try { c.res.end(); } catch (e) {} });
    s.sseClients = [];
    await safeDestroyClient(s);
    sessions.delete(userId);
}

// ─── SSE client handler (scoped per user) ──────────────────────
function addSSEClient(userId, req, res) {
    userId = Number(userId);
    const s = getSession(userId);

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    s.sseClients.push({ req, res });

    if (s.isConnected && s.client?.info) {
        res.write(`data: ${JSON.stringify({ type: 'ready', phone: s.client.info.wid.user })}\n\n`);
    } else if (s.currentQR) {
        res.write(`data: ${JSON.stringify({ type: 'qr', data: s.currentQR })}\n\n`);
    } else {
        res.write(`data: ${JSON.stringify({ type: 'loading' })}\n\n`);
        // Nothing has been started for this user yet — kick off a lazy connect.
        if (!s.isInitializing && !s.client) {
            initWhatsAppClient(userId);
        }
    }

    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
    }, 20000);

    req.on('close', () => {
        clearInterval(heartbeat);
        s.sseClients = s.sseClients.filter(c => c.req !== req);
    });
}

// ─── Exports ─────────────────────────────────────────────────
function getClient(userId) {
    const s = getSession(Number(userId), false);
    return s ? s.client : null;
}

function getStatus(userId) {
    const s = getSession(Number(userId), false);
    if (!s) return { connected: false, phone: null, started: false };
    return {
        connected: s.isConnected,
        phone: s.isConnected && s.client?.info ? s.client.info.wid.user : null,
        started: !!(s.client || s.isInitializing)
    };
}

async function sendTextMessage(userId, phone, text) {
    const s = getSession(Number(userId), false);
    if (!s || !s.isConnected || !s.client) throw new Error('WhatsApp client is not connected');
    const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
    return await s.client.sendMessage(chatId, text);
}

module.exports = { initWhatsAppClient, destroyClientForUser, addSSEClient, getClient, getStatus, sendTextMessage };
