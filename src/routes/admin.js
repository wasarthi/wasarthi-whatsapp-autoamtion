const express = require('express');
const router = express.Router();

const {
    listUsers, getUserById, updateUser, deleteUserCascade,
    getUserStats, getPlatformStats
} = require('../database');
const { getStatus, destroyClientForUser } = require('../whatsapp-client');

function publicUser(u) {
    if (!u) return null;
    const { password_hash, ...rest } = u;
    return rest;
}

// ─── Platform-wide overview ───────────────────────────────────
router.get('/stats', (req, res) => {
    try {
        res.json({ success: true, data: getPlatformStats() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── List every account with usage + WhatsApp connection status ──
router.get('/users', (req, res) => {
    try {
        const users = listUsers().map(u => {
            const stats = getUserStats(u.id);
            const wa = getStatus(u.id);
            return { ...u, stats, whatsapp: wa };
        });
        res.json({ success: true, data: users });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Single account detail ────────────────────────────────────
router.get('/users/:id', (req, res) => {
    try {
        const user = getUserById(req.params.id);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        const stats = getUserStats(user.id);
        const wa = getStatus(user.id);
        res.json({ success: true, data: { ...publicUser(user), stats, whatsapp: wa } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Suspend / activate / change plan / set limits / change role ──
router.patch('/users/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const target = getUserById(id);
        if (!target) return res.status(404).json({ success: false, error: 'User not found' });

        if (id === req.user.id && (req.body.status === 'suspended' || req.body.role === 'user')) {
            return res.status(400).json({ success: false, error: 'You cannot suspend or demote your own admin account.' });
        }

        const fields = {};
        const { status, plan, message_limit, rule_limit, role, business_name, owner_name } = req.body || {};
        if (status !== undefined && ['active', 'suspended'].includes(status)) fields.status = status;
        if (plan !== undefined) fields.plan = String(plan).slice(0, 40);
        if (message_limit !== undefined) fields.message_limit = Math.max(0, parseInt(message_limit, 10) || 0);
        if (rule_limit !== undefined) fields.rule_limit = Math.max(0, parseInt(rule_limit, 10) || 0);
        if (role !== undefined && ['admin', 'user'].includes(role)) fields.role = role;
        if (business_name !== undefined) fields.business_name = business_name;
        if (owner_name !== undefined) fields.owner_name = owner_name;

        const updated = updateUser(id, fields);

        // If suspended, tear down their live WhatsApp session so it can't keep sending.
        if (fields.status === 'suspended') {
            try { destroyClientForUser(id); } catch (e) { /* non-fatal */ }
        }

        res.json({ success: true, data: publicUser(updated) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Delete an account and everything it owns ─────────────────
router.delete('/users/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (id === req.user.id) {
            return res.status(400).json({ success: false, error: 'You cannot delete your own account while logged in as it.' });
        }
        const target = getUserById(id);
        if (!target) return res.status(404).json({ success: false, error: 'User not found' });

        try { destroyClientForUser(id); } catch (e) { /* non-fatal */ }
        deleteUserCascade(id);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
