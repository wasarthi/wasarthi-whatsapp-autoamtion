let ALL_USERS = [];
let CURRENT_ADMIN = null;

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof hydrateIcons === 'function') hydrateIcons();

    const ok = await checkAdminAuth();
    if (!ok) return;

    await Promise.all([loadPlatformStats(), loadUsers()]);

    document.getElementById('userSearch').addEventListener('input', renderUsers);
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
    document.getElementById('editSaveBtn').addEventListener('click', saveEditModal);
    document.getElementById('editModalBackdrop').addEventListener('click', (e) => {
        if (e.target.id === 'editModalBackdrop') closeEditModal();
    });
});

// ─── Auth gate ────────────────────────────────────────────────
async function checkAdminAuth() {
    try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (!res.ok) { window.location.href = '/login'; return false; }
        const json = await res.json();
        CURRENT_ADMIN = json.data;
        if (CURRENT_ADMIN.role !== 'admin') { window.location.href = '/app'; return false; }
        document.getElementById('adminWhoami').textContent = CURRENT_ADMIN.business_name || CURRENT_ADMIN.email;
        return true;
    } catch (e) {
        window.location.href = '/login';
        return false;
    }
}

async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
    window.location.href = '/login';
}

// ─── API helper ───────────────────────────────────────────────
async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        ...options
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
        throw new Error(json.error || `Request failed (${res.status})`);
    }
    return json.data;
}

// ─── Platform stats ─────────────────────────────────────────
async function loadPlatformStats() {
    try {
        const stats = await api('/api/admin/stats');
        const grid = document.getElementById('platformStats');
        const cards = [
            { icon: 'users', color: 'a', num: stats.totalUsers, lbl: 'Total Accounts' },
            { icon: 'check-circle', color: 'b', num: stats.activeUsers, lbl: 'Active' },
            { icon: 'x-circle', color: 'e', num: stats.suspendedUsers, lbl: 'Suspended' },
            { icon: 'message-circle', color: 'c', num: stats.totalMessages, lbl: 'Total Messages' },
            { icon: 'trending-up', color: 'd', num: stats.totalDeals, lbl: 'CRM Deals' }
        ];
        grid.innerHTML = cards.map(c => `
            <div class="admin-stat-card">
                <span class="admin-stat-icon stat-${c.color}">${Icon(c.icon)}</span>
                <span>
                    <span class="num">${c.num.toLocaleString()}</span>
                    <span class="lbl">${c.lbl}</span>
                </span>
            </div>
        `).join('');
    } catch (err) {
        showToast(err.message || 'Failed to load platform stats', 'error');
    }
}

// ─── Users table ──────────────────────────────────────────────
async function loadUsers() {
    try {
        ALL_USERS = await api('/api/admin/users');
        renderUsers();
    } catch (err) {
        showToast(err.message || 'Failed to load accounts', 'error');
    }
}

