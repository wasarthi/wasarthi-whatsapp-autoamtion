const { GoogleGenAI } = require('@google/genai');

const { getSetting } = require('./database');

let aiClient = null;

function initAi() {
    const apiKey = getSetting('gemini_api_key') || process.env.GEMINI_API_KEY;
    if (apiKey && apiKey !== 'your_gemini_api_key_here' && apiKey.trim() !== '') {
        aiClient = new GoogleGenAI({ apiKey: apiKey.trim() });
        console.log('   🔑 Gemini API key loaded OK (length:', apiKey.trim().length, ')');
    } else {
        aiClient = null;
        console.error('   ❌ Gemini API key is MISSING or not set in Settings!');
    }
}

/**
 * Generates an AI reply using Google Gemini
 * @param {string} systemPrompt - The behavior instructions for the AI
 * @param {Array} conversationHistory - Array of previous messages { direction, body }
 * @param {string} contactName - The name of the person we are talking to
 * @param {string} phone - The phone number of the contact
 * @returns {Promise<string>} The AI's response text
 */
async function generateReply(systemPrompt, conversationHistory, contactName = '', phone = '') {
    initAi();

    if (!aiClient) {
        console.error('❌ Gemini API key is missing or invalid.');
        return "I received your message! (Note: Gemini API key is needed to enable full AI replies).";
    }

    try {
        const ownerName = getSetting('owner_name') || 'the account owner';
        const businessName = getSetting('business_name') || '';

        const defaultPrompt = `You are a friendly, natural AI texting on WhatsApp on behalf of ${ownerName}.
Your goal is to chat naturally with the user, answer their questions, and assist them authentically.

Guidelines:
- Text like a real human on WhatsApp: warm, natural, friendly, and concise.
- Keep replies brief (1 to 3 sentences maximum), suitable for instant messaging.
- Avoid robotic or corporate phrasing. Never say "As an AI language model".
- Directly answer whatever they ask or chat casually if they're greeting or making conversation.
- If someone asks personal details or private schedule items you don't know, politely say you'll pass the message to ${ownerName}.
- Use occasional emojis naturally.`;

        const personalizedInstruction = `${systemPrompt || defaultPrompt}

Context:
- Chatting with: ${contactName || 'Friend/Customer'} (Phone: ${phone || 'Unknown'})
- Replying on behalf of: ${ownerName}
${businessName ? `- Business/Organization: ${businessName}` : ''}`;

        // Format conversation history for Gemini (consecutive alternating messages)
        const contents = [];
        const validHistory = (conversationHistory || []).filter(msg => msg.body && msg.body.trim() !== '');

        // Build valid alternating chat contents
        for (const msg of validHistory) {
            const role = msg.direction === 'incoming' ? 'user' : 'model';
            contents.push({
                role: role,
                parts: [{ text: msg.body.trim() }]
            });
        }

        if (contents.length === 0) {
            contents.push({ role: 'user', parts: [{ text: 'Hi' }] });
        }

        const modelsToTry = [
            'gemini-3.5-flash',
            'gemini-3.6-flash',
            'gemini-flash-latest',
            'gemini-pro-latest',
            'gemini-2.0-flash-lite',
            'gemini-2.0-flash'
        ];
        let response = null;
        let lastError = null;

        for (const model of modelsToTry) {
            try {
                response = await aiClient.models.generateContent({
                    model: model,
                    contents: contents,
                    config: {
                        systemInstruction: personalizedInstruction,
                        temperature: 0.75
                    }
                });
                if (response && (response.text || response.candidates?.[0]?.content?.parts?.[0]?.text)) {
                    break;
                }
            } catch (modelErr) {
                lastError = modelErr;
                console.log(`   ⚠️ Model ${model} failed, trying next...`, modelErr.message?.split('\n')[0]);
            }
        }

        const text = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            throw lastError || new Error('Empty response from Gemini');
        }

        return text.trim();
    } catch (error) {
        console.error('❌ Gemini AI Error:', error.message || error);
        throw error; // Throw so chatbot.js can fallback to rules/default reply
    }
}

module.exports = { generateReply };
