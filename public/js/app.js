/* ═══════════════════════════════════════════════════════════
   WhatsApp Automation Dashboard — Frontend Logic v2
   ═══════════════════════════════════════════════════════════ */

const API = '';

// ─── State ──────────────────────────────────────────────────
let currentSection = 'dashboard';

// ─── API Client ─────────────────────────────────────────────
async function api(endpoint, options = {}) {
    try {
        const res = await fetch(`${API}${endpoint}`, {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'API request failed');
        return data.data;
    } catch (err) {
        console.error(`API Error [${endpoint}]:`, err);
        throw err;
    }
}

// ─── Toast Notifications ────────────────────────────────────
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const icons = { success: '✅', error: '❌', info: 'ℹ️' };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">${icons[type]}</span>
        <span class="toast-text">${escapeHtml(message)}</span>
        <button class="toast-close" aria-label="Dismiss notification" onclick="this.parentElement.remove()">×</button>
    `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.35s ease forwards';
        setTimeout(() => toast.remove(), 350);
    }, 4000);
}

// ─── Error Banner ────────────────────────────────────────────
function showErrorBanner(containerId, message, retryFn) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.style.display = 'flex';
    el.innerHTML = `
        <div class="error-banner" role="alert">
            <span aria-hidden="true">⚠️</span>
            <span>${escapeHtml(message)}</span>
            ${retryFn ? `<button class="error-retry" type="button">Retry</button>` : ''}
        </div>
    `;
    if (retryFn) {
        el.querySelector('.error-retry').addEventListener('click', () => {
            clearErrorBanner(containerId);
            retryFn();
        });
    }
}

function clearErrorBanner(containerId) {
    const el = document.getElementById(containerId);
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

// ─── Skeleton Helpers ─────────────────────────────────────────
function showSkeleton(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
}

function hideSkeleton(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

// ─── Navigation ─────────────────────────────────────────────
function navigateTo(section) {
    currentSection = section;

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        const active = item.dataset.section === section;
        item.classList.toggle('active', active);
        item.setAttribute('aria-current', active ? 'page' : 'false');
    });

    // Show section
    document.querySelectorAll('.section').forEach(sec => {
        sec.classList.toggle('active', sec.id === `section-${section}`);
    });

    // Close mobile sidebar
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('overlay');
    const menuToggle = document.getElementById('menuToggle');
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
    if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');

    // Load section data
    loadSectionData(section);
}

function loadSectionData(section) {
    switch (section) {
        case 'dashboard': loadDashboard(); break;
        case 'messages':  loadMessages();  break;
        case 'chatbot':   loadChatbotRules(); break;
        case 'contacts':  loadContacts(); break;
        case 'scheduled': loadScheduled(); break;
        case 'settings':  loadSettings(); break;
    }
}

// ─── Settings Tab Switching ──────────────────────────────────
function initSettingsTabs() {
    const tabs = document.querySelectorAll('.settings-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;

            // Update tab buttons
            tabs.forEach(t => {
                t.classList.toggle('active', t === tab);
                t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
            });

            // Update panels
            document.querySelectorAll('.settings-panel').forEach(panel => {
                panel.classList.toggle('active', panel.id === `stab-${target}`);
            });
        });
    });
}

// ═══════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════
async function loadDashboard() {
    clearErrorBanner('dashboardError');
    try {
        const stats = await api('/api/dashboard/stats');

        // Update demo mode indicator
        const indicator = document.getElementById('modeIndicator');
        if (indicator) {
            if (stats.demoMode) {
                indicator.textContent = '🧪 Demo Mode';
                indicator.style.color = 'var(--color-warning)';
            } else {
                indicator.textContent = '🟢 Live';
                indicator.style.color = 'var(--color-primary-500)';
            }
        }

        // Update stat cards with animation
        animateValue('valSentToday',     stats.sentToday);
        animateValue('valReceivedToday', stats.receivedToday);
        animateValue('valContacts',      stats.totalContacts);
        animateValue('valActiveRules',   stats.activeRules);

        // Recent activity
        hideSkeleton('activitySkeleton');
        const activityEl = document.getElementById('recentActivity');
        if (stats.recentMessages.length === 0) {
            activityEl.innerHTML = `
                <div class="empty-state">
                    <span class="empty-state-icon" aria-hidden="true">🚀</span>
                    <div class="empty-state-title">No messages yet</div>
                    <p>Send your first message to get started!</p>
                </div>`;
        } else {
            activityEl.innerHTML = stats.recentMessages.map(msg => `
                <div class="activity-item">
                    <span class="activity-direction" aria-hidden="true">${msg.direction === 'incoming' ? '📥' : '📤'}</span>
                    <div class="activity-details">
                        <div class="activity-phone">${escapeHtml(msg.contact_name || msg.phone)}</div>
                        <div class="activity-text">${escapeHtml(msg.body)}</div>
                    </div>
                    <span class="activity-time">${timeAgo(msg.created_at)}</span>
                </div>
            `).join('');
        }
    } catch (err) {
        hideSkeleton('activitySkeleton');
        showErrorBanner('dashboardError', 'Failed to load dashboard data.', loadDashboard);
    }
}

function animateValue(elementId, target) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const start = parseInt(el.textContent) || 0;
    const duration = 600;
    const startTime = performance.now();

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.round(start + (target - start) * eased);
        if (progress < 1) requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
}

// ═══════════════════════════════════════════════════════════
//  MESSAGES
// ═══════════════════════════════════════════════════════════
async function loadMessages() {
    clearErrorBanner('messagesError');
    try {
        const phone     = document.getElementById('messageSearch')?.value || '';
        const direction = document.getElementById('messageFilter')?.value || '';

        let endpoint = '/api/messages?limit=200';
        if (phone)     endpoint += `&phone=${encodeURIComponent(phone)}`;
        if (direction) endpoint += `&direction=${direction}`;

        const messages = await api(endpoint);
        const tbody = document.getElementById('messagesBody');

        if (messages.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5">
                        <div class="empty-state">
                            <span class="empty-state-icon" aria-hidden="true">💬</span>
                            <div class="empty-state-title">No messages found</div>
                            <p>Try adjusting your search or filter.</p>
                        </div>
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = messages.map(msg => `
            <tr>
                <td><span class="badge badge-${msg.direction}">${msg.direction === 'incoming' ? '📥 In' : '📤 Out'}</span></td>
                <td>
                    <strong>${escapeHtml(msg.contact_name || msg.phone)}</strong>
                    ${msg.contact_name ? `<br><small style="color:var(--color-text-secondary)">${escapeHtml(msg.phone)}</small>` : ''}
                </td>
                <td><span class="msg-truncate">${escapeHtml(msg.body)}</span></td>
                <td><span class="badge badge-${msg.status}">${escapeHtml(msg.status)}</span></td>
                <td style="white-space:nowrap;color:var(--color-text-secondary)">${formatDate(msg.created_at)}</td>
            </tr>
        `).join('');
    } catch (err) {
        showErrorBanner('messagesError', 'Failed to load messages.', loadMessages);
        document.getElementById('messagesBody').innerHTML =
            '<tr><td colspan="5" class="empty-state">Could not load messages.</td></tr>';
    }
}

// ═══════════════════════════════════════════════════════════
//  CHATBOT RULES
// ═══════════════════════════════════════════════════════════
async function loadChatbotRules() {
    clearErrorBanner('chatbotError');
    showSkeleton('rulesSkeleton');
    try {
        const rules = await api('/api/chatbot/rules');
        hideSkeleton('rulesSkeleton');
        const container = document.getElementById('rulesList');

        if (rules.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="empty-state-icon" aria-hidden="true">🤖</span>
                    <div class="empty-state-title">No chatbot rules yet</div>
                    <p>Add your first rule above to get started!</p>
                </div>`;
            return;
        }

        container.innerHTML = rules.map(rule => `
            <div class="rule-item ${rule.is_active ? '' : 'disabled'}" data-id="${rule.id}">
                <div class="rule-info">
                    <div class="rule-trigger">
                        <span class="rule-keyword">"${escapeHtml(rule.trigger_keyword)}"</span>
                        <span class="rule-match-type">${escapeHtml(rule.match_type)}</span>
                        ${!rule.is_active ? '<span class="badge badge-cancelled">Disabled</span>' : ''}
                    </div>
                    <div class="rule-response">${escapeHtml(rule.response_text)}</div>
                    <div class="rule-meta">
                        <span>Priority: ${rule.priority}</span>
                        <span aria-hidden="true">•</span>
                        <span>Hits: ${rule.hit_count}</span>
                    </div>
                </div>
                <div class="rule-actions">
                    <button
                        class="btn btn-sm btn-secondary"
                        onclick="toggleRule(${rule.id}, ${rule.is_active ? 0 : 1})"
                        title="${rule.is_active ? 'Disable rule' : 'Enable rule'}"
                        aria-label="${rule.is_active ? 'Disable' : 'Enable'} rule: ${escapeHtml(rule.trigger_keyword)}"
                        type="button">
                        ${rule.is_active ? '⏸️' : '▶️'}
                    </button>
                    <button
                        class="btn btn-sm btn-danger"
                        onclick="deleteRule(${rule.id})"
                        title="Delete rule"
                        aria-label="Delete rule: ${escapeHtml(rule.trigger_keyword)}"
                        type="button">
                        🗑️
                    </button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        hideSkeleton('rulesSkeleton');
        showErrorBanner('chatbotError', 'Failed to load chatbot rules.', loadChatbotRules);
        document.getElementById('rulesList').innerHTML = '';
    }
}

async function toggleRule(id, newState) {
    try {
        await api(`/api/chatbot/rules/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ is_active: newState })
        });
        showToast(`Rule ${newState ? 'enabled' : 'disabled'}`, 'success');
        loadChatbotRules();
    } catch (err) {
        showToast('Failed to update rule', 'error');
    }
}

