/**
 * Deletes every account (all emails/passwords/roles) so the next signup
 * through the frontend becomes the first account again — and therefore
 * automatically gets the admin role.
 *
 * Scope: this ONLY touches the `users` table. Existing contacts, messages,
 * CRM deals, chatbot rules, settings, etc. are left in the database as-is —
 * they just become orphaned (no account owns them anymore), since the new
 * account you sign up with will get a fresh id and won't inherit them.
 *
 * This is irreversible, so it requires an explicit --yes flag to actually run.
 *
 * Usage (from the project root, with the server STOPPED):
 *
 *   node scripts/reset-accounts.js --yes
 */
const path = require('path');
const db = require(path.join(__dirname, '..', 'src', 'database'));

(async () => {
    if (!process.argv.includes('--yes')) {
        console.log('This will PERMANENTLY delete every account (all logins/roles).');
        console.log('Business data (contacts, messages, CRM, etc.) is left in place but orphaned.');
        console.log('');
        console.log('Re-run with --yes to actually do it:');
        console.log('  node scripts/reset-accounts.js --yes');
        process.exit(1);
    }

    await db.initDatabase();

    const before = db.listUsers();
    if (before.length === 0) {
        console.log('No accounts exist — nothing to remove. Just sign up through the frontend.');
        return;
    }

    console.log(`Removing ${before.length} account(s):`);
    for (const u of before) {
        console.log(`  - #${u.id} ${u.email} (${u.role})`);
        db.deleteUserAccountOnly(u.id);
    }

    console.log('');
    console.log('Done. All accounts removed.');
    console.log('Make sure the server is fully stopped and restarted, then sign up');
    console.log('through the frontend — that new account will automatically become admin.');
})().catch(err => {
    console.error('Failed:', err);
    process.exit(1);
});
