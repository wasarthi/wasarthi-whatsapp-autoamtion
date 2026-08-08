/**
 * make-admin.js — promote an existing account to the admin role.
 *
 * The very first account ever created becomes admin automatically. This is
 * the escape hatch for every other case: you signed up a second time and got
 * logged in as the new (non-admin) account, you want a second admin, or the
 * original admin row lost its role somehow.
 *
 * Usage (from the project root, with the server stopped):
 *   node make-admin.js you@example.com
 *
 * Stop the server first. The app keeps the whole database in memory and
 * rewrites the file on every save, so a running server would overwrite this
 * change the next time anything is written.
 */

const path = require('path');
const db = require(path.join(__dirname, 'src', 'database'));

(async () => {
    const email = (process.argv[2] || '').trim().toLowerCase();
    if (!email) {
        console.error('Usage: node make-admin.js you@example.com');
        process.exit(1);
    }

    await db.initDatabase();

    const user = db.getUserByEmail(email);
    if (!user) {
        console.error(`No account found with email "${email}".`);
        console.error('Run "node check-users.js" to see which accounts exist.');
        process.exit(1);
    }

    if (user.role === 'admin') {
        console.log(`#${user.id} ${user.email} is already an admin — nothing to change.`);
        process.exit(0);
    }

    db.updateUser(user.id, { role: 'admin' });
    const after = db.getUserById(user.id);

    console.log(`\n✅ #${after.id} ${after.email} is now role="${after.role}".`);
    console.log('Start the server, log in as that account, and the Admin item');
    console.log('appears in the sidebar (or go straight to /admin).\n');
})();
