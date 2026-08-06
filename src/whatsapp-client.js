const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { processMessage } = require('./chatbot');

let client;
let currentQR = null;
let isConnected = false;
let sseClients = [];
let keepAliveTimer = null;
let watchdogTimer = null;
let isInitializing = false;

function broadcastSSE(data) {
    const dead = [];
    sseClients.forEach(c => {
        try { c.res.write(`data: ${JSON.stringify(data)}\n\n`); }
        catch (e) { dead.push(c); }
    });
    sseClients = sseClients.filter(c => !dead.includes(c));
}

function clearTimers() {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    if (watchdogTimer)  { clearInterval(watchdogTimer);  watchdogTimer  = null; }
}

function scheduleRestart(delayMs = 8000) {
    clearTimers();
    console.log(`🔄 Scheduling WhatsApp client restart in ${delayMs / 1000}s...`);
    setTimeout(() => {
        isInitializing = false;
        initWhatsAppClient();
    }, delayMs);
}

function initWhatsAppClient() {
    if (isInitializing) {
        console.log('⏳ Already initializing, skipping duplicate call.');
        return;
    }
    isInitializing = true;
    clearTimers();

    console.log('🔧 Starting WhatsApp Web client...');

    try {
        client = new Client({
            authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
            restartOnAuthFail: true,
            takeoverOnConflict: true,
            takeoverTimeoutMs: 0,
            webVersionCache: {
                type: 'local',
            },
            puppeteer: {
                headless: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--disable-extensions',
                    '--window-position=-10000,0',
                    '--window-size=1,1'
                ]
            }
        });
    } catch (err) {
        console.error('❌ Failed to create WhatsApp client:', err.message);
        scheduleRestart();
        return;
    }

    client.on('qr', async (qr) => {
        console.log('📱 QR Code ready — open dashboard to scan.');
        isConnected = false;
        try {
            currentQR = await qrcode.toDataURL(qr);
            broadcastSSE({ type: 'qr', data: currentQR });
        } catch (err) {
            console.error('Failed to generate QR data URL:', err.message);
        }
    });

    client.on('authenticated', () => {
        console.log('✅ WhatsApp Authenticated!');
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Client is READY! AI persona is active.');
        isConnected = true;
        isInitializing = false;
        currentQR = null;

        try {
            broadcastSSE({ type: 'ready', phone: client.info?.wid?.user || 'unknown' });
        } catch (e) {}

        // Keep-alive: poll state every 25s
        clearTimers();
        keepAliveTimer = setInterval(async () => {
            try {
                const state = await client.getState();
                if (state !== 'CONNECTED') {
                    console.warn('⚠️ WhatsApp state is', state, '— forcing reconnect.');
                    scheduleRestart(3000);
                }
            } catch (e) {
                console.warn('⚠️ Keep-alive check failed:', e.message);
                scheduleRestart(5000);
            }
        }, 25000);

        // Watchdog: if we lose connection, restart
        watchdogTimer = setInterval(() => {
            if (!isConnected && !isInitializing) {
                console.warn('🐕 Watchdog: not connected and not initializing — restarting.');
                scheduleRestart(3000);
            }
        }, 60000);
    });

    client.on('auth_failure', msg => {
        console.error('❌ WhatsApp Auth failure:', msg);
        isConnected = false;
        isInitializing = false;
        broadcastSSE({ type: 'error', data: 'Authentication Failed' });
        scheduleRestart(10000);
    });

    client.on('disconnected', (reason) => {
        console.log('❌ WhatsApp disconnected:', reason);
        isConnected = false;
        isInitializing = false;
        currentQR = null;
        broadcastSSE({ type: 'disconnected' });
        scheduleRestart(5000);
    });

    // Catch Puppeteer/browser-level errors
    client.on('error', (err) => {
        console.error('❌ WhatsApp client error:', err?.message || err);
    });

    client.on('message', async msg => {
        console.log('\n📨 Message received');
        console.log('   From:', msg.from);
        console.log('   Body:', msg.body);
        console.log('   isStatus:', msg.isStatus, '| type:', msg.type);

        if (msg.isGroupMsg || msg.isStatus || msg.from.endsWith('@g.us')) {
            console.log('   ⏭️ Skipping: group or status message');
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

        console.log(`   ✅ Processing: "${msg.body}" from ${contactName || phone}`);

        try {
            const result = await processMessage(phone, msg.body, contactName, client, msg);
            console.log('   📤 Result:', JSON.stringify(result));
        } catch (error) {
            console.error('   ❌ processMessage error:', error.message);
        }
    });

    client.on('message_create', msg => {
        if (msg.fromMe) console.log('📤 Bot sent:', msg.body?.substring(0, 60));
    });

    console.log('Initializing WhatsApp Web client...');
    client.initialize().catch(err => {
        console.error('❌ client.initialize() threw:', err.message);
        isInitializing = false;
        scheduleRestart(10000);
    });
}

function addSSEClient(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    sseClients.push({ req, res });

    if (isConnected && client?.info) {
        res.write(`data: ${JSON.stringify({ type: 'ready', phone: client.info.wid.user })}\n\n`);
    } else if (currentQR) {
        res.write(`data: ${JSON.stringify({ type: 'qr', data: currentQR })}\n\n`);
    } else {
        res.write(`data: ${JSON.stringify({ type: 'loading' })}\n\n`);
    }

    req.on('close', () => {
        sseClients = sseClients.filter(c => c.req !== req);
    });
}

function getClient()  { return client; }
function getStatus()  { return { connected: isConnected, phone: isConnected && client?.info ? client.info.wid.user : null }; }

async function sendTextMessage(phone, text) {
    if (!isConnected || !client) throw new Error('WhatsApp client is not connected');
    const chatId = `${phone}@c.us`;
    await client.sendMessage(chatId, text);
}

module.exports = { initWhatsAppClient, addSSEClient, getClient, getStatus, sendTextMessage };
