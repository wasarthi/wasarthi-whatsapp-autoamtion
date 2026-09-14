/* UI-only terminology. The authenticated server identity remains authoritative. */
window.VerticalContext = (() => {
    const definitions = Object.freeze({
        general: Object.freeze({ label: 'General / Sales', salesPipeline: true, labels: Object.freeze({ insights: 'Lead Analysis', inquiries: 'Leads', inquiry: 'Lead', priority: 'Lead Score', catalog: 'Product Catalog', profile: 'AI Business Analysis' }) }),
        healthcare: Object.freeze({ label: 'Healthcare', salesPipeline: true, labels: Object.freeze({ insights: 'Conversation Insights', inquiries: 'Inquiries', inquiry: 'Inquiry', priority: 'Inquiry Priority', catalog: 'Services Catalog', profile: 'AI Clinic Profile' }) })
    });
    let current = 'general';
    const get = () => definitions[current] || definitions.general;
    return Object.freeze({ set(value) { current = definitions[value] ? value : 'general'; return get(); }, get, isHealthcare() { return current === 'healthcare'; }, label(key, fallback = '') { return get().labels[key] || fallback; } });
})();
