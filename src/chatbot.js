const { getChatbotRules, incrementRuleHitCount, getSetting, getConversation, logMessage, getUserById, getMonthlyOutgoingCount } = require('./database');
const { generateReply } = require('./ai');
const { scheduleAutoAnalysis } = require('./lead-analyzer');

// ─── Anti-Ban Rate Limiting ─────────────────────────────────
const userRateLimits = new Map();

// Without this, every distinct (userId, phone) pair that ever messages in
// stays in memory forever — a slow leak on a long-running server with many
// contacts. Sweep out anything whose 60s window is long over.
const _rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, data] of userRateLimits) {
        if (now - data.firstMsgTime > 5 * 60 * 1000) userRateLimits.delete(key);
    }
}, 10 * 60 * 1000);
_rateLimitCleanup.unref?.();

function isRateLimited(userId, phone) {
    const key = `${userId}:${phone}`;
    const now = Date.now();
    const limitData = userRateLimits.get(key) || { count: 0, firstMsgTime: now };

    // Reset window every 60 seconds
    if (now - limitData.firstMsgTime > 60000) {
        limitData.count = 1;
        limitData.firstMsgTime = now;
    } else {
        limitData.count++;
    }

    userRateLimits.set(key, limitData);

    // Allow max 10 messages per minute
    return limitData.count > 10;
}

/** True if this account has hit its plan's monthly outgoing-message cap (0 = unlimited). */
function isOverPlanLimit(userId) {
    const account = getUserById(userId);
    if (!account || !account.message_limit) return false;
    return getMonthlyOutgoingCount(userId) >= account.message_limit;
}

// ─── Human Simulation (Delay & Typing) ──────────────────────
async function safeReply(client, phone, responseText, msg) {
    // Show typing indicator
    if (msg && client) {
        try {
            const chat = await msg.getChat();
            await chat.sendStateTyping();
        } catch (e) {
            // Typing state is cosmetic only — don't fail the reply over it
            console.log('   ⚠️ Could not send typing state (non-fatal):', e.message?.split('\n')[0]);
        }
    }

    // Random human-like delay between 1.5–3 seconds
    const delayMs = Math.floor(Math.random() * 1500) + 1500;
    console.log(`   ⏳ Simulating natural typing delay (${(delayMs/1000).toFixed(1)}s)...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));

    // Send reply — prefer msg.reply() to avoid WhatsApp LID format issues
    try {
        if (msg) {
            await msg.reply(responseText);
            console.log(`   ✅ Sent reply via msg.reply: "${responseText.substring(0, 60)}..."`);
        } else if (client) {
            const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
            await client.sendMessage(chatId, responseText);
            console.log(`   ✅ Sent reply via client.sendMessage to ${chatId}: "${responseText.substring(0, 60)}..."`);
        }
    } catch (sendErr) {
        console.error('   ❌ Primary reply failed, attempting fallback...', sendErr.message);
        if (client && msg && msg.from) {
            await client.sendMessage(msg.from, responseText);
            console.log(`   ✅ Fallback sent to ${msg.from}!`);
        } else {
            throw sendErr;
        }
    }
}

// ─── Process an incoming message through chatbot rules ──────
async function processMessage(userId, phone, messageText, contactName = '', client = null, msg = null) {
    console.log(`\n🤖 processMessage() called for user ${userId}, ${contactName || phone} (${phone})`);

    // Always log incoming message to database
    try {
        logMessage(userId, {
            phone,
            contactName,
            direction: 'incoming',
            body: messageText
        });
    } catch (dbErr) {
        console.error('   ⚠️ Failed to log incoming message to DB:', dbErr.message);
    }

    // Queue a debounced AI lead-analysis of this conversation (runs after the chat goes quiet)
    try {
        scheduleAutoAnalysis(userId, phone);
    } catch (analysisErr) {
        console.error('   ⚠️ Could not schedule lead analysis:', analysisErr.message);
    }

    if (isRateLimited(userId, phone)) {
        console.log(`⚠️ Rate limit exceeded for ${phone}, ignoring message to prevent ban.`);
        return { replied: false, reason: 'rate_limit' };
    }

    if (isOverPlanLimit(userId)) {
        console.log(`⚠️ Account ${userId} has hit its monthly message limit — skipping auto-reply.`);
        return { replied: false, reason: 'plan_limit_reached' };
    }

    const chatbotEnabled = getSetting(userId, 'chatbot_enabled');
    if (chatbotEnabled !== 'true') {
        console.log('   ❌ Chatbot is disabled globally, skipping auto-reply');
        return { replied: false, reason: 'chatbot_disabled' };
    }

    const aiEnabled = getSetting(userId, 'ai_enabled');
    const aiMode = getSetting(userId, 'ai_mode') || 'ai_first';

    // ── 1. AI-FIRST PERSONA MODE (Talk on behalf of owner) ──────
    // When AI is enabled, Gemini is the intelligent brain for all conversations
    if (aiEnabled === 'true' && aiMode === 'ai_first') {
        console.log('🧠 AI Persona Mode: Generating intelligent reply on your behalf via Gemini...');
        const aiSystemPrompt = getSetting(userId, 'ai_system_prompt');

        // Fetch recent conversation history for memory
        const allMessages = getConversation(userId, phone) || [];
        const recentHistory = allMessages.slice(-10);

        try {
            const aiResponse = await generateReply(userId, aiSystemPrompt, recentHistory, contactName, phone);

            await safeReply(client, phone, aiResponse, msg);
            logMessage(userId, { phone, contactName, direction: 'outgoing', body: aiResponse });
            return { replied: true, rule: 'ai_persona', response: aiResponse };
        } catch (aiErr) {
            console.warn('⚠️ AI Persona Mode failed (falling back to rules/default reply):', aiErr.message?.split('\\n')[0]);
        }
    }

    // ── 2. STATIC AWAY MODE (Only if AI is disabled) ───────────
    const awayMode = getSetting(userId, 'away_mode');
    if (awayMode === 'true') {
        const awayMessage = getSetting(userId, 'away_message');
        if (awayMessage) {
            await safeReply(client, phone, awayMessage, msg);
            logMessage(userId, { phone, contactName, direction: 'outgoing', body: awayMessage });
            return { replied: true, rule: 'away_mode', response: awayMessage };
        }
    }

    // ── 2. KEYWORD RULES (If AI is off or mode is 'rules_first') ──
    const text = messageText.trim().toLowerCase();
    const rules = getChatbotRules(userId, true);

    for (const rule of rules) {
        const keyword = rule.trigger_keyword.toLowerCase();
        let matched = false;

        switch (rule.match_type) {
            case 'exact':
                matched = text === keyword;
                break;
            case 'contains':
                matched = text.includes(keyword);
                break;
            case 'startswith':
                matched = text.startsWith(keyword);
                break;
            case 'regex':
                try {
                    const regex = new RegExp(keyword, 'i');
                    matched = regex.test(text);
                } catch (e) {
                    console.error(`❌ Invalid regex in rule #${rule.id}: "${keyword}"`);
                    matched = false;
                }
                break;
        }

        if (matched) {
            console.log(`🤖 Rule #${rule.id} matched: "${rule.trigger_keyword}" (${rule.match_type})`);

            let response = rule.response_text;
            response = response.replace(/\{name\}/gi, contactName || 'there');
            response = response.replace(/\{phone\}/gi, phone);

            await safeReply(client, phone, response, msg);
            logMessage(userId, { phone, contactName, direction: 'outgoing', body: response });
            incrementRuleHitCount(userId, rule.id);

            return {
                replied: true,
                ruleId: rule.id,
                keyword: rule.trigger_keyword,
                matchType: rule.match_type,
                response
            };
        }
    }

    // ── 3. AI Fallback (If in rules_first mode and no rule matched) ──
    if (aiEnabled === 'true') {
        console.log('🤖 No rule matched, querying Gemini AI fallback...');
        const aiSystemPrompt = getSetting(userId, 'ai_system_prompt');
        const allMessages = getConversation(userId, phone) || [];
        const recentHistory = allMessages.slice(-10);

        try {
            const aiResponse = await generateReply(userId, aiSystemPrompt, recentHistory, contactName, phone);

            await safeReply(client, phone, aiResponse, msg);
            logMessage(userId, { phone, contactName, direction: 'outgoing', body: aiResponse });
            return { replied: true, rule: 'ai_fallback', response: aiResponse };
        } catch (aiErr) {
            console.warn('⚠️ AI Fallback failed (falling back to default reply):', aiErr.message?.split('\\n')[0]);
        }
    }

    // ── 4. Static Default Reply ──
    const defaultReply = getSetting(userId, 'default_reply');
    if (defaultReply) {
        console.log('🤖 No rule matched, sending default static reply');
        await safeReply(client, phone, defaultReply, msg);
        logMessage(userId, { phone, contactName, direction: 'outgoing', body: defaultReply });
        return { replied: true, rule: 'default', response: defaultReply };
    }

    console.log('🤖 No rule matched, no AI, and no default reply set');
    return { replied: false, reason: 'no_match' };
}

