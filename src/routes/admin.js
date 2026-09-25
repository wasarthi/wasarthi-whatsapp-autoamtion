const express = require('express');
const router = express.Router();

const {
    listUsers, getUserById, updateUser, deleteUserCascade,
    getUserStats, getPlatformStats, countOrphanedRows
} = require('../services/database');
const { getStatus, destroyClientForUser } = require('../services/whatsapp-client');
const { revokeAllSessionsForUser } = require('../config/auth');
const { requireId, optionalString, clampInt, requireEnum, LIMITS } = require('../utils/validate');
const { asyncHandler } = require('../utils/errors');
const { BUSINESS_VERTICALS } = require('../config/verticals');

function publicUser(u) {
    if (!u) return null;
    const { password_hash, ...rest } = u;
    return rest;
}

// ─── Platform-wide overview ───────────────────────────────────
router.get('/stats', (req, res) => {
    res.json({ success: true, data: getPlatformStats() });
});

// ─── List every account with usage + WhatsApp connection status ──
router.get('/users', (req, res) => {
    const users = listUsers().map(u => {
        const stats = getUserStats(u.id);
        const wa = getStatus(u.id);
        return { ...publicUser(u), stats, whatsapp: wa };
    });
    res.json({ success: true, data: users });
});

// ─── Single account detail ────────────────────────────────────
router.get('/users/:id', (req, res) => {
    const id = requireId(req.params.id, 'user id');
    const user = getUserById(id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    const stats = getUserStats(user.id);
    const wa = getStatus(user.id);
    res.json({ success: true, data: { ...publicUser(user), stats, whatsapp: wa } });
});

// Kept apart from the generic account editor: vertical selection changes
// product behaviour and is exclusively a platform-administration action.
router.patch('/users/:id/vertical', asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'user id');
    const target = getUserById(id);
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const business_vertical = requireEnum(body.business_vertical, Object.values(BUSINESS_VERTICALS), 'business_vertical');
    res.json({ success: true, data: publicUser(updateUser(id, { business_vertical })) });
}));

// ─── Suspend / activate / change plan / set limits / change role ──
router.patch('/users/:id', asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'user id');
    const target = getUserById(id);
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });

    if (id === req.user.id && (req.body?.status === 'suspended' || req.body?.role === 'user')) {
        return res.status(400).json({ success: false, error: 'You cannot suspend or demote your own admin account.' });
    }

    // Explicit allow-list, one field at a time. Anything not named here —
    // email, password_hash, id, created_at — is not writable through this
    // route no matter what the request body contains.
    const fields = {};
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const { status, plan, message_limit, rule_limit, role, business_name, owner_name } = body;

    if (status !== undefined)  fields.status = requireEnum(status, ['active', 'suspended'], 'status');
    if (role !== undefined)    fields.role = requireEnum(role, ['admin', 'user'], 'role');
    if (plan !== undefined)    fields.plan = optionalString(plan, 'plan', 40);
    if (message_limit !== undefined) fields.message_limit = clampInt(message_limit, { min: 0, max: 100000000, fallback: 0 });
    if (rule_limit !== undefined)    fields.rule_limit = clampInt(rule_limit, { min: 0, max: 100000, fallback: 0 });
    if (business_name !== undefined) fields.business_name = optionalString(business_name, 'business_name', LIMITS.CONTACT_NAME);
    if (owner_name !== undefined)    fields.owner_name = optionalString(owner_name, 'owner_name', LIMITS.CONTACT_NAME);
    if (body.wa_enabled !== undefined) fields.wa_enabled = body.wa_enabled ? 1 : 0;
    if (body.document_send_enabled !== undefined) fields.document_send_enabled = body.document_send_enabled ? 1 : 0;

    const updated = updateUser(id, fields);

    // Role changes must apply to sessions that already exist: a demoted admin
    // holds a token carrying role:"admin", and although middleware/auth.js
    // re-reads the role from the database on every request, revoking removes
    // any reliance on that single downstream check.
    //
    // Suspension deliberately does NOT revoke tokens. The database status
    // check already blocks a suspended user on their very next request, and it
    // produces a 403 with code ACCOUNT_SUSPENDED — which is what tells the
    // dashboard to show "your account has been suspended" instead of bouncing
    // the user to the login page with no explanation, as a revoked-token 401
    // would.
    if (fields.role && fields.role !== target.role) {
        revokeAllSessionsForUser(id);
    }

    // If suspended, tear down their live WhatsApp session (and its Chrome
    // process, and its SSE streams) so it can't keep sending on their behalf.
    if (fields.status === 'suspended') {
        try { await destroyClientForUser(id); } catch (e) { /* non-fatal */ }
    }

    // If WhatsApp access was revoked, immediately tear down their active
    // WhatsApp session so they can't keep sending messages after losing access.
    if (fields.wa_enabled === 0) {
        try { await destroyClientForUser(id); } catch (e) { /* non-fatal */ }
    }

    res.json({ success: true, data: publicUser(updated) });
}));

// ─── Delete an account and everything it owns ─────────────────
router.delete('/users/:id', asyncHandler(async (req, res) => {
    const id = requireId(req.params.id, 'user id');
    if (id === req.user.id) {
        return res.status(400).json({ success: false, error: 'You cannot delete your own account while logged in as it.' });
    }
    const target = getUserById(id);
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });

    // Order matters. Kill the live session first — awaited, unlike before, so
    // the browser and its SSE streams are actually gone before the rows
    // disappear underneath them. A background WhatsApp handler firing against
    // a deleted user_id would otherwise re-insert orphaned message rows.
    revokeAllSessionsForUser(id);
    try { await destroyClientForUser(id); } catch (e) { /* non-fatal */ }

    deleteUserCascade(id);

    // Prove it. A cascade that silently missed a table leaves another
    // tenant's dashboard counting rows nobody owns, and the next account to
    // be assigned this id inherits them.
    const leftovers = countOrphanedRows(id);
    if (leftovers.total > 0) {
        console.error(`❌ Account ${id} deletion left ${leftovers.total} orphaned rows:`, leftovers.byTable);
        return res.status(500).json({
            success: false,
            error: 'The account was partially deleted. An administrator has been alerted.'
        });
    }

    res.json({ success: true });
}));

module.exports = router;





