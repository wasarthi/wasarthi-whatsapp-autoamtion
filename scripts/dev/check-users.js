/**
 * check-users.js — read-only diagnostic.
 *
 * Prints every account row the app's database actually contains, plus which
 * file it read them from. Nothing is written or changed.
 *
 * Run from the project root:
 *   node check-users.js
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data', 'whatsapp.db');

(async () => {
    console.log('Database file : ' + dbPath);

    if (!fs.existsSync(dbPath)) {
        console.log('\n>> That file does not exist.');
        console.log('   The server is writing its database somewhere else, which means');
        console.log('   you are starting it from a different folder than this one.');
        console.log('   Run "npm start" from this same folder and try again.');
        return;
    }

    const stat = fs.statSync(dbPath);
    console.log('Size          : ' + stat.size + ' bytes');
    console.log('Last written  : ' + stat.mtime.toLocaleString());

    const SQL = await initSqlJs();
    const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));

    const stmt = db.prepare(
        'SELECT id, email, business_name, role, status, created_at FROM users ORDER BY id ASC'
    );
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();

    console.log('\nAccounts in the database: ' + rows.length);
    console.log('─'.repeat(94));
    console.log(
        'ID'.padEnd(4) +
        'EMAIL'.padEnd(32) +
        'BUSINESS'.padEnd(22) +
        'ROLE'.padEnd(8) +
        'STATUS'.padEnd(11) +
        'CREATED'
    );
    console.log('─'.repeat(94));
    for (const r of rows) {
        console.log(
            String(r.id).padEnd(4) +
            String(r.email || '').padEnd(32) +
            String(r.business_name || '(blank)').padEnd(22) +
            String(r.role || '').padEnd(8) +
            String(r.status || '').padEnd(11) +
            String(r.created_at || '')
        );
    }
    console.log('─'.repeat(94));

    const admins = rows.filter(r => r.role === 'admin');
    console.log('\nAdmin accounts: ' + admins.length +
        (admins.length ? ' (' + admins.map(a => a.email).join(', ') + ')' : ''));

    if (rows.length < 2) {
        console.log('\n>> Only one account is stored. The second signup did not reach this');
        console.log('   database — most likely the server was running from a different');
        console.log('   folder at the time, or it errored during signup (check the server');
        console.log('   window for a red error line right after you submitted the form).');
    } else if (admins.length === 0) {
        console.log('\n>> No account has the admin role, so the Admin page will bounce you');
        console.log('   back to the normal dashboard. Promote the account you want with:');
        console.log('     node make-admin.js your@email.com');
    } else {
        console.log('\n>> The data is fine — both accounts are here and an admin exists.');
        console.log('   So the blank screen is on the browser side. Log in as ' + admins[0].email + ',');
        console.log('   go to /admin, press F12, and check the Console tab for a red error.');
    }

    db.close();
})();
