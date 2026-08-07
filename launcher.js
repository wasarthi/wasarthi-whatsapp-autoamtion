/**
 * launcher.js — Crash-proof wrapper for server.js
 * Uses exponential back-off so a boot-loop doesn't hammer the system.
 */
const { spawn } = require('child_process');

let restartCount  = 0;
let lastStartTime = Date.now();

// Exponential back-off: 2s → 4s → 8s → 16s → 30s (cap)
function backoffDelay(attempt) {
    return Math.min(2000 * Math.pow(2, attempt - 1), 30000);
}

function startServer() {
    restartCount++;
    lastStartTime = Date.now();
    console.log(`\n🚀 [Launcher] Starting server... (attempt #${restartCount})`);

    const child = spawn('node', ['server.js'], {
        cwd: __dirname,
        stdio: 'inherit',
        env: { ...process.env }
    });

    child.on('error', (err) => {
        console.error('[Launcher] Failed to spawn server:', err.message);
        scheduleRestart();
    });

    child.on('exit', (code, signal) => {
        const uptime = ((Date.now() - lastStartTime) / 1000).toFixed(1);

        // If process was alive for > 60s, treat it as a "clean" run and reset back-off
        if (Date.now() - lastStartTime > 60000) {
            restartCount = 0;
        }

        // SIGINT = user pressed Ctrl+C on the launcher, don't restart
        if (signal === 'SIGINT' || code === 0) {
            console.log(`\n🛑 [Launcher] Server exited cleanly (code=${code}, signal=${signal}). Not restarting.`);
            process.exit(0);
        }

        console.log(`\n⚠️  [Launcher] Server crashed after ${uptime}s (code=${code}, signal=${signal})`);
        scheduleRestart();
    });
}

function scheduleRestart() {
    const delay = backoffDelay(restartCount);
    console.log(`🔄 [Launcher] Restarting in ${(delay / 1000).toFixed(0)}s... (attempt ${restartCount})`);
    setTimeout(startServer, delay);
}

// Ctrl+C on the launcher shuts everything down
process.on('SIGINT', () => {
    console.log('\n🛑 [Launcher] Shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 [Launcher] SIGTERM received, shutting down...');
    process.exit(0);
});

startServer();
