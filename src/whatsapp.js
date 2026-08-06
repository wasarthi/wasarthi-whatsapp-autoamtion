const axios = require('axios');

const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

// ─── Check if running in demo mode ──────────────────────────
function isDemoMode() {
    return process.env.DEMO_MODE === 'true';
}

// ─── Build headers ──────────────────────────────────────────
function getHeaders() {
    return {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
    };
}

// ─── Send a plain text message ──────────────────────────────
async function sendTextMessage(to, body) {
    if (isDemoMode()) {
        console.log(`📨 [DEMO] Would send text to ${to}: "${body.substring(0, 50)}..."`);
        return {
            success: true,
            demo: true,
            messageId: `demo_${Date.now()}`,
            to,
            body
        };
    }

    try {
        const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_ID}/messages`;
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: to,
            type: 'text',
            text: { body: body }
        };

        const response = await axios.post(url, payload, { headers: getHeaders() });
        const messageId = response.data?.messages?.[0]?.id || null;

        console.log(`✅ Message sent to ${to} (ID: ${messageId})`);
        return {
            success: true,
            messageId,
            to,
            body
        };
    } catch (error) {
        const errMsg = error.response?.data?.error?.message || error.message;
        console.error(`❌ Failed to send message to ${to}:`, errMsg);
        throw new Error(errMsg);
    }
}

// ─── Send a template message ────────────────────────────────
async function sendTemplateMessage(to, templateName, languageCode = 'en', components = []) {
    if (isDemoMode()) {
        console.log(`📨 [DEMO] Would send template "${templateName}" to ${to}`);
        return {
            success: true,
            demo: true,
            messageId: `demo_tmpl_${Date.now()}`,
            to,
            templateName
        };
    }

    try {
        const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_ID}/messages`;
        const payload = {
            messaging_product: 'whatsapp',
            to: to,
            type: 'template',
            template: {
                name: templateName,
                language: { code: languageCode },
                ...(components.length > 0 ? { components } : {})
            }
        };

        const response = await axios.post(url, payload, { headers: getHeaders() });
        const messageId = response.data?.messages?.[0]?.id || null;

        console.log(`✅ Template "${templateName}" sent to ${to} (ID: ${messageId})`);
        return { success: true, messageId, to, templateName };
    } catch (error) {
        const errMsg = error.response?.data?.error?.message || error.message;
        console.error(`❌ Failed to send template to ${to}:`, errMsg);
        throw new Error(errMsg);
    }
}

// ─── Mark message as read ───────────────────────────────────
async function markAsRead(messageId) {
    if (isDemoMode()) return { success: true, demo: true };

    try {
        const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_ID}/messages`;
        await axios.post(url, {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId
        }, { headers: getHeaders() });

        return { success: true };
    } catch (error) {
        console.error('❌ Failed to mark as read:', error.message);
        return { success: false };
    }
}

// ─── Get business profile ───────────────────────────────────
async function getBusinessProfile() {
    if (isDemoMode()) {
        return {
            success: true,
            demo: true,
            profile: {
                about: 'Demo Business',
                address: '123 Demo Street',
                description: 'This is a demo WhatsApp Business profile',
                vertical: 'OTHER'
            }
        };
    }

    try {
        const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_ID}/whatsapp_business_profile`;
        const response = await axios.get(url, {
            headers: getHeaders(),
            params: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' }
        });
        return { success: true, profile: response.data?.data?.[0] || {} };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ─── Check connection status ────────────────────────────────
async function checkConnectionStatus() {
    if (isDemoMode()) {
        return { connected: true, demo: true, message: 'Running in demo mode' };
    }

    try {
        const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_ID}`;
        const response = await axios.get(url, {
            headers: getHeaders(),
            params: { fields: 'verified_name,quality_rating,display_phone_number' }
        });
        return {
            connected: true,
            phoneNumber: response.data.display_phone_number,
            verifiedName: response.data.verified_name,
            qualityRating: response.data.quality_rating
        };
    } catch (error) {
        return {
            connected: false,
            error: error.response?.data?.error?.message || error.message
        };
    }
}

module.exports = {
    sendTextMessage,
    sendTemplateMessage,
    markAsRead,
    getBusinessProfile,
    checkConnectionStatus,
    isDemoMode
};
