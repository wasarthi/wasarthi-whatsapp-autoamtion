require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');

// ─── CRITICAL: Keep Node.js process alive forever ─────────────
// Prevents Node from exiting when Puppeteer/Chrome crashes
const _keepAlive = setInterval(() => {}, 1 << 30);

// ─── Global crash guards ──────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION (process kept alive):', err.message);
    console.error(err.stack);
    // Do NOT call process.exit() — keep the server running
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('❌ UNHANDLED REJECTION (process kept alive):', msg);
    // Do NOT call process.exit()
});

process.on('SIGINT', () => {
    console.log('\n🛑 Received Ctrl+C. Shutting down gracefully...');
    clearInterval(_keepAlive);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM. Shutting down gracefully...');
    clearInterval(_keepAlive);
    process.exit(0);
});

// ─── App setup ────────────────────────────────────────────────
const { initDatabase }                      = require('./src/database');
const { initScheduler }                     = require('./src/scheduler');
const apiRoutes                             = require('./src/routes/api');
const { initWhatsAppClient, addSSEClient }  = require('./src/whatsapp-client');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── Static frontend ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API routes ───────────────────────────────────────────────
app.use('/api', apiRoutes);

// ─── SSE stream for QR code / connection status ───────────────
app.get('/api/qr-stream', addSSEClient);

// ─── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()), pid: process.pid });
});

// ─── SPA fallback (must be last) ──────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Express error handler ────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('❌ Express error:', err.message);
    if (res.headersSent) return next(err);
    res.status(500).json({ success: false, error: err.message });
});

// ─── Start ────────────────────────────────────────────────────
async function start() {
    try {
        await initDatabase();
        console.log('✅ Database initialized');
    } catch (dbErr) {
        // Database failure is fatal — let launcher restart us
        console.error('❌ Database init failed:', dbErr.message);
        process.exit(1);
    }

    try {
        initScheduler();
        console.log('✅ Scheduler initialized');
    } catch (schedErr) {
        console.error('⚠️ Scheduler init failed (non-fatal):', schedErr.message);
    }

    await new Promise((resolve, reject) => {
        const server = app.listen(PORT, resolve);
        server.on('error', reject);
    });

    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   WhatsApp Automation Server Running! 🚀     ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║   Dashboard: http://localhost:${PORT}            ║`);
    console.log(`║   API:       http://localhost:${PORT}/api        ║`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');

    // Start WhatsApp AFTER HTTP server is listening so the dashboard is always accessible
    try {
        initWhatsAppClient();
    } catch (waErr) {
        console.error('⚠️ WhatsApp client init threw synchronously (will auto-retry):', waErr.message);
    }
}

start().catch(err => {
    console.error('❌ Fatal server start error:', err.message);
    process.exit(1);   // Let launcher restart with back-off
});
