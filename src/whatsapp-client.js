const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs     = require('fs');
const path   = require('path');
const { processMessage } = require('./chatbot');

// ─── Stale lock-file cleanup ──────────────────────────────────
// If Chrome crashes it leaves a SingletonLock file that blocks the next launch.
function clearStaleLocks() {
    const authDir   = path.join(__dirname, '..', '.wwebjs_auth');
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    try {
        const sessions = fs.readdirSync(authDir);
        for (const sess of sessions) {
            for (const lockFile of lockFiles) {
                const p = path.join(authDir, sess, lockFile);
                if (fs.existsSync(p)) {
                    fs.rmSync(p, { force: true });
                    console.log(`🧹 Removed stale lock: ${p}`);
                }
            }
        }
    } catch (e) {
        // Auth dir may not exist yet on first run — that's fine
    }
}

let client = null;
let currentQR = null;
let isConnected = false;
let sseClients = [];
let keepAliveTimer = null;
let watchdogTimer = null;
let isInitializing = false;
let restartTimer = null;
let crashCount = 0;
let lastCrashTime = Date.now();

// ─── SSE broadcast ───────────────────────────────────────────
function broadcastSSE(data) {
    const dead = [];
    sseClients.forEach(c => {
        try { c.res.write(`data: ${JSON.stringify(data)}\n\n`); }
        catch (e) { dead.push(c); }
    });
    sseClients = sseClients.filter(c => !dead.includes(c));
}

// ─── Timers ───────────────────────────────────────────────────
function clearTimers() {
    if (keepAliveTimer) { clearInterval(keepAliveTimer);  keepAliveTimer = null; }
    if (watchdogTimer)  { clearInterval(watchdogTimer);   watchdogTimer  = null; }
    if (restartTimer)   { clearTimeout(restartTimer);     restartTimer   = null; }
}