// ─── Test a message against rules without sending ───────────
function testMessage(userId, messageText) {
    const aiEnabled = getSetting(userId, 'ai_enabled');
    const aiMode = getSetting(userId, 'ai_mode') || 'ai_first';

    if (aiEnabled === 'true' && aiMode === 'ai_first') {
        return {
            matched: true,
            ruleId: 'ai_persona',
            keyword: 'AI Persona Mode',
            matchType: 'dynamic_ai',
            response: "Gemini AI will dynamically generate a natural, conversational response acting as you."
        };
    }

    const text = messageText.trim().toLowerCase();
    const rules = getChatbotRules(userId, true);

    for (const rule of rules) {
        const keyword = rule.trigger_keyword.toLowerCase();
        let matched = false;

        switch (rule.match_type) {
            case 'exact':
                matched = text === keyword;
                break;
            case 'contains':
                matched = text.includes(keyword);
                break;
            case 'startswith':
                matched = text.startsWith(keyword);
                break;
            case 'regex':
                try {
                    matched = new RegExp(keyword, 'i').test(text);
                } catch (e) {
                    matched = false;
                }
                break;
        }

        if (matched) {
            return {
                matched: true,
                ruleId: rule.id,
                keyword: rule.trigger_keyword,
                matchType: rule.match_type,
                response: rule.response_text
            };
        }
    }

    if (aiEnabled === 'true') {
        return {
            matched: false,
            willSendDefault: false,
            willSendAI: true,
            defaultReply: "Gemini AI will generate a dynamic response based on your System Prompt."
        };
    }

    const defaultReply = getSetting(userId, 'default_reply');
    return {
        matched: false,
        willSendDefault: !!defaultReply,
        willSendAI: false,
        defaultReply: defaultReply || null
    };
}

module.exports = { processMessage, testMessage };
