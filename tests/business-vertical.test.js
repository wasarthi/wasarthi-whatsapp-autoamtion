const request = require('supertest');

async function makeAdmin(email = 'admin@example.test') {
    const account = await createUserDirect({ email });
    require('../src/services/database').updateUser(account.user.id, { role: 'admin' });
    account.user = require('../src/services/database').getUserById(account.user.id);
    return account;
}

describe('business vertical administration', () => {
    let app;
    beforeEach(async () => { await freshDatabase(); app = createTestApp(); });

    test('new and existing-style accounts default to general and expose it through /auth/me', async () => {
        const account = await createUserDirect({ email: 'general@example.test' });
        expect(account.user.business_vertical).toBe('general');
        const me = await request(app).get('/api/auth/me').set('Cookie', account.cookie).expect(200);
        expect(me.body.data.business_vertical).toBe('general');
    });

    test('a system admin can switch an account between healthcare and general', async () => {
        const admin = await makeAdmin();
        const target = await createUserDirect({ email: 'clinic@example.test' });
        await request(app).patch(`/api/admin/users/${target.user.id}/vertical`).set('Cookie', admin.cookie)
            .send({ business_vertical: 'healthcare' }).expect(200);
        expect(require('../src/services/database').getUserById(target.user.id).business_vertical).toBe('healthcare');
        await request(app).patch(`/api/admin/users/${target.user.id}/vertical`).set('Cookie', admin.cookie)
            .send({ business_vertical: 'general' }).expect(200);
        expect(require('../src/services/database').getUserById(target.user.id).business_vertical).toBe('general');
    });

    test('rejects invalid verticals and normal-user administration attempts', async () => {
        const admin = await makeAdmin();
        const alice = await createUserDirect({ email: 'alice@example.test' });
        const bob = await createUserDirect({ email: 'bob@example.test' });
        await request(app).patch(`/api/admin/users/${alice.user.id}/vertical`).set('Cookie', admin.cookie)
            .send({ business_vertical: 'not-a-vertical' }).expect(400);
        await request(app).patch(`/api/admin/users/${bob.user.id}/vertical`).set('Cookie', alice.cookie)
            .send({ business_vertical: 'healthcare' }).expect(403);
        expect(require('../src/services/database').getUserById(bob.user.id).business_vertical).toBe('general');
    });

    test('settings payloads cannot change a vertical and each tenant retains its own value', async () => {
        const admin = await makeAdmin();
        const clinic = await createUserDirect({ email: 'clinic-tenant@example.test' });
        const general = await createUserDirect({ email: 'general-tenant@example.test' });
        await request(app).patch(`/api/admin/users/${clinic.user.id}/vertical`).set('Cookie', admin.cookie)
            .send({ business_vertical: 'healthcare' }).expect(200);
        const response = await request(app).put('/api/settings').set('Cookie', clinic.cookie)
            .send({ business_vertical: 'general' }).expect(200);
        expect(response.body.meta.ignored).toContain('business_vertical');
        expect(require('../src/services/database').getUserById(clinic.user.id).business_vertical).toBe('healthcare');
        expect(require('../src/services/database').getUserById(general.user.id).business_vertical).toBe('general');
    });

    test('healthcare AI prompts are administrative and do not use sales pipeline semantics', () => {
        const { buildAnalysisPrompt } = require('../src/services/lead-analyzer');
        const { buildSystemInstruction } = require('../src/services/ai');
        const analysis = buildAnalysisPrompt('Clinic', 'Staff', '', '₹', 'healthcare');
        const reply = buildSystemInstruction({ ownerName: 'Staff', businessName: 'Clinic', vertical: 'healthcare' });
        expect(analysis).toContain('not clinical assessment');
        expect(analysis).toContain('"is_sales_conversation": false');
        expect(reply).toContain('Never diagnose');
        expect(reply).toContain('local emergency services');
    });
});
