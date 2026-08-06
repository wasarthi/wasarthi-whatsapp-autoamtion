/**
 * launcher.js — Crash-proof wrapper for server.js
 * Automatically restarts the server if it ever exits for any reason.
 */
const { spawn } = require('child_process');
const path = require('path');

let restartCount = 0;
let lastStartTime = Date.now();

function startServer() {
    restartCount++;
    lastStartTime = Date.now();
    console.log(`\n🚀 [Launcher] Starting server... (attempt #${restartCount})`);

    const child = spawn('node', ['server.js'], {
        cwd: __dirname,
        stdio: 'inherit',   // share terminal output
        env: { ...process.env }
    });

    child.on('error', (err) => {
        console.error('[Launcher] Failed to spawn server:', err.message);
        scheduleRestart();
    });

    child.on('exit', (code, signal) => {
        const uptime = ((Date.now() - lastStartTime) / 1000).toFixed(1);
        console.log(`\n⚠️  [Launcher] Server exited after ${uptime}s (code=${code}, signal=${signal})`);
        scheduleRestart();
    });
}

function scheduleRestart() {
    // Back-off: if it crashed in under 10s, wait 5s; otherwise restart immediately
    const uptime = Date.now() - lastStartTime;
    const delay = uptime < 10000 ? 5000 : 2000;
    console.log(`🔄 [Launcher] Restarting in ${delay / 1000}s...`);
    setTimeout(startServer, delay);
}

// Handle Ctrl+C on the launcher itself
process.on('SIGINT', () => {
    console.log('\n🛑 [Launcher] Shutting down...');
    process.exit(0);
});

startServer();
