/* ═══════════════════════════════════════════════════════════
   WhatsApp Automation Dashboard — Frontend Logic
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
        <span class="toast-icon">${icons[type]}</span>
        <span class="toast-text">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.35s ease forwards';
        setTimeout(() => toast.remove(), 350);
    }, 4000);
}

// ─── Navigation ─────────────────────────────────────────────
function navigateTo(section) {
    currentSection = section;

    // Update nav
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.section === section);
    });

    // Show section
    document.querySelectorAll('.section').forEach(sec => {
        sec.classList.toggle('active', sec.id === `section-${section}`);
    });

    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('overlay').classList.remove('active');

    // Load section data
    loadSectionData(section);
}

function loadSectionData(section) {
    switch (section) {
        case 'dashboard': loadDashboard(); break;
        case 'messages': loadMessages(); break;
        case 'chatbot': loadChatbotRules(); break;
        case 'contacts': loadContacts(); break;
        case 'scheduled': loadScheduled(); break;
        case 'settings': loadSettings(); break;
    }
}

// ═══════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════
async function loadDashboard() {
    try {
        const stats = await api('/api/dashboard/stats');

        // Update demo mode indicator
        const indicator = document.getElementById('modeIndicator');
        if (stats.demoMode) {
            indicator.textContent = '🧪 Demo Mode';
            indicator.style.color = '#f59e0b';
        } else {
            indicator.textContent = '🟢 Live';
            indicator.style.color = '#25D366';
        }

        // Update stat cards with animation
        animateValue('valSentToday', stats.sentToday);
        animateValue('valReceivedToday', stats.receivedToday);
        animateValue('valContacts', stats.totalContacts);
        animateValue('valActiveRules', stats.activeRules);

        // Recent activity
        const activityEl = document.getElementById('recentActivity');
        if (stats.recentMessages.length === 0) {
            activityEl.innerHTML = '<div class="empty-state">No messages yet. Send your first message! 🚀</div>';
        } else {
            activityEl.innerHTML = stats.recentMessages.map(msg => `
                <div class="activity-item">
                    <span class="activity-direction">${msg.direction === 'incoming' ? '📥' : '📤'}</span>
                    <div class="activity-details">
                        <div class="activity-phone">${msg.contact_name || msg.phone}</div>
                        <div class="activity-text">${escapeHtml(msg.body)}</div>
                    </div>
                    <span class="activity-time">${timeAgo(msg.created_at)}</span>
                </div>
            `).join('');
        }
    } catch (err) {
        showToast('Failed to load dashboard', 'error');
    }
}

function animateValue(elementId, target) {
    const el = document.getElementById(elementId);
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
    try {
        const phone = document.getElementById('messageSearch')?.value || '';
        const direction = document.getElementById('messageFilter')?.value || '';

        let endpoint = '/api/messages?limit=200';
        if (phone) endpoint += `&phone=${encodeURIComponent(phone)}`;
        if (direction) endpoint += `&direction=${direction}`;

        const messages = await api(endpoint);
        const tbody = document.getElementById('messagesBody');

        if (messages.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No messages found</td></tr>';
            return;
        }

        tbody.innerHTML = messages.map(msg => `
            <tr>
                <td><span class="badge badge-${msg.direction}">${msg.direction === 'incoming' ? '📥 In' : '📤 Out'}</span></td>
                <td><strong>${msg.contact_name || msg.phone}</strong><br><small style="color:var(--text-muted)">${msg.phone}</small></td>
                <td><span class="msg-truncate">${escapeHtml(msg.body)}</span></td>
                <td><span class="badge badge-${msg.status}">${msg.status}</span></td>
                <td style="white-space:nowrap">${formatDate(msg.created_at)}</td>
            </tr>
        `).join('');
    } catch (err) {
        showToast('Failed to load messages', 'error');
    }
}

// ═══════════════════════════════════════════════════════════
//  CHATBOT RULES
// ═══════════════════════════════════════════════════════════
async function loadChatbotRules() {
    try {
        const rules = await api('/api/chatbot/rules');
        const container = document.getElementById('rulesList');

        if (rules.length === 0) {
            container.innerHTML = '<div class="empty-state">No chatbot rules yet. Add your first rule above! 🤖</div>';
            return;
        }

        container.innerHTML = rules.map(rule => `
            <div class="rule-item ${rule.is_active ? '' : 'disabled'}" data-id="${rule.id}">
                <div class="rule-info">
                    <div class="rule-trigger">
                        <span class="rule-keyword">"${escapeHtml(rule.trigger_keyword)}"</span>
                        <span class="rule-match-type">${rule.match_type}</span>
                        ${!rule.is_active ? '<span class="badge badge-cancelled">Disabled</span>' : ''}
                    </div>
                    <div class="rule-response">${escapeHtml(rule.response_text)}</div>
                    <div class="rule-meta">
                        <span>Priority: ${rule.priority}</span>
                        <span>•</span>
                        <span>Hits: ${rule.hit_count}</span>
                    </div>
                </div>
                <div class="rule-actions">
                    <button class="btn btn-sm btn-secondary" onclick="toggleRule(${rule.id}, ${rule.is_active ? 0 : 1})" title="${rule.is_active ? 'Disable' : 'Enable'}">
                        ${rule.is_active ? '⏸️' : '▶️'}
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteRule(${rule.id})" title="Delete">
                        🗑️
                    </button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        showToast('Failed to load chatbot rules', 'error');
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
    const input = document.getElementById('testMessage');
    const resultEl = document.getElementById('testResult');
    const text = input.value.trim();

    if (!text) { input.focus(); return; }

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
                <strong>Keyword:</strong> "${escapeHtml(result.keyword)}" (${result.matchType})<br>
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
    }
}

// ═══════════════════════════════════════════════════════════
//  CONTACTS
// ═══════════════════════════════════════════════════════════
async function loadContacts() {
    try {
        const search = document.getElementById('contactSearch')?.value || '';
        let endpoint = '/api/contacts';
        if (search) endpoint += `?search=${encodeURIComponent(search)}`;

        const contacts = await api(endpoint);
        const tbody = document.getElementById('contactsBody');

        if (contacts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No contacts found</td></tr>';
            return;
        }

        tbody.innerHTML = contacts.map(c => `
            <tr>
                <td><strong>${escapeHtml(c.name) || '—'}</strong></td>
                <td>${c.phone}</td>
                <td>${c.label ? `<span class="badge badge-incoming">${escapeHtml(c.label)}</span>` : '—'}</td>
                <td style="white-space:nowrap">${formatDate(c.created_at)}</td>
                <td>
                    <button class="btn btn-sm btn-danger" onclick="deleteContact(${c.id})">🗑️</button>
                </td>
            </tr>
        `).join('');
    } catch (err) {
        showToast('Failed to load contacts', 'error');
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
    try {
        const messages = await api('/api/scheduled');
        const tbody = document.getElementById('scheduledBody');

        if (messages.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No scheduled messages</td></tr>';
            return;
        }

        tbody.innerHTML = messages.map(msg => `
            <tr>
                <td>${msg.phone}</td>
                <td><span class="msg-truncate">${escapeHtml(msg.body)}</span></td>
                <td style="white-space:nowrap">${formatDate(msg.scheduled_at)}</td>
                <td><span class="badge badge-${msg.status}">${msg.status}</span></td>
                <td>
                    ${msg.status === 'pending'
                        ? `<button class="btn btn-sm btn-danger" onclick="cancelScheduled(${msg.id})">Cancel</button>`
                        : '—'
                    }
                </td>
            </tr>
        `).join('');
    } catch (err) {
        showToast('Failed to load scheduled messages', 'error');
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

        document.getElementById('settBusinessName').value = settings.business_name || '';
        document.getElementById('settChatbotEnabled').checked = settings.chatbot_enabled === 'true';
        document.getElementById('settDefaultReply').value = settings.default_reply || '';
        document.getElementById('settAwayMode').checked = settings.away_mode === 'true';
        document.getElementById('settAwayMessage').value = settings.away_message || '';
        document.getElementById('settWelcomeMessage').value = settings.welcome_message || '';

        // AI Settings
        const elAiEnabled = document.getElementById('settAiEnabled');
        if (elAiEnabled) elAiEnabled.checked = settings.ai_enabled === 'true';
        
        const elOwnerName = document.getElementById('settOwnerName');
        if (elOwnerName) elOwnerName.value = settings.owner_name || '';

        const elAiMode = document.getElementById('settAiMode');
        if (elAiMode) elAiMode.value = settings.ai_mode || 'ai_first';

        const elAiPrompt = document.getElementById('settAiSystemPrompt');
        if (elAiPrompt) elAiPrompt.value = settings.ai_system_prompt || '';
        
        const elGemini = document.getElementById('settGeminiApiKey');
        if (elGemini) elGemini.value = settings.gemini_api_key || '';
    } catch (err) {
        showToast('Failed to load settings', 'error');
    }
}

function initSSE() {
    const eventSource = new EventSource('/api/qr-stream');
    
    eventSource.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            const qrLoading = document.getElementById('qrLoading');
            const qrImage = document.getElementById('qrImage');
            const qrSuccess = document.getElementById('qrSuccess');
            const statusDot = document.querySelector('#connectionStatus .status-dot');
            const statusText = document.querySelector('#connectionStatus .status-text');
            const connectionInfo = document.getElementById('connectionInfo');
            
            if (data.type === 'qr') {
                if (qrLoading) qrLoading.style.display = 'none';
                if (qrImage) {
                    qrImage.style.display = 'block';
                    qrImage.src = data.data;
                }
                if (qrSuccess) qrSuccess.style.display = 'none';
                
                if (statusDot) statusDot.className = 'status-dot error';
                if (statusText) statusText.textContent = 'Scan QR Code';
                if (connectionInfo) connectionInfo.innerHTML = '<p style="color:#f59e0b">⚠️ Waiting for QR Code Scan. Check Settings.</p>';
            } else if (data.type === 'ready') {
                if (qrLoading) qrLoading.style.display = 'none';
                if (qrImage) qrImage.style.display = 'none';
                if (qrSuccess) qrSuccess.style.display = 'block';
                
                if (statusDot) statusDot.className = 'status-dot connected';
                if (statusText) statusText.textContent = 'Connected';
                if (connectionInfo) {
                    connectionInfo.innerHTML = `
                        <p class="connected">✅ Connected to WhatsApp</p>
                        <p>Phone: ${data.phone}</p>
                    `;
                }
            } else if (data.type === 'disconnected' || data.type === 'error') {
                if (qrLoading) qrLoading.style.display = 'block';
                if (qrImage) qrImage.style.display = 'none';
                if (qrSuccess) qrSuccess.style.display = 'none';
                
                if (statusDot) statusDot.className = 'status-dot error';
                if (statusText) statusText.textContent = 'Disconnected';
                if (connectionInfo) connectionInfo.innerHTML = '<p style="color:var(--red)">❌ Not connected</p>';
            } else if (data.type === 'loading') {
                if (qrLoading) qrLoading.style.display = 'block';
                if (qrImage) qrImage.style.display = 'none';
                if (qrSuccess) qrSuccess.style.display = 'none';
                
                if (statusDot) statusDot.className = 'status-dot demo';
                if (statusText) statusText.textContent = 'Initializing...';
                if (connectionInfo) connectionInfo.innerHTML = '<p>Loading WhatsApp Client...</p>';
            }
        } catch (e) {
            console.error('SSE Error processing:', e);
        }
    };

    eventSource.onerror = function() {
        console.error('SSE connection lost. Browser will auto-reconnect.');
    };
}

// ═══════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'));
    return d.toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'));
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    return `${diffDays}d ago`;
}

// ═══════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(item.dataset.section);
        });
    });

    // Mobile menu
    document.getElementById('menuToggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
        document.getElementById('overlay').classList.toggle('active');
    });

    document.getElementById('overlay').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('overlay').classList.remove('active');
    });

    // Quick send form
    document.getElementById('quickSendForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = document.getElementById('qsPhone').value.trim();
        const message = document.getElementById('qsMessage').value.trim();
        if (!phone || !message) return;

        try {
            await api('/api/messages/send', {
                method: 'POST',
                body: JSON.stringify({ phone, body: message })
            });
            showToast(`Message sent to ${phone}`, 'success');
            document.getElementById('qsPhone').value = '';
            document.getElementById('qsMessage').value = '';
            loadDashboard();
        } catch (err) {
            showToast(err.message || 'Failed to send message', 'error');
        }
    });

    // Add chatbot rule form
    document.getElementById('addRuleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const trigger_keyword = document.getElementById('ruleTrigger').value.trim();
        const match_type = document.getElementById('ruleMatchType').value;
        const response_text = document.getElementById('ruleResponse').value.trim();
        const priority = parseInt(document.getElementById('rulePriority').value) || 0;

        if (!trigger_keyword || !response_text) return;

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
        }
    });

    // Test chatbot
    document.getElementById('testChatbotBtn').addEventListener('click', testChatbot);
    document.getElementById('testMessage').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') testChatbot();
    });

    // Add contact form
    document.getElementById('addContactForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = document.getElementById('contactPhone').value.trim();
        const name = document.getElementById('contactName').value.trim();
        const label = document.getElementById('contactLabel').value.trim();

        if (!phone) return;

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
        }
    });

    // Contact search
    let contactSearchTimeout;
    document.getElementById('contactSearch').addEventListener('input', () => {
        clearTimeout(contactSearchTimeout);
        contactSearchTimeout = setTimeout(loadContacts, 300);
    });

    // Message search & filter
    let messageSearchTimeout;
    document.getElementById('messageSearch').addEventListener('input', () => {
        clearTimeout(messageSearchTimeout);
        messageSearchTimeout = setTimeout(loadMessages, 300);
    });
    document.getElementById('messageFilter').addEventListener('change', loadMessages);

    // Schedule message form
    document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = document.getElementById('schedPhone').value.trim();
        const body = document.getElementById('schedMessage').value.trim();
        const scheduled_at = document.getElementById('schedDate').value;

        if (!phone || !body || !scheduled_at) return;

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
        }
    });

    // Settings form
    document.getElementById('settingsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    business_name: document.getElementById('settBusinessName')?.value || '',
                    chatbot_enabled: document.getElementById('settChatbotEnabled')?.checked ? 'true' : 'false',
                    default_reply: document.getElementById('settDefaultReply')?.value || '',
                    away_mode: document.getElementById('settAwayMode')?.checked ? 'true' : 'false',
                    away_message: document.getElementById('settAwayMessage')?.value || '',
                    welcome_message: document.getElementById('settWelcomeMessage')?.value || ''
                })
            });
            showToast('Settings saved!', 'success');
        } catch (err) {
            showToast('Failed to save settings', 'error');
        }
    });

    // Persona Preset buttons
    const PRESETS = {
        casual: `You are a real, friendly AI chatting on WhatsApp on behalf of your owner.\n- Talk naturally, casually, and warmly, just like a real person texting on WhatsApp.\n- Keep responses short (1-3 sentences), concise, and conversational.\n- Answer questions directly, chat with friends or clients, and be helpful.\n- If someone asks personal details you don't know, politely say you'll let the owner know.\n- Use occasional emojis naturally 😊.`,
        assistant: `You are the personal AI assistant for your owner on WhatsApp.\n- Politely assist whoever is reaching out.\n- Help answer common questions, take down messages, or provide useful details.\n- If urgent, ask them to leave a clear note so the owner can follow up directly.\n- Maintain a polite, helpful, and organized tone.`,
        professional: `You are an AI replying on WhatsApp for professional and business communications.\n- Respond with clarity, courtesy, and efficiency.\n- Keep answers crisp, structured, and informative.\n- If asked for estimates, bookings, or confidential info, politely request their contact details/requirements so the owner can review.`,
        short: `You are texting on WhatsApp on behalf of your owner.\n- Keep all replies extremely short (1 sentence or a few words max).\n- Direct, friendly, and concise. No fluff or extra explanations.`
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

    // AI Settings form
    document.getElementById('aiSettingsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const aiEnabled = document.getElementById('settAiEnabled')?.checked ? 'true' : 'false';
            const ownerName = document.getElementById('settOwnerName')?.value || '';
            const aiMode = document.getElementById('settAiMode')?.value || 'ai_first';
            const aiPrompt = document.getElementById('settAiSystemPrompt')?.value || '';
            const geminiKey = document.getElementById('settGeminiApiKey')?.value || '';
            
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    ai_enabled: aiEnabled,
                    owner_name: ownerName,
                    ai_mode: aiMode,
                    ai_system_prompt: aiPrompt,
                    gemini_api_key: geminiKey
                })
            });
            showToast('AI Persona Settings saved!', 'success');
        } catch (err) {
            showToast('Failed to save AI settings', 'error');
        }
    });

    // Initial load
    loadDashboard();
    initSSE();

    // Auto-refresh dashboard every 30 seconds
    setInterval(() => {
        if (currentSection === 'dashboard') loadDashboard();
    }, 30000);
});
