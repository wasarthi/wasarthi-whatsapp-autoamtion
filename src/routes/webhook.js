const express = require('express');
const router = express.Router();

const { logMessage, upsertContact } = require('../database');
const { processMessage } = require('../chatbot');
const { markAsRead } = require('../whatsapp');

// ─── Webhook verification (GET) ─────────────────────────────
// Meta sends a GET request to verify your webhook URL
router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
        console.log('✅ Webhook verified successfully');
        return res.status(200).send(challenge);
    }

    console.warn('⚠️ Webhook verification failed — token mismatch');
    return res.sendStatus(403);
});

// ─── Incoming messages (POST) ───────────────────────────────
// Meta POSTs incoming messages to this endpoint
router.post('/', async (req, res) => {
    // Always respond 200 immediately to acknowledge receipt
    // (Meta expects a fast response, process async)
    res.sendStatus(200);

    try {
        const body = req.body;

        // Verify this is a WhatsApp message event
        if (body?.object !== 'whatsapp_business_account') return;

        const entries = body.entry || [];

        for (const entry of entries) {
            const changes = entry.changes || [];

            for (const change of changes) {
                if (change.field !== 'messages') continue;

                const value = change.value;
                const messages = value?.messages || [];
                const contacts = value?.contacts || [];

                for (let i = 0; i < messages.length; i++) {
                    const message = messages[i];
                    const contact = contacts[i] || {};

                    const phone = message.from;
                    const contactName = contact.profile?.name || '';
                    const messageId = message.id;
                    const timestamp = message.timestamp;

                    // Extract message content based on type
                    let messageText = '';
                    let messageType = message.type || 'text';

                    switch (message.type) {
                        case 'text':
                            messageText = message.text?.body || '';
                            break;
                        case 'image':
                            messageText = message.image?.caption || '[Image]';
                            break;
                        case 'video':
                            messageText = message.video?.caption || '[Video]';
                            break;
                        case 'audio':
                            messageText = '[Audio message]';
                            break;
                        case 'document':
                            messageText = message.document?.filename || '[Document]';
                            break;
                        case 'location':
                            messageText = `[Location: ${message.location?.latitude}, ${message.location?.longitude}]`;
                            break;
                        case 'sticker':
                            messageText = '[Sticker]';
                            break;
                        case 'reaction':
                            messageText = `[Reaction: ${message.reaction?.emoji}]`;
                            messageType = 'reaction';
                            break;
                        case 'button':
                            messageText = message.button?.text || '[Button reply]';
                            break;
                        case 'interactive':
                            messageText = message.interactive?.button_reply?.title ||
                                         message.interactive?.list_reply?.title || '[Interactive reply]';
                            break;
                        default:
                            messageText = `[${message.type || 'Unknown'} message]`;
                    }

                    console.log(`📩 Incoming from ${phone} (${contactName}): ${messageText.substring(0, 100)}`);

                    // Log the incoming message
                    logMessage({
                        waMessageId: messageId,
                        phone,
                        contactName,
                        direction: 'incoming',
                        messageType,
                        body: messageText,
                        status: 'received'
                    });

                    // Auto-save/update contact
                    upsertContact(phone, contactName);

                    // Mark message as read
                    await markAsRead(messageId);

                    // Process through chatbot (only for text messages)
                    if (message.type === 'text' && messageText) {
                        const chatbotResult = await processMessage(phone, messageText, contactName);

                        if (chatbotResult.replied) {
                            // Log the auto-reply
                            logMessage({
                                phone,
                                contactName,
                                direction: 'outgoing',
                                messageType: 'text',
                                body: chatbotResult.response,
                                status: 'sent'
                            });
                        }
                    }
                }

                // Handle message status updates (sent, delivered, read)
                const statuses = value?.statuses || [];
                for (const status of statuses) {
                    console.log(`📊 Status update: Message ${status.id} → ${status.status}`);
                }
            }
        }
    } catch (error) {
        console.error('❌ Webhook processing error:', error);
    }
});

module.exports = router;