function renderUsers() {
    const q = (document.getElementById('userSearch').value || '').trim().toLowerCase();
    const tbody = document.getElementById('usersBody');
    const empty = document.getElementById('usersEmpty');

    const filtered = ALL_USERS.filter(u =>
        !q || (u.business_name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
    );

    if (filtered.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = filtered.map(u => {
        const initials = (u.business_name || u.email).slice(0, 2).toUpperCase();
        const statusPill = u.status === 'active'
            ? `<span class="pill pill-active">${Icon('check-circle')} Active</span>`
            : `<span class="pill pill-suspended">${Icon('x-circle')} Suspended</span>`;
        const rolePill = u.role === 'admin'
            ? `<span class="pill pill-admin">${Icon('crown')} Admin</span>`
            : `<span class="pill pill-user">${Icon('user')} User</span>`;
        const wa = u.whatsapp || { connected: false, phone: null };
        const waLabel = wa.connected ? `Connected${wa.phone ? ' · ' + wa.phone : ''}` : (wa.started ? 'Connecting…' : 'Not connected');
        const s = u.stats || {};
        const isSelf = CURRENT_ADMIN && u.id === CURRENT_ADMIN.id;

        return `
            <tr>
                <td>
                    <div class="user-cell">
                        <span class="biz">${escapeHtml(u.business_name || '(' + initials + ')')}</span>
                        <span class="mail">${escapeHtml(u.email)}</span>
                    </div>
                </td>
                <td>${rolePill}</td>
                <td>${statusPill}</td>
                <td>
                    <span class="wa-dot ${wa.connected ? 'connected' : ''}">${escapeHtml(waLabel)}</span>
                </td>
                <td style="text-align:center">
                    ${u.role === 'admin' ? `<span class="pill pill-admin" title="Admins always have access">${Icon('crown')} Always</span>` : `<button class="btn btn-tiny" style="background:${u.wa_enabled ? 'var(--color-success)' : 'var(--color-error)'};color:#fff;font-size:.75rem;" onclick="toggleWaAccess(${u.id}, ${u.wa_enabled ? 0 : 1})" type="button" title="${u.wa_enabled ? 'Revoke WhatsApp access' : 'Grant WhatsApp access'}">${u.wa_enabled ? Icon('check-circle') + ' Enabled' : Icon('x-circle') + ' Disabled'}</button>`}
                </td>
                <td>
                    <div style="font-size:.8rem;line-height:1.5">
                        <div>${s.messagesThisMonth || 0} msgs this month</div>
                        <div style="color:var(--text-secondary)">${s.contacts || 0} contacts · ${s.leads || 0} leads</div>
                    </div>
                </td>
                <td>
                    <div style="font-size:.8rem;line-height:1.5">
                        <div>${escapeHtml(u.plan || 'free')}</div>
                        <div style="color:var(--text-secondary)">${u.message_limit ? u.message_limit + ' msgs/mo' : 'Unlimited msgs'} · ${u.rule_limit ? u.rule_limit + ' rules' : 'Unlimited rules'}</div>
                    </div>
                </td>
                <td style="color:var(--text-secondary);font-size:.8rem;white-space:nowrap">${formatDate(u.created_at)}</td>
                <td>
                    <div class="row-actions">
                        <button class="btn btn-tiny" onclick="openEditModal(${u.id})" type="button" title="Edit">${Icon('settings')}</button>
                        ${isSelf ? '' : `<button class="btn btn-tiny" onclick="toggleStatus(${u.id}, '${u.status === 'active' ? 'suspended' : 'active'}')" type="button" title="${u.status === 'active' ? 'Suspend' : 'Activate'}">${Icon(u.status === 'active' ? 'pause' : 'play')}</button>`}
                        ${isSelf ? '' : `<button class="btn btn-danger-sm" onclick="deleteUser(${u.id})" type="button" title="Delete">${Icon('trash-2')}</button>`}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr.replace(' ', 'T'));
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── Suspend / activate ────────────────────────────────────────
async function toggleStatus(id, newStatus) {
    try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
        showToast(newStatus === 'active' ? 'Account activated' : 'Account suspended', 'success');
        await Promise.all([loadUsers(), loadPlatformStats()]);
    } catch (err) {
        showToast(err.message || 'Could not update account', 'error');
    }
}

// ─── Grant / revoke WhatsApp access ────────────────────────────
async function toggleWaAccess(id, newValue) {
    const enabling = newValue === 1;
    const label = enabling ? 'Grant WhatsApp access to this user?' : 'Revoke WhatsApp access? Their active connection will be disconnected.';
    if (!confirm(label)) return;
    try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ wa_enabled: newValue }) });
        showToast(enabling ? 'WhatsApp access granted ✅' : 'WhatsApp access revoked', 'success');
        await loadUsers();
    } catch (err) {
        showToast(err.message || 'Could not update WhatsApp access', 'error');
    }
}

// ─── Delete ───────────────────────────────────────────────────
async function deleteUser(id) {
    const user = ALL_USERS.find(u => u.id === id);
    if (!confirm(`Permanently delete "${user ? (user.business_name || user.email) : 'this account'}" and all of its data? This cannot be undone.`)) return;
    try {
        await api(`/api/admin/users/${id}`, { method: 'DELETE' });
        showToast('Account deleted', 'success');
        await Promise.all([loadUsers(), loadPlatformStats()]);
    } catch (err) {
        showToast(err.message || 'Could not delete account', 'error');
    }
}

// ─── Edit modal ───────────────────────────────────────────────
function openEditModal(id) {
    const u = ALL_USERS.find(x => x.id === id);
    if (!u) return;
    document.getElementById('editUserId').value = u.id;
    document.getElementById('editBusinessName').value = u.business_name || '';
    document.getElementById('editOwnerName').value = u.owner_name || '';
    document.getElementById('editRole').value = u.role;
    document.getElementById('editPlan').value = u.plan || 'free';
    document.getElementById('editMessageLimit').value = u.message_limit || 0;
    document.getElementById('editRuleLimit').value = u.rule_limit || 0;
    document.getElementById('editModalBackdrop').classList.add('show');
    if (typeof hydrateIcons === 'function') hydrateIcons(document.getElementById('editModalBackdrop'));
}

function closeEditModal() {
    document.getElementById('editModalBackdrop').classList.remove('show');
}

async function saveEditModal() {
    const id = document.getElementById('editUserId').value;
    const fields = {
        business_name: document.getElementById('editBusinessName').value.trim(),
        owner_name: document.getElementById('editOwnerName').value.trim(),
        role: document.getElementById('editRole').value,
        plan: document.getElementById('editPlan').value.trim() || 'free',
        message_limit: parseInt(document.getElementById('editMessageLimit').value, 10) || 0,
        rule_limit: parseInt(document.getElementById('editRuleLimit').value, 10) || 0
    };
    try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
        showToast('Account updated', 'success');
        closeEditModal();
        await Promise.all([loadUsers(), loadPlatformStats()]);
    } catch (err) {
        showToast(err.message || 'Could not save changes', 'error');
    }
}

// ─── Toasts ───────────────────────────────────────────────────
function showToast(message, type = 'success') {
    const host = document.getElementById('toastHost');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const iconName = type === 'success' ? 'check-circle' : 'x-circle';
    el.innerHTML = `${Icon(iconName)}<span>${escapeHtml(message)}</span>`;
    host.appendChild(el);
    setTimeout(() => el.remove(), 3800);
}
