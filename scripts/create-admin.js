/**
 * Creates (or upgrades) an admin account directly in the database — no need
 * to sign up through the UI first. Safe to run whether the server is
 * stopped or currently running.
 *
 * Usage (from the project root, e.g. "E:\whatsapp automation"):
 *
 *   node scripts/create-admin.js
 *       → creates admin@yourbusiness.local with a random password (printed once)
 *
 *   node scripts/create-admin.js you@example.com "yourPassword123"
 *       → creates (or upgrades) that exact account as an admin with that password
 *
 *   node scripts/create-admin.js you@example.com "yourPassword123" "My Business"
 *       → same, plus sets the business name
 *
 * If the email already exists, that account is promoted to role=admin,
 * status=active, and its password is reset to whatever you passed in.
 */
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require(path.join(__dirname, '..', 'src', 'database'));

function randomPassword() {
    return crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
}

(async () => {
    await db.initDatabase();

    let [, , emailArg, passwordArg, businessNameArg] = process.argv;
    const email = (emailArg || 'admin@yourbusiness.local').trim().toLowerCase();
    const generatedPassword = !passwordArg;
    const password = passwordArg || randomPassword();
    const businessName = businessNameArg || 'My Business';

    const passwordHash = await bcrypt.hash(password, 10);
    const existing = db.getUserByEmail(email);
    let user;

    if (existing) {
        user = db.updateUser(existing.id, {
            role: 'admin',
            status: 'active',
            password_hash: passwordHash
        });
        console.log(`Updated existing account #${user.id} (${email}) -> role=admin, status=active, password reset.`);
    } else {
        user = db.createUser({ email, passwordHash, businessName, ownerName: '' });
        // createUser only auto-assigns admin to the very first-ever signup;
        // force it here so this works no matter how many accounts already exist.
        user = db.updateUser(user.id, { role: 'admin', status: 'active' });
        console.log(`Created new admin account #${user.id} (${email}).`);
    }

    console.log('');
    console.log('Log in at /login with:');
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${password}`);
    if (generatedPassword) {
        console.log('');
        console.log('(This password was auto-generated and is only ever shown here — save it now.');
        console.log(' Re-run this script anytime with an email + password to reset it.)');
    }
})().catch(err => {
    console.error('Failed:', err);
    process.exit(1);
});
