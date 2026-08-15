const {
    getChatbotRules, incrementRuleHitCount, getSetting, getConversation,
    logMessage, getUserById, getMonthlyOutgoingCount
} = require('./database');
const { generateReply } = require('./ai');
const { scheduleAutoAnalysis } = require('./lead-analyzer');
const { safeRegexTest } = require('../utils/validate');

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

// Hard bound on the map itself. An attacker who can send from many numbers
// (or a spam wave) would otherwise create one entry per sender between
// sweeps; 100k entries is far past any legitimate volume for one server.
const MAX_RATE_LIMIT_KEYS = 100000;

// How much conversation history to load for AI context. The unbounded
// version loaded the *entire* conversation on every inbound message just to
// take the last 10 — so a customer with a 40k-message history caused 40k
// rows to be materialised per message received, on the shared event loop.
const AI_CONTEXT_MESSAGES = 10;

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

    if (userRateLimits.size >= MAX_RATE_LIMIT_KEYS && !userRateLimits.has(key)) {
        // Fail closed: refusing to auto-reply is the safe direction when
        // we're already tracking an implausible number of senders.
        return true;
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

/**
 * Matches one rule against incoming text.
 *
 * Extracted so the live path and the /chatbot/test preview cannot drift
 * apart — a preview that says "this matches" while the real path disagrees
 * is worse than no preview. The regex case goes through safeRegexTest,
 * which bounds input length; the pattern itself was already vetted against
 * catastrophic backtracking when the rule was saved (see
 * validate.assertSafeRegexSource). Rules stored before that check existed
 * still run through the same bounded matcher here.
 */
function ruleMatches(rule, text) {
    const keyword = String(rule.trigger_keyword || '').toLowerCase();
    if (keyword === '') return false;

    switch (rule.match_type) {
        case 'exact':      return text === keyword;
        case 'contains':   return text.includes(keyword);
        case 'startswith': return text.startsWith(keyword);
        case 'regex':      return safeRegexTest(rule.trigger_keyword, text);
        default:           return false;
    }
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
    await new Promise(resolve => setTimeout(resolve, delayMs));

    // Send reply — prefer msg.reply() to avoid WhatsApp LID format issues
    try {
        if (msg) {
            await msg.reply(responseText);
        } else if (client) {
            const chatId = phone.includes('@') ? phone : `${phone}@c.us`;
            await client.sendMessage(chatId, responseText);
        }
    } catch (sendErr) {
        console.error('   ❌ Primary reply failed, attempting fallback...', sendErr.message?.split('\n')[0]);
        if (client && msg && msg.from) {
            await client.sendMessage(msg.from, responseText);
        } else {
            throw sendErr;
        }
    }
}

// ─── Process an incoming message through chatbot rules ──────
async function processMessage(userId, phone, messageText, contactName = '', client = null, msg = null) {
    // Log without the message body: this runs for every inbound message, and
    // customer message content in stdout ends up in any log aggregator,
    // container log, or terminal scrollback. Phone is partially masked for
    // the same reason.
    console.log(`🤖 processMessage: user ${userId}, ${maskPhone(phone)} (${messageText.length} chars)`);

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
        console.log(`⚠️ Rate limit exceeded for ${maskPhone(phone)}, ignoring message to prevent ban.`);
        return { replied: false, reason: 'rate_limit' };
    }

    if (isOverPlanLimit(userId)) {
        console.log(`⚠️ Account ${userId} has hit its monthly message limit — skipping auto-reply.`);
        return { replied: false, reason: 'plan_limit_reached' };
    }

    const chatbotEnabled = getSetting(userId, 'chatbot_enabled');
    if (chatbotEnabled !== 'true') {
        return { replied: false, reason: 'chatbot_disabled' };
    }

    const aiEnabled = getSetting(userId, 'ai_enabled');
    const aiMode = getSetting(userId, 'ai_mode') || 'ai_first';

    // ── 1. AI-FIRST PERSONA MODE ──────
    if (aiEnabled === 'true' && aiMode === 'ai_first') {
        const aiSystemPrompt = getSetting(userId, 'ai_system_prompt');
        const recentHistory = getConversation(userId, phone, { limit: AI_CONTEXT_MESSAGES });

        try {
            const aiResponse = await generateReply(userId, aiSystemPrompt, recentHistory, contactName, phone);
            await safeReply(client, phone, aiResponse, msg);
            logMessage(userId, { phone, contactName, direction: 'outgoing', body: aiResponse });
            return { replied: true, rule: 'ai_persona', response: aiResponse };
        } catch (aiErr) {
            console.warn('⚠️ AI Persona Mode failed (falling back to rules/default reply):', aiErr.message?.split('\n')[0]);
        }
    }

    // ── 2. STATIC AWAY MODE ───────
    const awayMode = getSetting(userId, 'away_mode');
    if (awayMode === 'true') {
        const awayMessage = getSetting(userId, 'away_message');
        if (awayMessage) {
            await safeReply(client, phone, awayMessage, msg);
            logMessage(userId, { phone, contactName, direction: 'outgoing', body: awayMessage });
            return { replied: true, rule: 'away_mode', response: awayMessage };
        }
    }

    // ── 3. KEYWORD RULES ──
    const text = messageText.trim().toLowerCase();
    const rules = getChatbotRules(userId, true);

    for (const rule of rules) {
        if (!ruleMatches(rule, text)) continue;

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

    // ── 4. AI Fallback (rules_first mode, nothing matched) ──
    if (aiEnabled === 'true') {
        const aiSystemPrompt = getSetting(userId, 'ai_system_prompt');
        const recentHistory = getConversation(userId, phone, { limit: AI_CONTEXT_MESSAGES });

        try {
            const aiResponse = await generateReply(userId, aiSystemPrompt, recentHistory, contactName, phone);
            await safeReply(client, phone, aiResponse, msg);
            logMessage(userId, { phone, contactName, direction: 'outgoing', body: aiResponse });
            return { replied: true, rule: 'ai_fallback', response: aiResponse };
        } catch (aiErr) {
            console.warn('⚠️ AI Fallback failed (falling back to default reply):', aiErr.message?.split('\n')[0]);
        }
    }

    // ── 5. Static Default Reply ──
    const defaultReply = getSetting(userId, 'default_reply');
    if (defaultReply) {
        await safeReply(client, phone, defaultReply, msg);
        logMessage(userId, { phone, contactName, direction: 'outgoing', body: defaultReply });
        return { replied: true, rule: 'default', response: defaultReply };
    }

    return { replied: false, reason: 'no_match' };
}

/** Masks the middle of a phone number for logs. 919876543210 → 9198****3210 */
function maskPhone(phone) {
    const s = String(phone || '');
    if (s.length <= 8) return '***';
    return `${s.slice(0, 4)}****${s.slice(-4)}`;
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
            response: 'Gemini AI will dynamically generate a natural, conversational response acting as you.'
        };
    }

    const text = String(messageText).trim().toLowerCase();
    const rules = getChatbotRules(userId, true);

    // Same matcher as the live path — see ruleMatches.
    for (const rule of rules) {
        if (!ruleMatches(rule, text)) continue;
        return {
            matched: true,
            ruleId: rule.id,
            keyword: rule.trigger_keyword,
            matchType: rule.match_type,
            response: rule.response_text
        };
    }

    if (aiEnabled === 'true') {
        return {
            matched: false,
            willSendDefault: false,
            willSendAI: true,
            defaultReply: 'Gemini AI will generate a dynamic response based on your System Prompt.'
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

module.exports = { processMessage, testMessage, ruleMatches, maskPhone };



