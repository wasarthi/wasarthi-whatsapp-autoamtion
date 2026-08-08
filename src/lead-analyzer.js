const { GoogleGenAI } = require('@google/genai');
const {
    getSetting, getConversation, getContactByPhone, upsertContact,
    saveLeadAnalysis, getLeadAnalysis, getConversationPhones,
    aiUpsertCrmDeal
} = require('./database');
const { getBusinessContext } = require('./business');

// ─── Gemini client ──────────────────────────────────────────
function getAiClient(userId) {
    const apiKey = getSetting(userId, 'gemini_api_key') || process.env.GEMINI_API_KEY;
    if (apiKey && apiKey !== 'your_gemini_api_key_here' && apiKey.trim() !== '') {
        return new GoogleGenAI({ apiKey: apiKey.trim() });
    }
    return null;
}

const MODELS_TO_TRY = [
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-flash-latest',
    'gemini-pro-latest',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash'
];

// ─── Analysis prompt ────────────────────────────────────────
function buildAnalysisPrompt(businessName, ownerName, businessContext, currency) {
    return `You are a sales/CRM analyst. You will be given a WhatsApp conversation between ${ownerName || 'the business owner'}${businessName ? ` (business: ${businessName})` : ''} and a contact.
${businessContext ? `\nBUSINESS CONTEXT (use this to judge sales potential, match products, and estimate deal value):\n${businessContext}\n` : ''}
Analyze the ENTIRE conversation and respond with ONLY a valid JSON object (no markdown, no code fences, no extra text) with exactly these fields:

{
  "summary": "2-4 sentence summary of the whole conversation: who the contact is, what they wanted, and how it went",
  "interest_status": "interested" | "not_interested" | "neutral" | "unclear",
  "interest_score": 0-100 (how likely this contact is to buy / convert / continue engaging),
  "sentiment": "positive" | "neutral" | "negative" | "frustrated",
  "issue_category": one short category like "pricing", "product question", "complaint", "support/technical issue", "delivery", "general inquiry", "spam", "personal chat", or "" if none,
  "issues": ["list of specific problems, objections, or questions the contact raised", "empty array if none"],
  "priority": "high" | "medium" | "low",
  "priority_reason": "one sentence on why this priority (e.g. hot lead ready to buy, unresolved complaint, or just casual chat)",
  "next_action": "one concrete recommended follow-up action for the owner",
  "product_interest": "which product(s)/service(s) from the catalog the contact is interested in, matched by name — or '' if none/unknown",
  "estimated_value": estimated potential deal value as a plain number in ${currency || 'the business currency'} (use catalog prices when they match; 0 if unknown or not a sales conversation),
  "suggested_stage": "new" | "contacted" | "qualified" | "proposal" | "negotiation" | "won" | "lost",
  "is_sales_conversation": true | false (false for personal chats, spam, and anything with no business relevance)
}

Priority guidance:
- high: ready to buy, asking for price/booking, unresolved complaint, frustrated customer, time-sensitive request
- medium: engaged and asking questions but not urgent
- low: casual/personal chat, spam, clearly not interested, or conversation fully resolved

Sales stage guidance:
- new: contact reached out but no meaningful qualification yet
- contacted: conversation started, still exploring what they need
- qualified: real need + budget/intent is visible
- proposal: prices/options/quotes have been shared
- negotiation: discussing price, discounts, terms, or final details
- won: they agreed to buy / paid / booked
- lost: clearly declined or went silent after rejecting

Interest guidance: "interested" only if the contact shows real buying/engagement intent; personal chats between friends are "neutral" with issue_category "personal chat" and is_sales_conversation false.`;
}

// ─── Robust JSON extraction ─────────────────────────────────
function parseAnalysisJson(text) {
    if (!text) return null;
    let cleaned = text.trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/,'')
        .trim();
    // Grab the outermost JSON object if there's surrounding text
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    cleaned = cleaned.slice(start, end + 1);
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        return null;
    }
}