// ─── Safe client destroy ──────────────────────────────────────
async function safeDestroyClient() {
    if (!client) return;
    const c = client;
    client = null;
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
function scheduleRestart(baseDelayMs = 8000) {
    clearTimers();
    isConnected   = false;
    isInitializing = false;

    // Exponential back-off: double delay every 3 crashes, cap at 60s
    const now = Date.now();
    if (now - lastCrashTime < 30000) {
        crashCount = Math.min(crashCount + 1, 6);
    } else {
        crashCount = 0;
    }
    lastCrashTime = now;

    const backoff = Math.min(baseDelayMs * Math.pow(2, Math.floor(crashCount / 3)), 60000);
    console.log(`🔄 Scheduling WhatsApp restart in ${(backoff / 1000).toFixed(0)}s (crash #${crashCount})...`);

    broadcastSSE({ type: 'disconnected' });

    restartTimer = setTimeout(async () => {
        await safeDestroyClient();
        isInitializing = false;
        initWhatsAppClient();
    }, backoff);
}

// ─── Main init ────────────────────────────────────────────────
function initWhatsAppClient() {
    if (isInitializing) {
        console.log('⏳ Already initializing, skipping duplicate call.');
        return;
    }
    isInitializing = true;
    clearTimers();

    console.log('🔧 Starting WhatsApp Web client...');
    broadcastSSE({ type: 'loading' });

    // Remove any stale Chrome lock files from previous crashes
    clearStaleLocks();

    try {
        client = new Client({
            authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
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
        console.error('❌ Failed to create WhatsApp client:', err.message);
        isInitializing = false;
        scheduleRestart(10000);
        return;
    }

    // ── QR ──────────────────────────────────────────────────
    client.on('qr', async (qr) => {
        console.log('📱 QR Code ready — open dashboard Settings → WhatsApp QR to scan.');
        isConnected = false;
        try {
            currentQR = await qrcode.toDataURL(qr);
            broadcastSSE({ type: 'qr', data: currentQR });
        } catch (err) {
            console.error('Failed to generate QR data URL:', err.message);
        }
    });

    // ── Auth ────────────────────────────────────────────────
    client.on('authenticated', () => {
        console.log('✅ WhatsApp Authenticated!');
        currentQR = null;
    });

    // ── Ready ───────────────────────────────────────────────
    client.on('ready', () => {
        console.log('✅ WhatsApp Client is READY!');
        isConnected    = true;
        isInitializing = false;
        currentQR      = null;
        crashCount     = 0;        // reset back-off on successful connect

        try {
            broadcastSSE({ type: 'ready', phone: client.info?.wid?.user || 'unknown' });
        } catch (e) {}

        clearTimers();

        // Keep-alive: check state every 30s
        keepAliveTimer = setInterval(async () => {
            try {
                const state = await Promise.race([
                    client.getState(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('getState timeout')), 5000))
                ]);
                if (state !== 'CONNECTED') {
                    console.warn('⚠️ WhatsApp state is', state, '— scheduling reconnect.');
                    scheduleRestart(5000);
                }
            } catch (e) {
                // Only restart if it's a real disconnection, not just a transient Puppeteer hiccup
                const msg = e.message || '';
                const isTransient = msg.includes('Execution context') || msg.includes('Target closed') || msg.includes('timeout');
                if (isTransient) {
                    console.warn('⚠️ Keep-alive transient error (will retry next interval):', msg.split('\n')[0]);
                } else {
                    console.warn('⚠️ Keep-alive fatal error:', msg.split('\n')[0]);
                    scheduleRestart(5000);
                }
            }
        }, 30000);

        // Watchdog: restart if we silently lose connection
        watchdogTimer = setInterval(() => {
            if (!isConnected && !isInitializing && !restartTimer) {
                console.warn('🐕 Watchdog: not connected and not restarting — triggering restart.');
                scheduleRestart(5000);
            }
        }, 90000);
    });

    // ── Auth failure ─────────────────────────────────────────
    client.on('auth_failure', msg => {
        console.error('❌ WhatsApp Auth failure:', msg);
        isConnected    = false;
        isInitializing = false;
        broadcastSSE({ type: 'error', data: 'Authentication Failed' });
        scheduleRestart(15000);
    });

    // ── Disconnected ─────────────────────────────────────────
    client.on('disconnected', (reason) => {
        console.log('❌ WhatsApp disconnected:', reason);
        isConnected    = false;
        isInitializing = false;
        currentQR      = null;
        scheduleRestart(8000);
    });

    // ── Client error (Puppeteer level) ───────────────────────
    client.on('error', (err) => {
        const msg = err?.message || String(err);
        // Ignore noisy Puppeteer/protocol errors that auto-recover
        const ignorable = ['Target closed', 'Session closed', 'Execution context', 'Protocol error'];
        if (ignorable.some(s => msg.includes(s))) {
            console.warn('⚠️ Ignorable Puppeteer error:', msg.split('\n')[0]);
            return;
        }
        console.error('❌ WhatsApp client error:', msg.split('\n')[0]);
    });

    // ── Incoming message ─────────────────────────────────────
    client.on('message', async msg => {
        console.log('\n📨 Message received from:', msg.from, '| type:', msg.type);

        // Filters
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

        // Wrap in timeout so a hung AI call can't block the event loop forever
        try {
            await Promise.race([
                processMessage(phone, msg.body, contactName, client, msg),
                new Promise((_, rej) => setTimeout(() => rej(new Error('processMessage timeout after 45s')), 45000))
            ]);
        } catch (error) {
            console.error('   ❌ processMessage error (non-fatal):', error.message?.split('\n')[0]);
        }
    });

    client.on('message_create', msg => {
        if (msg.fromMe) console.log('📤 Bot sent:', msg.body?.substring(0, 60));
    });

    // ── Initialize ───────────────────────────────────────────
    console.log('⏳ Initializing WhatsApp Web client...');
    client.initialize().catch(err => {
        console.error('❌ client.initialize() error:', err.message?.split('\n')[0]);
        isInitializing = false;
        scheduleRestart(12000);
    });
}

// ─── SSE client handler ───────────────────────────────────────
function addSSEClient(req, res) {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');   // nginx fix

    sseClients.push({ req, res });

    // Send current state immediately
    if (isConnected && client?.info) {
        res.write(`data: ${JSON.stringify({ type: 'ready', phone: client.info.wid.user })}\n\n`);
    } else if (currentQR) {
        res.write(`data: ${JSON.stringify({ type: 'qr', data: currentQR })}\n\n`);
    } else {
        res.write(`data: ${JSON.stringify({ type: 'loading' })}\n\n`);
    }

    // Heartbeat to keep the connection alive through proxies
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
    }, 20000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients = sseClients.filter(c => c.req !== req);
    });
}

// ─── Exports ─────────────────────────────────────────────────
function getClient() { return client; }
function getStatus() {
    return {
        connected: isConnected,
        phone: isConnected && client?.info ? client.info.wid.user : null
    };
}

async function sendTextMessage(phone, text) {
    if (!isConnected || !client) throw new Error('WhatsApp client is not connected');
    const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
    return await client.sendMessage(chatId, text);
}

module.exports = { initWhatsAppClient, addSSEClient, getClient, getStatus, sendTextMessage };
