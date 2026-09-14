/** Server-owned definition of the account verticals supported by this app. */
const BUSINESS_VERTICALS = Object.freeze({ GENERAL: 'general', HEALTHCARE: 'healthcare' });
const DEFAULT_BUSINESS_VERTICAL = BUSINESS_VERTICALS.GENERAL;

const VERTICALS = Object.freeze({
    [BUSINESS_VERTICALS.GENERAL]: Object.freeze({
        id: BUSINESS_VERTICALS.GENERAL,
        label: 'General / Sales',
        capabilities: Object.freeze({ salesPipeline: true }),
        terminology: Object.freeze({ insights: 'Lead Analysis', inquiry: 'Lead', inquiries: 'Leads', priority: 'Lead Score', catalog: 'Product Catalog', businessProfile: 'AI Business Analysis' })
    }),
    [BUSINESS_VERTICALS.HEALTHCARE]: Object.freeze({
        id: BUSINESS_VERTICALS.HEALTHCARE,
        label: 'Healthcare',
        capabilities: Object.freeze({ salesPipeline: false }),
        terminology: Object.freeze({ insights: 'Conversation Insights', inquiry: 'Inquiry', inquiries: 'Inquiries', priority: 'Inquiry Priority', catalog: 'Services Catalog', businessProfile: 'AI Clinic Profile' })
    })
});

function isBusinessVertical(value) { return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VERTICALS, value); }
function getBusinessVertical(value) { return isBusinessVertical(value) ? value : DEFAULT_BUSINESS_VERTICAL; }
function getVerticalConfig(value) { return VERTICALS[getBusinessVertical(value)]; }

module.exports = { BUSINESS_VERTICALS, DEFAULT_BUSINESS_VERTICAL, VERTICALS, isBusinessVertical, getBusinessVertical, getVerticalConfig };
