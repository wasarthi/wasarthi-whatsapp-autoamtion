/**
 * One-off helper: list all accounts, or promote one to admin.
 *
 * Usage (run from the project root, e.g. "E:\whatsapp automation"):
 *
 *   node scripts/fix-admin.js
 *       → lists every account with its id, email, role, and status
 *
 *   node scripts/fix-admin.js you@example.com
 *       → promotes that account to role=admin, status=active
 *
 * This talks directly to data/whatsapp.db using the same sql.js library
 * already installed in node_modules — it does not need the server running.
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'data', 'whatsapp.db');

(async () => {
    if (!fs.existsSync(dbPath)) {
        console.error(`No database found at ${dbPath}. Has the server been started at least once?`);
        process.exit(1);
    }

    const SQL = await initSqlJs();
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    const targetEmail = process.argv[2];

    if (!targetEmail) {
        const stmt = db.prepare('SELECT id, email, role, status, business_name FROM users ORDER BY id');
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();

        if (rows.length === 0) {
            console.log('No accounts exist yet. Sign up first, then re-run this script with your email to promote yourself.');
        } else {
            console.log('Accounts on this install:\n');
            for (const r of rows) {
                console.log(`  #${r.id}  ${r.email}   role=${r.role}   status=${r.status}   business="${r.business_name || ''}"`);
            }
            console.log('\nTo make one of these an admin, run:');
            console.log('  node scripts/fix-admin.js <their-email>');
        }
        db.close();
        return;
    }

    const check = db.prepare('SELECT id, email, role FROM users WHERE email = ?');
    check.bind([targetEmail]);
    const found = check.step() ? check.getAsObject() : null;
    check.free();

    if (!found) {
        console.error(`No account found with email "${targetEmail}". Run the script with no arguments to see the list of accounts.`);
        db.close();
        process.exit(1);
    }

    db.run('UPDATE users SET role = ?, status = ? WHERE email = ?', ['admin', 'active', targetEmail]);
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    db.close();

    console.log(`Done — account #${found.id} (${targetEmail}) is now role=admin, status=active.`);
    console.log('Log out and log back in (or just refresh /admin) for it to take effect.');
})().catch(err => {
    console.error('Failed:', err);
    process.exit(1);
});