function normalizeAnalysis(raw, messageCount, contactName) {
    const validInterest = ['interested', 'not_interested', 'neutral', 'unclear'];
    const validPriority = ['high', 'medium', 'low'];

    let interestStatus = String(raw.interest_status || 'unclear').toLowerCase().replace(/\s+/g, '_');
    if (!validInterest.includes(interestStatus)) interestStatus = 'unclear';

    let priority = String(raw.priority || 'low').toLowerCase();
    if (!validPriority.includes(priority)) priority = 'low';

    let interestScore = parseInt(raw.interest_score, 10);
    if (isNaN(interestScore)) interestScore = 0;
    interestScore = Math.max(0, Math.min(100, interestScore));

    const validStages = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
    let suggestedStage = String(raw.suggested_stage || 'new').toLowerCase();
    if (!validStages.includes(suggestedStage)) suggestedStage = 'new';

    let estimatedValue = parseFloat(raw.estimated_value);
    if (isNaN(estimatedValue) || estimatedValue < 0) estimatedValue = 0;

    return {
        contactName: contactName || '',
        summary: String(raw.summary || '').slice(0, 2000),
        interestStatus,
        interestScore,
        sentiment: String(raw.sentiment || 'neutral').slice(0, 30),
        issueCategory: String(raw.issue_category || '').slice(0, 100),
        issues: Array.isArray(raw.issues) ? raw.issues.map(i => String(i).slice(0, 300)).slice(0, 10) : [],
        priority,
        priorityReason: String(raw.priority_reason || '').slice(0, 500),
        nextAction: String(raw.next_action || '').slice(0, 500),
        messageCount,
        // Sales / CRM fields
        productInterest: String(raw.product_interest || '').slice(0, 300),
        estimatedValue,
        suggestedStage,
        isSalesConversation: raw.is_sales_conversation !== false
    };
}

// ─── Contact auto-labeling ──────────────────────────────────
function labelForAnalysis(analysis) {
    if (analysis.interestStatus === 'interested') {
        return analysis.priority === 'high' ? '🔥 Hot Lead' : 'Interested';
    }
    if (analysis.interestStatus === 'not_interested') return 'Not Interested';
    if (analysis.issueCategory && /complaint|support|technical|delivery/i.test(analysis.issueCategory)) {
        return 'Needs Support';
    }
    return '';
}

// ─── Core: analyze one conversation ─────────────────────────
/**
 * Analyze the full conversation of one phone number with Gemini.
 * Saves the result in lead_analysis and (optionally) updates the contact label.
 * @returns {Promise<object>} the saved analysis row
 */
async function analyzeConversation(userId, phone) {
    const aiClient = getAiClient(userId);
    if (!aiClient) {
        throw new Error('Gemini API key is missing — set it in Settings → AI Behavior.');
    }

    const messages = getConversation(userId, phone) || [];
    const withText = messages.filter(m => m.body && m.body.trim() !== '');
    if (withText.length === 0) {
        throw new Error('No messages found for this contact.');
    }

    const contact = getContactByPhone(userId, phone);
    const contactName = (contact && contact.name) || withText.find(m => m.contact_name)?.contact_name || '';

    // Build a readable transcript (cap to the most recent 80 messages to stay within limits)
    const recent = withText.slice(-80);
    const transcript = recent.map(m => {
        const who = m.direction === 'incoming' ? (contactName || 'Contact') : 'Owner';
        return `[${m.created_at}] ${who}: ${m.body.trim()}`;
    }).join('\n');

    const businessName = getSetting(userId, 'business_name') || '';
    const ownerName = getSetting(userId, 'owner_name') || '';
    const currency = getSetting(userId, 'business_currency') || '₹';

    let businessContext = '';
    try {
        businessContext = getBusinessContext(userId);
    } catch (e) {
        console.warn('   ⚠️ Could not load business context for analysis (non-fatal):', e.message);
    }

    const systemInstruction = buildAnalysisPrompt(businessName, ownerName, businessContext, currency);

    let text = null;
    let lastError = null;
    for (const model of MODELS_TO_TRY) {
        try {
            const response = await aiClient.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ text: `Conversation with ${contactName || phone} (${phone}):\n\n${transcript}` }] }],
                config: {
                    systemInstruction,
                    temperature: 0.2,
                    responseMimeType: 'application/json'
                }
            });
            text = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) break;
        } catch (err) {
            lastError = err;
            console.log(`   ⚠️ Lead analysis: model ${model} failed, trying next...`, err.message?.split('\n')[0]);
        }
    }

    if (!text) {
        throw lastError || new Error('Empty response from Gemini during lead analysis.');
    }

    const raw = parseAnalysisJson(text);
    if (!raw) {
        throw new Error('Could not parse analysis JSON from Gemini response.');
    }

    const analysis = normalizeAnalysis(raw, messages.length, contactName);
    const saved = saveLeadAnalysis(userId, phone, analysis);

    // Auto-update the contact label so the verdict shows in the Contacts tab
    try {
        const label = labelForAnalysis(analysis);
        if (label) {
            upsertContact(userId, phone, contactName, label, '');
        }
    } catch (labelErr) {
        console.warn('   ⚠️ Could not auto-label contact:', labelErr.message);
    }

    // Create/refresh the CRM deal for sales conversations (skips personal chats & spam).
    // Manual stage/value set by the owner in the CRM is never overridden.
    try {
        const isPersonalOrSpam = /personal chat|spam/i.test(analysis.issueCategory);
        if (analysis.isSalesConversation && !isPersonalOrSpam) {
            aiUpsertCrmDeal(userId, phone, {
                contactName: analysis.contactName,
                suggestedStage: analysis.suggestedStage,
                estimatedValue: analysis.estimatedValue,
                productInterest: analysis.productInterest
            });
        }
    } catch (crmErr) {
        console.warn('   ⚠️ Could not sync CRM deal:', crmErr.message);
    }

    console.log(`   🎯 Lead analysis saved for ${contactName || phone}: ${analysis.interestStatus} / ${analysis.priority} priority (score ${analysis.interestScore})`);
    return saved;
}

