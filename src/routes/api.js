const express = require('express');
const router = express.Router();

const {
    getContacts, upsertContact, deleteContact, getContactByPhone,
    getMessages, getConversation,
    getChatbotRules, createChatbotRule, updateChatbotRule, deleteChatbotRule, countChatbotRules,
    getScheduledMessages, createScheduledMessage, cancelScheduledMessage,
    getAllSettings, setSetting, getSetting,
    getDashboardStats, logMessage, getMonthlyOutgoingCount, clearMessages,
    getLeadAnalyses, getLeadAnalysis, deleteLeadAnalysis, getConversationPhones, getLeadStats,
    getProducts, createProduct, updateProduct, deleteProduct,
    CRM_STAGES, getCrmDeals, getCrmDealByPhone, getCrmDealById, createCrmDeal,
    updateCrmDeal, deleteCrmDeal, getCrmStats, getCrmAnalytics, addCrmActivity, getCrmActivities
} = require('../database');

const { sendTextMessage, getStatus, initWhatsAppClient, destroyClientForUser } = require('../whatsapp-client');
const { testMessage } = require('../chatbot');
const { analyzeConversation, analyzeAllConversations } = require('../lead-analyzer');
const { analyzeBusinessProfile, getBusinessInfo } = require('../business');

// ─────────────────────────────────────────────────────────────
//  DASHBOARD
// ─────────────────────────────────────────────────────────────
router.get('/dashboard/stats', (req, res) => {
    try {
        const uid = req.user.id;
        const stats = getDashboardStats(uid);

        // Leads overview
        stats.leads = getLeadStats(uid);

        // Chats with new/unanalyzed messages
        try {
            const phones = getConversationPhones(uid);
            const analyses = getLeadAnalyses(uid);
            const byPhone = new Map(analyses.map(l => [l.phone, l]));
            stats.awaitingAnalysis = phones.filter(p => {
                const existing = byPhone.get(p.phone);
                return !existing || existing.message_count < p.message_count;
            }).length;
        } catch (e) {
            stats.awaitingAnalysis = 0;
        }

        // Sales pipeline overview
        stats.crm = getCrmStats(uid);
        stats.currency = getSetting(uid, 'business_currency') || '₹';

        // System status
        stats.waConnected = !!getStatus(uid).connected;
        const geminiKey = getSetting(uid, 'gemini_api_key') || process.env.GEMINI_API_KEY || '';
        stats.aiConfigured = geminiKey.trim() !== '' && geminiKey !== 'your_gemini_api_key_here';

        // Plan / usage
        stats.plan = req.user.plan;
        stats.messageLimit = req.user.message_limit;
        stats.messagesThisMonth = getMonthlyOutgoingCount(uid);

        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/status', async (req, res) => {
    try {
        const status = getStatus(req.user.id);
        res.json({ success: true, data: status });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  WHATSAPP CONNECTION (per-account)
// ─────────────────────────────────────────────────────────────
router.post('/whatsapp/connect', (req, res) => {
    try {
        initWhatsAppClient(req.user.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/whatsapp/disconnect', async (req, res) => {
    try {
        await destroyClientForUser(req.user.id);
        res.json({ success: true });
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
        const contacts = getContacts(req.user.id, search, label);
        res.json({ success: true, data: contacts });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/contacts', (req, res) => {
    try {
        const { phone, name, label, notes } = req.body;
        if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required' });

        const contact = upsertContact(req.user.id, phone, name, label, notes);
        res.json({ success: true, data: contact });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/contacts/:id', (req, res) => {
    try {
        deleteContact(req.user.id, req.params.id);
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
        const messages = getMessages(req.user.id, {
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
        const messages = getConversation(req.user.id, req.params.phone);
        res.json({ success: true, data: messages });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Danger Zone → Clear Message History: permanently deletes this account's own message log.
router.delete('/messages', (req, res) => {
    try {
        clearMessages(req.user.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/messages/send', async (req, res) => {
    try {
        const uid = req.user.id;
        const { phone, body } = req.body;
        if (!phone || !body) {
            return res.status(400).json({ success: false, error: 'Phone and body are required' });
        }

        if (req.user.message_limit && getMonthlyOutgoingCount(uid) >= req.user.message_limit) {
            return res.status(403).json({ success: false, error: `Monthly message limit reached (${req.user.message_limit}). Contact your administrator to raise it.` });
        }

        const result = await sendTextMessage(uid, phone, body);

        // Log the outgoing message
        logMessage(uid, {
            waMessageId: result.messageId,
            phone,
            direction: 'outgoing',
            messageType: 'text',
            body,
            status: 'sent'
        });

        // Auto-save contact
        const contact = getContactByPhone(uid, phone);
        if (!contact) {
            upsertContact(uid, phone);
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
        const rules = getChatbotRules(req.user.id);
        res.json({ success: true, data: rules });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/chatbot/rules', (req, res) => {
    try {
        const uid = req.user.id;
        const { trigger_keyword, match_type, response_text, priority } = req.body;
        if (!trigger_keyword || !response_text) {
            return res.status(400).json({ success: false, error: 'Trigger keyword and response text are required' });
        }

        if (req.user.rule_limit && countChatbotRules(uid) >= req.user.rule_limit) {
            return res.status(403).json({ success: false, error: `Chatbot rule limit reached (${req.user.rule_limit}). Contact your administrator to raise it.` });
        }

        const rule = createChatbotRule(
            uid,
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
        const result = updateChatbotRule(req.user.id, req.params.id, req.body);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/chatbot/rules/:id', (req, res) => {
    try {
        deleteChatbotRule(req.user.id, req.params.id);
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
        const result = testMessage(req.user.id, message);
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
        const messages = getScheduledMessages(req.user.id, status);
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

        // scheduled_at is expected as a SQLite-comparable UTC string, e.g.
        // "2026-08-08 14:30:00" (what the frontend sends after converting the
        // browser's local datetime-local value). Parse defensively — this
        // also guards direct API callers who might send a raw local time or
        // an ISO string with a 'T'/'Z' instead.
        const parsed = new Date(scheduled_at.replace(' ', 'T') + (/[Zz]|[+-]\d\d:?\d\d$/.test(scheduled_at) ? '' : 'Z'));
        if (isNaN(parsed.getTime())) {
            return res.status(400).json({ success: false, error: 'scheduled_at is not a valid date/time.' });
        }
        // Small grace window for clock skew / time spent filling the form.
        if (parsed.getTime() < Date.now() - 60000) {
            return res.status(400).json({ success: false, error: 'scheduled_at must be in the future.' });
        }

        const msg = createScheduledMessage(req.user.id, phone, body, scheduled_at);
        res.json({ success: true, data: msg });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/scheduled/:id', (req, res) => {
    try {
        cancelScheduledMessage(req.user.id, req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  LEAD ANALYSIS (AI conversation insights)
// ─────────────────────────────────────────────────────────────

// List saved lead analyses (sorted by priority, then interest score)
router.get('/leads', (req, res) => {
    try {
        const uid = req.user.id;
        const { interest, priority } = req.query;
        const leads = getLeadAnalyses(uid, { interestStatus: interest || '', priority: priority || '' });
        const stats = getLeadStats(uid);
        // Conversations that exist but haven't been analyzed yet (or have new messages)
        const phones = getConversationPhones(uid);
        const leadByPhone = new Map(leads.map(l => [l.phone, l]));
        const pending = phones.filter(p => {
            const existing = leadByPhone.get(p.phone);
            return !existing || existing.message_count < p.message_count;
        }).map(p => ({ phone: p.phone, contact_name: p.contact_name, message_count: p.message_count }));

        res.json({ success: true, data: { leads, stats, pending } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get one lead's analysis
router.get('/leads/:phone', (req, res) => {
    try {
        const lead = getLeadAnalysis(req.user.id, req.params.phone);
        if (!lead) return res.status(404).json({ success: false, error: 'No analysis found for this contact yet.' });
        res.json({ success: true, data: lead });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Analyze (or re-analyze) one conversation now
router.post('/leads/analyze/:phone', async (req, res) => {
    try {
        const lead = await analyzeConversation(req.user.id, req.params.phone);
        res.json({ success: true, data: lead });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Analyze all conversations (skips up-to-date ones unless ?force=true)
router.post('/leads/analyze-all', async (req, res) => {
    try {
        const force = req.query.force === 'true' || req.body?.force === true;
        const results = await analyzeAllConversations(req.user.id, !force);
        res.json({
            success: true,
            data: {
                analyzed: results.analyzed.length,
                skipped: results.skipped.length,
                failed: results.failed
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete a saved analysis
router.delete('/leads/:id', (req, res) => {
    try {
        deleteLeadAnalysis(req.user.id, req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  BUSINESS SETUP (products, catalog, AI business analysis)
// ─────────────────────────────────────────────────────────────
router.get('/products', (req, res) => {
    try {
        res.json({ success: true, data: getProducts(req.user.id) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/products', (req, res) => {
    try {
        const { name, description, price, category, url } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Product name is required' });
        }
        const product = createProduct(req.user.id, {
            name: name.trim(),
            description: description || '',
            price: price || '',
            category: category || '',
            url: url || ''
        });
        res.json({ success: true, data: product });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/products/:id', (req, res) => {
    try {
        res.json({ success: true, data: updateProduct(req.user.id, req.params.id, req.body) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/products/:id', (req, res) => {
    try {
        deleteProduct(req.user.id, req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Run the AI business analysis and save the sales brief
router.post('/business/analyze', async (req, res) => {
    try {
        const profile = await analyzeBusinessProfile(req.user.id);
        res.json({ success: true, data: profile });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Current business info (settings + products in one call)
router.get('/business', (req, res) => {
    try {
        const info = getBusinessInfo(req.user.id);
        let aiProfile = null;
        try { aiProfile = JSON.parse(getSetting(req.user.id, 'business_ai_profile') || ''); } catch (e) { aiProfile = null; }
        res.json({ success: true, data: { ...info, aiProfile } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  CRM (pipeline, deals, activities)
// ─────────────────────────────────────────────────────────────
router.get('/crm/deals', (req, res) => {
    try {
        const uid = req.user.id;
        const { stage } = req.query;
        const deals = getCrmDeals(uid, { stage: stage || '' });
        const stats = getCrmStats(uid);
        const currency = getSetting(uid, 'business_currency') || '₹';
        res.json({ success: true, data: { deals, stats, stages: CRM_STAGES, currency } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/crm/analytics', (req, res) => {
    try {
        const analytics = getCrmAnalytics(req.user.id);
        analytics.currency = getSetting(req.user.id, 'business_currency') || '₹';
        res.json({ success: true, data: analytics });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/crm/deals', (req, res) => {
    try {
        const uid = req.user.id;
        const { phone, contact_name, stage, deal_value, product_interest, notes, next_followup_at } = req.body;
        if (!phone || !phone.trim()) {
            return res.status(400).json({ success: false, error: 'Phone number is required' });
        }
        if (getCrmDealByPhone(uid, phone.trim())) {
            return res.status(400).json({ success: false, error: 'A deal already exists for this contact.' });
        }
        const deal = createCrmDeal(uid, {
            phone: phone.trim(),
            contactName: contact_name || '',
            stage: stage || 'new',
            dealValue: parseFloat(deal_value) || 0,
            productInterest: product_interest || '',
            source: 'manual',
            notes: notes || '',
            nextFollowupAt: next_followup_at || null
        });
        addCrmActivity(uid, deal.phone, 'system', 'Deal created manually');
        res.json({ success: true, data: deal });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/crm/deals/:id', (req, res) => {
    try {
        const uid = req.user.id;
        const existing = getCrmDealById(uid, req.params.id);
        if (!existing) return res.status(404).json({ success: false, error: 'Deal not found' });

        const fields = {};
        const { contact_name, stage, deal_value, product_interest, notes, next_followup_at } = req.body;
        if (contact_name      !== undefined) fields.contact_name = contact_name;
        if (stage             !== undefined) fields.stage = stage;
        if (deal_value        !== undefined) fields.deal_value = parseFloat(deal_value) || 0;
        if (product_interest  !== undefined) fields.product_interest = product_interest;
        if (notes             !== undefined) fields.notes = notes;
        if (next_followup_at  !== undefined) fields.next_followup_at = next_followup_at || null;

        const updated = updateCrmDeal(uid, req.params.id, fields);

        if (stage !== undefined && stage !== existing.stage) {
            addCrmActivity(uid, existing.phone, 'stage', `Stage changed: ${existing.stage} → ${stage}`);
        }

        res.json({ success: true, data: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/crm/deals/:id', (req, res) => {
    try {
        deleteCrmDeal(req.user.id, req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// One deal with its lead analysis + activity timeline (for the detail view)
router.get('/crm/deals/phone/:phone', (req, res) => {
    try {
        const uid = req.user.id;
        const deal = getCrmDealByPhone(uid, req.params.phone);
        if (!deal) return res.status(404).json({ success: false, error: 'Deal not found' });
        const analysis = getLeadAnalysis(uid, req.params.phone) || null;
        const activities = getCrmActivities(uid, req.params.phone);
        res.json({ success: true, data: { deal, analysis, activities } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/crm/deals/phone/:phone/notes', (req, res) => {
    try {
        const { content } = req.body;
        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, error: 'Note content is required' });
        }
        const activity = addCrmActivity(req.user.id, req.params.phone, 'note', content.trim());
        res.json({ success: true, data: activity });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
    try {
        const settings = getAllSettings(req.user.id);
        res.json({ success: true, data: settings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/settings', (req, res) => {
    try {
        const uid = req.user.id;
        const updates = req.body;
        for (const [key, value] of Object.entries(updates)) {
            setSetting(uid, key, value);
        }
        res.json({ success: true, data: getAllSettings(uid) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
