require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

// ─── CRITICAL: Keep Node.js process alive forever ────────────
// This prevents Node from exiting when Chrome/Puppeteer crashes
const _keepAlive = setInterval(() => {}, 1 << 30);

// ─── Global crash guards ─────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION (server kept alive):', err.message);
    console.error(err.stack);
    // DO NOT exit — keep running
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ UNHANDLED REJECTION (server kept alive):', reason);
    // DO NOT exit — keep running
});
process.on('exit', (code) => {
    console.log(`⚠️ Process exit event fired with code: ${code}`);
});
process.on('SIGINT', () => {
    console.log('🛑 Received Ctrl+C. Shutting down...');
    clearInterval(_keepAlive);
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM. Shutting down...');
    clearInterval(_keepAlive);
    process.exit(0);
});

const { initDatabase } = require('./src/database');
const { initScheduler } = require('./src/scheduler');
const apiRoutes = require('./src/routes/api');
const { initWhatsAppClient, addSSEClient } = require('./src/whatsapp-client');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Serve static frontend ─────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ─────────────────────────────────────────────
app.use('/api', apiRoutes);

// ─── WhatsApp Web QR Code SSE ─────────────────────────────────
app.get('/api/qr-stream', addSSEClient);

// ─── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── SPA fallback ────────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('❌ Server Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
});

// ─── Start ──────────────────────────────────────────────────
async function start() {
    await initDatabase();
    console.log('✅ Database initialized');

    initScheduler();
    console.log('✅ Scheduler initialized');

    app.listen(PORT, () => {
        console.log('');
        console.log('╔══════════════════════════════════════════════╗');
        console.log('║   WhatsApp Automation Server Running! 🚀     ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log(`║   Dashboard: http://localhost:${PORT}            ║`);
        console.log(`║   API:       http://localhost:${PORT}/api        ║`);
        console.log(`║   QR Code:   http://localhost:${PORT} (Settings) ║`);
        console.log('╚══════════════════════════════════════════════╝');
        console.log('');
    });

    // Start WhatsApp AFTER server is listening
    initWhatsAppClient();
}

start().catch(err => {
    console.error('❌ Failed to start server:', err);
    // Don't exit — try to keep going
});