// ─── Analyze all conversations ──────────────────────────────
/**
 * Analyze every conversation that has incoming messages.
 * @param {boolean} onlyStale - if true, skip conversations whose analysis is
 *                              already up to date (no new messages since last run)
 */
async function analyzeAllConversations(userId, onlyStale = true) {
    const phones = getConversationPhones(userId);
    const results = { analyzed: [], skipped: [], failed: [] };

    for (const row of phones) {
        try {
            if (onlyStale) {
                const existing = getLeadAnalysis(userId, row.phone);
                if (existing && existing.message_count >= row.message_count) {
                    results.skipped.push(row.phone);
                    continue;
                }
            }
            const saved = await analyzeConversation(userId, row.phone);
            results.analyzed.push(saved);
            // Small pause between calls to be kind to API rate limits
            await new Promise(r => setTimeout(r, 800));
        } catch (err) {
            console.error(`   ❌ Lead analysis failed for ${row.phone}:`, err.message?.split('\n')[0]);
            results.failed.push({ phone: row.phone, error: err.message });
        }
    }
    return results;
}

// ─── Auto-analysis (debounced per contact) ──────────────────
// After an incoming message, wait for the conversation to go quiet for
// AUTO_ANALYZE_DELAY_MS, then analyze it once — avoids one API call per message.
const AUTO_ANALYZE_DELAY_MS = 3 * 60 * 1000; // 3 minutes of quiet
const pendingTimers = new Map();

function scheduleAutoAnalysis(userId, phone) {
    const enabled = getSetting(userId, 'lead_analysis_auto');
    if (enabled === 'false') return; // default (null/'true') = on

    const key = `${userId}:${phone}`;
    if (pendingTimers.has(key)) {
        clearTimeout(pendingTimers.get(key));
    }
    const timer = setTimeout(async () => {
        pendingTimers.delete(key);
        try {
            await analyzeConversation(userId, phone);
        } catch (err) {
            console.error(`   ⚠️ Auto lead-analysis failed for user ${userId} / ${phone}:`, err.message?.split('\n')[0]);
        }
    }, AUTO_ANALYZE_DELAY_MS);
    // Don't let a pending timer keep the process alive on shutdown
    if (typeof timer.unref === 'function') timer.unref();
    pendingTimers.set(key, timer);
}

module.exports = {
    analyzeConversation,
    analyzeAllConversations,
    scheduleAutoAnalysis
};
