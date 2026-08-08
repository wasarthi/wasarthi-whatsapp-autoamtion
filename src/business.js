const { GoogleGenAI } = require('@google/genai');
const { getSetting, setSetting, getProducts } = require('./database');

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

// ─── Raw business info (what the owner typed in Settings) ───
function getBusinessInfo(userId) {
    return {
        name:            getSetting(userId, 'business_name') || '',
        website:         getSetting(userId, 'business_website') || '',
        industry:        getSetting(userId, 'business_industry') || '',
        description:     getSetting(userId, 'business_description') || '',
        targetCustomers: getSetting(userId, 'business_target_customers') || '',
        offers:          getSetting(userId, 'business_offers') || '',
        currency:        getSetting(userId, 'business_currency') || '₹',
        products:        getProducts(userId, true)
    };
}

function hasBusinessInfo(info) {
    return !!(info.description || info.industry || info.website || info.offers || info.products.length);
}

/**
 * Builds a compact text block describing the business, for injection into
 * AI prompts (auto-replies and lead analysis). Returns '' if nothing is set up.
 */
function getBusinessContext(userId) {
    const info = getBusinessInfo(userId);
    if (!hasBusinessInfo(info)) return '';

    const lines = [];
    if (info.name)            lines.push(`Business: ${info.name}`);
    if (info.website)         lines.push(`Website: ${info.website}`);
    if (info.industry)        lines.push(`Industry: ${info.industry}`);
    if (info.description)     lines.push(`About: ${info.description}`);
    if (info.targetCustomers) lines.push(`Target customers: ${info.targetCustomers}`);
    if (info.offers)          lines.push(`Current offers/promotions: ${info.offers}`);

    if (info.products.length) {
        lines.push('Products / Services catalog:');
        for (const p of info.products.slice(0, 40)) {
            const bits = [p.name];
            if (p.price)       bits.push(`price: ${p.price}`);
            if (p.category)    bits.push(`category: ${p.category}`);
            if (p.description) bits.push(p.description);
            if (p.url)         bits.push(`link: ${p.url}`);
            lines.push(`  - ${bits.join(' | ')}`);
        }
    }

    // Include the AI-generated sales brief if the owner has run the analysis
    const profileRaw = getSetting(userId, 'business_ai_profile');
    if (profileRaw) {
        try {
            const profile = JSON.parse(profileRaw);
            if (profile.profile_summary) lines.push(`Sales positioning: ${profile.profile_summary}`);
            if (Array.isArray(profile.selling_points) && profile.selling_points.length) {
                lines.push(`Key selling points: ${profile.selling_points.join('; ')}`);
            }
        } catch (e) { /* ignore malformed stored profile */ }
    }

    return lines.join('\n');
}

// ─── Robust JSON extraction ─────────────────────────────────
function parseJsonBlock(text) {
    if (!text) return null;
    let cleaned = text.trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        return JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {
        return null;
    }
}

// ─── AI Business Analysis ───────────────────────────────────
/**
 * Analyzes the business setup with Gemini and produces a sales brief:
 * positioning summary, selling points, ideal customer, pitch, objection
 * handling, and suggested FAQs. Saved to settings as business_ai_profile.
 */
async function analyzeBusinessProfile(userId) {
    const aiClient = getAiClient(userId);
    if (!aiClient) {
        throw new Error('Gemini API key is missing — set it in Settings → AI Behavior.');
    }

    const info = getBusinessInfo(userId);
    if (!hasBusinessInfo(info)) {
        throw new Error('Add some business details or products first, then run the analysis.');
    }

    const productText = info.products.length
        ? info.products.map(p => `- ${p.name}${p.price ? ` (${p.price})` : ''}${p.category ? ` [${p.category}]` : ''}${p.description ? `: ${p.description}` : ''}`).join('\n')
        : '(no products listed)';

    const systemInstruction = `You are a senior sales strategist. Analyze the business below and respond with ONLY a valid JSON object (no markdown, no code fences) with exactly these fields:

{
  "profile_summary": "2-3 sentence positioning summary of what this business sells and to whom",
  "selling_points": ["3-6 short, concrete selling points"],
  "ideal_customer": "1-2 sentence description of the ideal customer",
  "sales_pitch": "a short natural WhatsApp-friendly pitch message (2-4 sentences) the owner could send to an interested lead",
  "objection_handling": [{"objection": "common objection a customer may raise", "response": "short suggested reply"}],
  "faq": [{"q": "likely customer question", "a": "short suggested answer"}],
  "improvement_tips": ["2-4 practical tips to improve conversions on WhatsApp for this business"]
}

Keep everything concise and practical. Use the same currency the business uses (${info.currency}).`;

    const userText = `BUSINESS DETAILS:
Name: ${info.name || '(not set)'}
Website: ${info.website || '(not set)'}
Industry: ${info.industry || '(not set)'}
Description: ${info.description || '(not set)'}
Target customers: ${info.targetCustomers || '(not set)'}
Current offers: ${info.offers || '(none)'}

PRODUCTS / SERVICES:
${productText}`;

    let text = null;
    let lastError = null;
    for (const model of MODELS_TO_TRY) {
        try {
            const response = await aiClient.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ text: userText }] }],
                config: {
                    systemInstruction,
                    temperature: 0.3,
                    responseMimeType: 'application/json'
                }
            });
            text = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) break;
        } catch (err) {
            lastError = err;
            console.log(`   ⚠️ Business analysis: model ${model} failed, trying next...`, err.message?.split('\n')[0]);
        }
    }

    if (!text) {
        throw lastError || new Error('Empty response from Gemini during business analysis.');
    }

    const profile = parseJsonBlock(text);
    if (!profile) {
        throw new Error('Could not parse business analysis JSON from Gemini response.');
    }

    profile.analyzed_at = new Date().toISOString();
    setSetting(userId, 'business_ai_profile', JSON.stringify(profile));
    console.log('   🏪 Business AI profile saved.');
    return profile;
}

module.exports = {
    getBusinessInfo,
    getBusinessContext,
    analyzeBusinessProfile
};