async function deleteRule(id) {
    if (!confirm('Are you sure you want to delete this rule?')) return;
    try {
        await api(`/api/chatbot/rules/${id}`, { method: 'DELETE' });
        showToast('Rule deleted', 'success');
        loadChatbotRules();
    } catch (err) {
        showToast('Failed to delete rule', 'error');
    }
}

async function testChatbot() {
    const input    = document.getElementById('testMessage');
    const resultEl = document.getElementById('testResult');
    const text     = input.value.trim();

    if (!text) { input.focus(); return; }

    const btn = document.getElementById('testChatbotBtn');
    btn.disabled = true;
    btn.textContent = 'Testing…';

    try {
        const result = await api('/api/chatbot/test', {
            method: 'POST',
            body: JSON.stringify({ message: text })
        });

        resultEl.style.display = 'block';

        if (result.matched) {
            resultEl.className = 'test-result matched';
            resultEl.innerHTML = `
                <strong>✅ Rule #${result.ruleId} matched!</strong><br>
                <strong>Keyword:</strong> "${escapeHtml(result.keyword)}" (${escapeHtml(result.matchType)})<br>
                <strong>Response:</strong> ${escapeHtml(result.response)}
            `;
        } else {
            resultEl.className = 'test-result no-match';
            resultEl.innerHTML = result.willSendDefault
                ? `<strong>⚠️ No rule matched.</strong> Default reply will be sent:<br>"${escapeHtml(result.defaultReply)}"`
                : '<strong>⚠️ No rule matched</strong> and no default reply configured.';
        }
    } catch (err) {
        showToast('Test failed', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Test';
    }
}

// ═══════════════════════════════════════════════════════════
//  CONTACTS
// ═══════════════════════════════════════════════════════════
async function loadContacts() {
    clearErrorBanner('contactsError');
    try {
        const search   = document.getElementById('contactSearch')?.value || '';
        let endpoint   = '/api/contacts';
        if (search) endpoint += `?search=${encodeURIComponent(search)}`;

        const contacts = await api(endpoint);
        const tbody    = document.getElementById('contactsBody');

        if (contacts.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5">
                        <div class="empty-state">
                            <span class="empty-state-icon" aria-hidden="true">👥</span>
                            <div class="empty-state-title">No contacts found</div>
                            <p>${search ? 'Try a different search term.' : 'Add your first contact above!'}</p>
                        </div>
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = contacts.map(c => `
            <tr>
                <td><strong>${escapeHtml(c.name) || '—'}</strong></td>
                <td style="color:var(--color-text-secondary)">${escapeHtml(c.phone)}</td>
                <td>${c.label ? `<span class="badge badge-incoming">${escapeHtml(c.label)}</span>` : '—'}</td>
                <td style="white-space:nowrap;color:var(--color-text-secondary)">${formatDate(c.created_at)}</td>
                <td>
                    <button
                        class="btn btn-sm btn-danger"
                        onclick="deleteContact(${c.id})"
                        title="Delete contact"
                        aria-label="Delete contact ${escapeHtml(c.name || c.phone)}"
                        type="button">🗑️</button>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        showErrorBanner('contactsError', 'Failed to load contacts.', loadContacts);
    }
}

async function deleteContact(id) {
    if (!confirm('Delete this contact?')) return;
    try {
        await api(`/api/contacts/${id}`, { method: 'DELETE' });
        showToast('Contact deleted', 'success');
        loadContacts();
    } catch (err) {
        showToast('Failed to delete contact', 'error');
    }
}

// ═══════════════════════════════════════════════════════════
//  SCHEDULED MESSAGES
// ═══════════════════════════════════════════════════════════
async function loadScheduled() {
    clearErrorBanner('scheduledError');
    try {
        const messages = await api('/api/scheduled');
        const tbody    = document.getElementById('scheduledBody');

        if (messages.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5">
                        <div class="empty-state">
                            <span class="empty-state-icon" aria-hidden="true">⏰</span>
                            <div class="empty-state-title">No scheduled messages</div>
                            <p>Schedule your first message above!</p>
                        </div>
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = messages.map(msg => `
            <tr>
                <td style="color:var(--color-text-secondary)">${escapeHtml(msg.phone)}</td>
                <td><span class="msg-truncate">${escapeHtml(msg.body)}</span></td>
                <td style="white-space:nowrap;color:var(--color-text-secondary)">${formatDate(msg.scheduled_at)}</td>
                <td>
                    <span class="pill pill-${msg.status === 'pending' ? 'pending' : msg.status === 'sent' ? 'active' : 'error'}">
                        ${escapeHtml(msg.status)}
                    </span>
                </td>
                <td>
                    ${msg.status === 'pending'
                        ? `<button class="btn btn-sm btn-danger" onclick="cancelScheduled(${msg.id})" aria-label="Cancel scheduled message" type="button">Cancel</button>`
                        : '—'}
                </td>
            </tr>
        `).join('');
    } catch (err) {
        showErrorBanner('scheduledError', 'Failed to load scheduled messages.', loadScheduled);
    }
}

async function cancelScheduled(id) {
    if (!confirm('Cancel this scheduled message?')) return;
    try {
        await api(`/api/scheduled/${id}`, { method: 'DELETE' });
        showToast('Scheduled message cancelled', 'success');
        loadScheduled();
    } catch (err) {
        showToast('Failed to cancel', 'error');
    }
}

// ═══════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════
async function loadSettings() {
    try {
        const settings = await api('/api/settings');

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = val === 'true';
            else el.value = val || '';
        };

        set('settBusinessName',   settings.business_name);
        set('settChatbotEnabled', settings.chatbot_enabled);
        set('settDefaultReply',   settings.default_reply);
        set('settAwayMode',       settings.away_mode);
        set('settAwayMessage',    settings.away_message);
        set('settWelcomeMessage', settings.welcome_message);
        set('settAiEnabled',      settings.ai_enabled);
        set('settOwnerName',      settings.owner_name);
        set('settAiMode',         settings.ai_mode || 'ai_first');
        set('settAiSystemPrompt', settings.ai_system_prompt);
        set('settGeminiApiKey',   settings.gemini_api_key);
    } catch (err) {
        showToast('Failed to load settings', 'error');
    }
}

// ─── QR / SSE ────────────────────────────────────────────────
function initSSE() {
    const eventSource = new EventSource('/api/qr-stream');

    eventSource.onmessage = function (event) {
        try {
            const data        = JSON.parse(event.data);
            const qrLoading   = document.getElementById('qrLoading');
            const qrImage     = document.getElementById('qrImage');
            const qrSuccess   = document.getElementById('qrSuccess');
            const statusDot   = document.querySelector('#connectionStatus .status-dot');
            const statusText  = document.querySelector('#connectionStatus .status-text');
            const connInfo    = document.getElementById('connectionInfo');

            const show = (el) => { if (el) el.style.display = ''; };
            const hide = (el) => { if (el) el.style.display = 'none'; };

            if (data.type === 'qr') {
                show(qrLoading); hide(qrImage); hide(qrSuccess);
                if (qrImage) { qrImage.src = data.data; qrImage.style.display = 'block'; }
                if (qrLoading) qrLoading.style.display = 'none';
                if (statusDot)  statusDot.className  = 'status-dot error';
                if (statusText) statusText.textContent = 'Scan QR Code';
                if (connInfo)   connInfo.innerHTML   = '<p style="color:var(--color-warning)">⚠️ Waiting for QR Code scan. Go to Settings → WhatsApp QR.</p>';

            } else if (data.type === 'ready') {
                hide(qrLoading); hide(qrImage); show(qrSuccess);
                if (statusDot)  statusDot.className  = 'status-dot connected';
                if (statusText) statusText.textContent = 'Connected';
                if (connInfo)   connInfo.innerHTML   = `
                    <p class="connected-text">✅ Connected to WhatsApp</p>
                    <p>Phone: ${escapeHtml(data.phone || '')}</p>`;

            } else if (data.type === 'disconnected' || data.type === 'error') {
                show(qrLoading); hide(qrImage); hide(qrSuccess);
                if (statusDot)  statusDot.className  = 'status-dot error';
                if (statusText) statusText.textContent = 'Disconnected';
                if (connInfo)   connInfo.innerHTML   = '<p style="color:var(--color-error)">❌ Not connected</p>';

            } else if (data.type === 'loading') {
                show(qrLoading); hide(qrImage); hide(qrSuccess);
                if (statusDot)  statusDot.className  = 'status-dot demo';
                if (statusText) statusText.textContent = 'Initializing…';
                if (connInfo)   connInfo.innerHTML   = '<p>Loading WhatsApp Client…</p>';
            }
        } catch (e) {
            console.error('SSE parse error:', e);
        }
    };

    eventSource.onerror = function () {
        console.warn('SSE connection lost — browser will auto-reconnect.');
    };
}

// ═══════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════
function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'));
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'));
    if (isNaN(d)) return '';
    const diffMins = Math.floor((Date.now() - d) / 60000);
    if (diffMins < 1)  return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24)  return `${diffHrs}h ago`;
    return `${Math.floor(diffHrs / 24)}d ago`;
}

// ═══════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {

    // ── Settings tabs ──────────────────────────────────────
    initSettingsTabs();

    // ── Navigation ─────────────────────────────────────────
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(item.dataset.section);
        });
    });

    // ── Mobile menu ─────────────────────────────────────────
    const menuToggle = document.getElementById('menuToggle');
    const sidebar    = document.getElementById('sidebar');
    const overlay    = document.getElementById('overlay');

    menuToggle.addEventListener('click', () => {
        const isOpen = sidebar.classList.toggle('open');
        overlay.classList.toggle('active', isOpen);
        menuToggle.setAttribute('aria-expanded', String(isOpen));
    });

    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
        menuToggle.setAttribute('aria-expanded', 'false');
    });

    // ── Topbar refresh ──────────────────────────────────────
    document.getElementById('refreshBtn')?.addEventListener('click', () => {
        loadSectionData(currentSection);
        showToast('Refreshed', 'info');
    });

    // ── Quick send form ─────────────────────────────────────
    document.getElementById('quickSendForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone   = document.getElementById('qsPhone').value.trim();
        const message = document.getElementById('qsMessage').value.trim();
        if (!phone || !message) return;

        const btn = document.getElementById('quickSendBtn');
        btn.disabled = true;
        btn.textContent = 'Sending…';

        try {
            await api('/api/messages/send', {
                method: 'POST',
                body: JSON.stringify({ phone, body: message })
            });
            showToast(`Message sent to ${phone}`, 'success');
            document.getElementById('qsPhone').value    = '';
            document.getElementById('qsMessage').value  = '';
            loadDashboard();
        } catch (err) {
            showToast(err.message || 'Failed to send message', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span class="btn-icon" aria-hidden="true">📨</span> Send Message';
        }
    });

    // ── Add chatbot rule ────────────────────────────────────
    document.getElementById('addRuleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const trigger_keyword = document.getElementById('ruleTrigger').value.trim();
        const match_type      = document.getElementById('ruleMatchType').value;
        const response_text   = document.getElementById('ruleResponse').value.trim();
        const priority        = parseInt(document.getElementById('rulePriority').value) || 0;

        if (!trigger_keyword || !response_text) return;

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Adding…';

        try {
            await api('/api/chatbot/rules', {
                method: 'POST',
                body: JSON.stringify({ trigger_keyword, match_type, response_text, priority })
            });
            showToast('Rule added successfully!', 'success');
            document.getElementById('addRuleForm').reset();
            document.getElementById('rulePriority').value = '5';
            loadChatbotRules();
        } catch (err) {
            showToast('Failed to add rule', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Add Rule';
        }
    });

    // ── Test chatbot ────────────────────────────────────────
    document.getElementById('testChatbotBtn').addEventListener('click', testChatbot);
    document.getElementById('testMessage').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); testChatbot(); }
    });

    // ── Add contact form ────────────────────────────────────
    document.getElementById('addContactForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = document.getElementById('contactPhone').value.trim();
        const name  = document.getElementById('contactName').value.trim();
        const label = document.getElementById('contactLabel').value.trim();

        if (!phone) return;

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Adding…';

        try {
            await api('/api/contacts', {
                method: 'POST',
                body: JSON.stringify({ phone, name, label })
            });
            showToast('Contact added!', 'success');
            document.getElementById('addContactForm').reset();
            loadContacts();
        } catch (err) {
            showToast('Failed to add contact', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Add Contact';
        }
    });

    // ── Contact search ──────────────────────────────────────
    let contactSearchTimeout;
    document.getElementById('contactSearch').addEventListener('input', () => {
        clearTimeout(contactSearchTimeout);
        contactSearchTimeout = setTimeout(loadContacts, 300);
    });

    // ── Message search & filter ─────────────────────────────
    let messageSearchTimeout;
    document.getElementById('messageSearch').addEventListener('input', () => {
        clearTimeout(messageSearchTimeout);
        messageSearchTimeout = setTimeout(loadMessages, 300);
    });
    document.getElementById('messageFilter').addEventListener('change', loadMessages);

    // ── Schedule message form ───────────────────────────────
    document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone        = document.getElementById('schedPhone').value.trim();
        const body         = document.getElementById('schedMessage').value.trim();
        const scheduled_at = document.getElementById('schedDate').value;

        if (!phone || !body || !scheduled_at) return;

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Scheduling…';

        try {
            await api('/api/scheduled', {
                method: 'POST',
                body: JSON.stringify({ phone, body, scheduled_at })
            });
            showToast('Message scheduled!', 'success');
            document.getElementById('scheduleForm').reset();
            loadScheduled();
        } catch (err) {
            showToast('Failed to schedule message', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Schedule Message';
        }
    });

    // ── Settings (General) form ─────────────────────────────
    document.getElementById('settingsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('saveSettingsBtn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    business_name:   document.getElementById('settBusinessName')?.value  || '',
                    chatbot_enabled: document.getElementById('settChatbotEnabled')?.checked ? 'true' : 'false',
                    default_reply:   document.getElementById('settDefaultReply')?.value  || '',
                    away_mode:       document.getElementById('settAwayMode')?.checked    ? 'true' : 'false',
                    away_message:    document.getElementById('settAwayMessage')?.value   || '',
                    welcome_message: document.getElementById('settWelcomeMessage')?.value || ''
                })
            });
            showToast('Settings saved!', 'success');
        } catch (err) {
            showToast('Failed to save settings', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Settings';
        }
    });

    // ── Persona Preset buttons ──────────────────────────────
    const PRESETS = {
        casual:       `You are a real, friendly AI chatting on WhatsApp on behalf of your owner.\n- Talk naturally, casually, and warmly, just like a real person texting on WhatsApp.\n- Keep responses short (1-3 sentences), concise, and conversational.\n- Answer questions directly, chat with friends or clients, and be helpful.\n- If someone asks personal details you don't know, politely say you'll let the owner know.\n- Use occasional emojis naturally 😊.`,
        assistant:    `You are the personal AI assistant for your owner on WhatsApp.\n- Politely assist whoever is reaching out.\n- Help answer common questions, take down messages, or provide useful details.\n- If urgent, ask them to leave a clear note so the owner can follow up directly.\n- Maintain a polite, helpful, and organized tone.`,
        professional: `You are an AI replying on WhatsApp for professional and business communications.\n- Respond with clarity, courtesy, and efficiency.\n- Keep answers crisp, structured, and informative.\n- If asked for estimates, bookings, or confidential info, politely request their contact details/requirements so the owner can review.`,
        short:        `You are texting on WhatsApp on behalf of your owner.\n- Keep all replies extremely short (1 sentence or a few words max).\n- Direct, friendly, and concise. No fluff or extra explanations.`
    };

    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.preset;
            if (PRESETS[key]) {
                const promptArea = document.getElementById('settAiSystemPrompt');
                if (promptArea) promptArea.value = PRESETS[key];
                showToast(`Applied ${btn.textContent.trim()} preset!`, 'success');
            }
        });
    });

    // ── AI Settings form ────────────────────────────────────
    document.getElementById('aiSettingsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('saveAiBtn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    ai_enabled:       document.getElementById('settAiEnabled')?.checked   ? 'true' : 'false',
                    owner_name:       document.getElementById('settOwnerName')?.value     || '',
                    ai_mode:          document.getElementById('settAiMode')?.value        || 'ai_first',
                    ai_system_prompt: document.getElementById('settAiSystemPrompt')?.value || '',
                    gemini_api_key:   document.getElementById('settGeminiApiKey')?.value  || ''
                })
            });
            showToast('AI Persona Settings saved!', 'success');
        } catch (err) {
            showToast('Failed to save AI settings', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save AI Persona Settings';
        }
    });

    // ── Danger Zone buttons ─────────────────────────────────
    document.getElementById('pauseChatbotBtn')?.addEventListener('click', async () => {
        if (!confirm('Pause the chatbot? Auto-replies will stop until you re-enable it in General settings.')) return;
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({ chatbot_enabled: 'false' })
            });
            // Reflect in General tab
            const el = document.getElementById('settChatbotEnabled');
            if (el) el.checked = false;
            showToast('Chatbot paused', 'success');
        } catch (err) {
            showToast('Failed to pause chatbot', 'error');
        }
    });

    document.getElementById('clearMessagesBtn')?.addEventListener('click', () => {
        // No backend endpoint yet; warn user
        showToast('Clear messages is not yet implemented on the server.', 'info');
    });

    document.getElementById('disconnectBtn')?.addEventListener('click', () => {
        showToast('Disconnect: please restart the server to log out of WhatsApp.', 'info');
    });

    // ── Initial load ────────────────────────────────────────
    loadDashboard();
    initSSE();

    // ── Auto-refresh dashboard every 30 s ───────────────────
    setInterval(() => {
        if (currentSection === 'dashboard') loadDashboard();
    }, 30000);
});
