const express = require('express');
const router = express.Router();

const {
    getContacts, upsertContact, deleteContact, getContactByPhone,
    getMessages, getConversation,
    getChatbotRules, createChatbotRule, updateChatbotRule, deleteChatbotRule,
    getScheduledMessages, createScheduledMessage, cancelScheduledMessage,
    getAllSettings, setSetting, getSetting,
    getDashboardStats, logMessage
} = require('../database');

const { sendTextMessage, getStatus } = require('../whatsapp-client');
const { testMessage } = require('../chatbot');

// ─────────────────────────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────────────────────────
router.get('/dashboard/stats', (req, res) => {
    try {
        const stats = getDashboardStats();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/status', async (req, res) => {
    try {
        const status = getStatus();
        res.json({ success: true, data: status });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  CONTACTS
// ─────────────────────────────────────────────────────────────
router.get('/contacts', (req, res) => {
    try {
        const { search, label } = req.query;
        const contacts = getContacts(search, label);
        res.json({ success: true, data: contacts });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/contacts', (req, res) => {
    try {
        const { phone, name, label, notes } = req.body;
        if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required' });

        const contact = upsertContact(phone, name, label, notes);
        res.json({ success: true, data: contact });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/contacts/:id', (req, res) => {
    try {
        deleteContact(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  MESSAGES
// ─────────────────────────────────────────────────────────────
router.get('/messages', (req, res) => {
    try {
        const { phone, direction, limit, offset } = req.query;
        const messages = getMessages({
            phone,
            direction,
            limit: parseInt(limit) || 100,
            offset: parseInt(offset) || 0
        });
        res.json({ success: true, data: messages });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/messages/conversation/:phone', (req, res) => {
    try {
        const messages = getConversation(req.params.phone);
        res.json({ success: true, data: messages });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/messages/send', async (req, res) => {
    try {
        const { phone, body } = req.body;
        if (!phone || !body) {
            return res.status(400).json({ success: false, error: 'Phone and body are required' });
        }

        const result = await sendTextMessage(phone, body);

        // Log the outgoing message
        logMessage({
            waMessageId: result.messageId,
            phone,
            direction: 'outgoing',
            messageType: 'text',
            body,
            status: 'sent'
        });

        // Auto-save contact
        const contact = getContactByPhone(phone);
        if (!contact) {
            upsertContact(phone);
        }

        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  CHATBOT RULES
// ─────────────────────────────────────────────────────────────
router.get('/chatbot/rules', (req, res) => {
    try {
        const rules = getChatbotRules();
        res.json({ success: true, data: rules });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/chatbot/rules', (req, res) => {
    try {
        const { trigger_keyword, match_type, response_text, priority } = req.body;
        if (!trigger_keyword || !response_text) {
            return res.status(400).json({ success: false, error: 'Trigger keyword and response text are required' });
        }

        const rule = createChatbotRule(
            trigger_keyword,
            match_type || 'contains',
            response_text,
            parseInt(priority) || 0
        );
        res.json({ success: true, data: rule });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/chatbot/rules/:id', (req, res) => {
    try {
        const result = updateChatbotRule(req.params.id, req.body);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/chatbot/rules/:id', (req, res) => {
    try {
        deleteChatbotRule(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Test a message against chatbot rules (without sending)
router.post('/chatbot/test', (req, res) => {
    try {
        const { message } = req.body;
        if (!message) {
            return res.status(400).json({ success: false, error: 'Message text is required' });
        }
        const result = testMessage(message);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  SCHEDULED MESSAGES
// ─────────────────────────────────────────────────────────────
router.get('/scheduled', (req, res) => {
    try {
        const { status } = req.query;
        const messages = getScheduledMessages(status);
        res.json({ success: true, data: messages });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/scheduled', (req, res) => {
    try {
        const { phone, body, scheduled_at } = req.body;
        if (!phone || !body || !scheduled_at) {
            return res.status(400).json({ success: false, error: 'Phone, body, and scheduled_at are required' });
        }

        const msg = createScheduledMessage(phone, body, scheduled_at);
        res.json({ success: true, data: msg });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/scheduled/:id', (req, res) => {
    try {
        cancelScheduledMessage(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
    try {
        const settings = getAllSettings();
        res.json({ success: true, data: settings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/settings', (req, res) => {
    try {
        const updates = req.body;
        for (const [key, value] of Object.entries(updates)) {
            setSetting(key, value);
        }
        res.json({ success: true, data: getAllSettings() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
