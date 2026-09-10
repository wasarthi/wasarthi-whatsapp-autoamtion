/**
 * Tests for the Payment Link feature:
 * - Product creation/update with payment_link
 * - URL validation (http/https only, length limits)
 * - getProductByName (exact and fuzzy matching)
 * - hasPaymentLinks helper
 * - recordPaymentLinkSent (deal upsert, stage progression, payment_link_sent_at)
 * - Multi-tenant isolation for products and payment links
 */
const request = require('supertest');

describe('Payment Link Feature', () => {
    let app;
    let user1, user2;

    beforeEach(async () => {
        await freshDatabase();
        app = createTestApp();
        user1 = await signup(app, { email: 'user1@example.com' });
        user2 = await signup(app, { email: 'user2@example.com' });
    });

    describe('API Product Management with payment_link', () => {
        it('allows creating a product with a valid payment_link', async () => {
            const res = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Premium SEO Package',
                    price: '499',
                    category: 'Services',
                    description: 'Full monthly SEO optimization',
                    url: 'https://example.com/seo',
                    payment_link: 'https://buy.stripe.com/test_12345'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.name).toBe('Premium SEO Package');
            expect(res.body.data.payment_link).toBe('https://buy.stripe.com/test_12345');
        });

        it('rejects invalid payment_link URLs (e.g. javascript: or plain text)', async () => {
            const badRes1 = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Malicious Service',
                    payment_link: 'javascript:alert(1)'
                });

            expect(badRes1.status).toBe(400);

            const badRes2 = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Invalid URL Service',
                    payment_link: 'not-a-valid-url'
                });

            expect(badRes2.status).toBe(400);
        });

        it('allows updating an existing product payment_link', async () => {
            const created = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Consulting Hour',
                    price: '150'
                });
            const prodId = created.body.data.id;

            const updateRes = await request(app)
                .put(`/api/products/${prodId}`)
                .set('Cookie', user1.cookie)
                .send({
                    payment_link: 'https://razorpay.me/@mybusiness'
                });

            expect(updateRes.status).toBe(200);
            expect(updateRes.body.data.payment_link).toBe('https://razorpay.me/@mybusiness');
        });
    });

    describe('Database functions: getProductByName and hasPaymentLinks', () => {
        it('hasPaymentLinks returns false when user has no products or no links, true when link is present', async () => {
            const db = require('../src/services/database');
            expect(db.hasPaymentLinks(user1.user.id)).toBe(false);

            db.createProduct(user1.user.id, {
                name: 'Basic Plan',
                price: '99',
                payment_link: ''
            });
            expect(db.hasPaymentLinks(user1.user.id)).toBe(false);

            db.createProduct(user1.user.id, {
                name: 'Pro Plan',
                price: '199',
                payment_link: 'https://pay.example.com/pro'
            });
            expect(db.hasPaymentLinks(user1.user.id)).toBe(true);

            // Tenant isolation: user2 should still be false
            expect(db.hasPaymentLinks(user2.user.id)).toBe(false);
        });

        it('getProductByName matches exact name case-insensitively and fuzzy prefix', async () => {
            const db = require('../src/services/database');
            db.createProduct(user1.user.id, {
                name: 'Web Design Standard',
                price: '999',
                payment_link: 'https://pay.example.com/web'
            });

            // Exact match (different casing)
            const match1 = db.getProductByName(user1.user.id, 'web design standard');
            expect(match1).not.toBeNull();
            expect(match1.name).toBe('Web Design Standard');

            // Fuzzy prefix match
            const match2 = db.getProductByName(user1.user.id, 'Web Design');
            expect(match2).not.toBeNull();
            expect(match2.name).toBe('Web Design Standard');

            // Tenant isolation: user2 cannot find user1 product
            const matchUser2 = db.getProductByName(user2.user.id, 'Web Design Standard');
            expect(matchUser2).toBeNull();
        });
    });

    describe('recordPaymentLinkSent and Sales Pipeline CRM integration', () => {
        it('creates a new CRM deal at proposal stage with payment_link_sent_at', async () => {
            const db = require('../src/services/database');
            const phone = '1234567890';
            db.recordPaymentLinkSent(user1.user.id, phone, {
                contactName: 'Alice Smith',
                productName: 'Pro Plan',
                price: 199
            });

            const deal = db.getCrmDealByPhone(user1.user.id, phone);
            expect(deal).toBeDefined();
            expect(deal.stage).toBe('proposal');
            expect(deal.deal_value).toBe(199);
            expect(deal.product_interest).toBe('Pro Plan');
            expect(deal.payment_link_sent_at).not.toBeNull();

            // Check CRM activity logged
            const activities = db.getCrmActivities(user1.user.id, phone);
            expect(activities.length).toBeGreaterThan(0);
            expect(activities[0].content).toContain('AI sent payment link');
        });

        it('does not downgrade deal stage if already in negotiation or won', async () => {
            const db = require('../src/services/database');
            const phone = '9876543210';
            // Existing deal in 'negotiation'
            db.createCrmDeal(user1.user.id, {
                phone,
                contactName: 'Bob Jones',
                stage: 'negotiation',
                dealValue: 500
            });

            db.recordPaymentLinkSent(user1.user.id, phone, {
                productName: 'Enterprise Add-on',
                price: 1000
            });

            const updatedDeal = db.getCrmDealByPhone(user1.user.id, phone);
            expect(updatedDeal.stage).toBe('negotiation'); // not downgraded to proposal
            expect(updatedDeal.payment_link_sent_at).not.toBeNull();
        });
    });

    describe('UPI Intent & QR Code Feature', () => {
        it('allows creating a product with a valid upi:// payment_link', async () => {
            const res = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Web Dev Service',
                    price: '1499',
                    payment_link: 'upi://pay?pa=merchant@okhdfcbank&pn=WebDev&am=1499&cu=INR'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.payment_link).toContain('upi://pay');
        });

        it('generates a QR code data URL via GET /api/products/:id/qr', async () => {
            const created = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Consultation Call',
                    price: '500',
                    payment_link: 'upi://pay?pa=expert@okaxis&am=500&cu=INR'
                });
            const prodId = created.body.data.id;

            const qrRes = await request(app)
                .get(`/api/products/${prodId}/qr`)
                .set('Cookie', user1.cookie);

            expect(qrRes.status).toBe(200);
            expect(qrRes.body.success).toBe(true);
            expect(qrRes.body.data.qr).toMatch(/^data:image\/png;base64,/);
            expect(qrRes.body.data.link).toContain('pa=expert@okaxis');
            expect(qrRes.body.data.link).toContain('am=500.00');
        });

        it('returns 404 for QR code when product does not belong to user', async () => {
            const created = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'User1 Product',
                    payment_link: 'https://example.com/pay'
                });
            const prodId = created.body.data.id;

            const qrRes = await request(app)
                .get(`/api/products/${prodId}/qr`)
                .set('Cookie', user2.cookie);

            expect(qrRes.status).toBe(404);
        });

        it('validates test-send requires phone or connected WhatsApp', async () => {
            const created = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Test Service',
                    payment_link: 'https://example.com/pay'
                });
            const prodId = created.body.data.id;

            const testRes = await request(app)
                .post(`/api/products/${prodId}/test-send`)
                .set('Cookie', user1.cookie)
                .send({}); // No phone passed and WhatsApp not connected

            expect(testRes.status).toBe(400);
            expect(testRes.body.success).toBe(false);

            // Passing a phone number when WhatsApp is not connected returns 409
            const sendWithPhone = await request(app)
                .post(`/api/products/${prodId}/test-send`)
                .set('Cookie', user1.cookie)
                .send({ phone: '9876543210' });

            expect(sendWithPhone.status).toBe(409);
            expect(sendWithPhone.body.error).toContain('not connected');
        });

        it('automatically converts raw UPI ID into a standard upi:// payment link with price', async () => {
            const res = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Lead Generation Bot',
                    price: '₹1,499',
                    payment_link: 'raunaksharma2005mt@okaxis'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.payment_link).toContain('upi://pay?pa=raunaksharma2005mt@okaxis');
            expect(res.body.data.payment_link).toContain('am=1499.00');
            expect(res.body.data.payment_link).toContain('cu=INR');

            // Generating QR code for this product should work seamlessly
            const qrRes = await request(app)
                .get(`/api/products/${res.body.data.id}/qr`)
                .set('Cookie', user1.cookie);

            expect(qrRes.status).toBe(200);
            expect(qrRes.body.data.qr).toMatch(/^data:image\/png;base64,/);
        });

        it('allows updating product with raw UPI ID', async () => {
            const created = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Web Design',
                    price: '5000'
                });
            const prodId = created.body.data.id;

            const updateRes = await request(app)
                .put(`/api/products/${prodId}`)
                .set('Cookie', user1.cookie)
                .send({
                    payment_link: 'business@okhdfcbank'
                });

            expect(updateRes.status).toBe(200);
            expect(updateRes.body.data.payment_link).toContain('upi://pay?pa=business@okhdfcbank');
            expect(updateRes.body.data.payment_link).toContain('am=5000.00');
        });

        it('strictly isolates multiple products/services with their own UPI settings and auto-syncs prices without leakage', async () => {
            const db = require('../src/services/database');

            // 1. Create Product 1: Lead Hunter (₹1,499 -> leadhunter@okhdfcbank)
            const p1 = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Lead Hunter',
                    price: '₹1,499',
                    payment_link: 'leadhunter@okhdfcbank'
                });
            expect(p1.status).toBe(200);
            expect(p1.body.data.payment_link).toContain('pa=leadhunter@okhdfcbank');
            expect(p1.body.data.payment_link).toContain('am=1499.00');

            // 2. Create Product 2: WhatsApp Automation (₹2,999 -> whatsappauto@paytm)
            const p2 = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'WhatsApp Automation',
                    price: '₹2,999',
                    payment_link: 'whatsappauto@paytm'
                });
            expect(p2.status).toBe(200);
            expect(p2.body.data.payment_link).toContain('pa=whatsappauto@paytm');
            expect(p2.body.data.payment_link).toContain('am=2999.00');

            // 3. Verify getProductByName matches each service with zero leakage
            const matched1 = db.getProductByName(user1.user.id, 'Lead Hunter');
            expect(matched1.name).toBe('Lead Hunter');
            expect(matched1.payment_link).toContain('pa=leadhunter@okhdfcbank');
            expect(matched1.payment_link).toContain('am=1499.00');

            const matched2 = db.getProductByName(user1.user.id, 'WhatsApp Automation');
            expect(matched2.name).toBe('WhatsApp Automation');
            expect(matched2.payment_link).toContain('pa=whatsappauto@paytm');
            expect(matched2.payment_link).toContain('am=2999.00');

            // 4. Update Product 1 price to ₹1,999 without touching payment_link
            const updateP1 = await request(app)
                .put(`/api/products/${p1.body.data.id}`)
                .set('Cookie', user1.cookie)
                .send({
                    price: '₹1,999'
                });
            expect(updateP1.status).toBe(200);
            // P1's UPI link automatically updated its amount to 1999.00 while preserving leadhunter@okhdfcbank
            expect(updateP1.body.data.payment_link).toContain('pa=leadhunter@okhdfcbank');
            expect(updateP1.body.data.payment_link).toContain('am=1999.00');

            // 5. Verify Product 2 was NOT affected at all (still 2999.00 and whatsappauto@paytm)
            const checkP2 = await request(app)
                .get('/api/business')
                .set('Cookie', user1.cookie);
            const p2Refreshed = checkP2.body.data.products.find(p => p.id === p2.body.data.id);
            expect(p2Refreshed.payment_link).toContain('pa=whatsappauto@paytm');
            expect(p2Refreshed.payment_link).toContain('am=2999.00');
        });
    });

    describe('Public Short Payment Link (/pay/:id)', () => {
        it('redirects to external payment link (e.g. Stripe/Razorpay) if not a UPI scheme', async () => {
            const created = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'External Checkout Service',
                    price: '2499',
                    payment_link: 'https://checkout.stripe.com/pay/cs_test_123'
                });

            const prodId = created.body.data.id;
            const res = await request(app).get(`/pay/${prodId}`);

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('https://checkout.stripe.com/pay/cs_test_123');
        });

        it('renders 1-tap UPI payment page with exact amount, QR code, and UPI intent URI for UPI products', async () => {
            const created = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Lead Hunter Service',
                    price: '₹1,499',
                    description: 'Automated outreach & lead hunting',
                    payment_link: 'raunaksharma2005mt@okaxis'
                });

            const prodId = created.body.data.id;
            const res = await request(app).get(`/pay/${prodId}`);

            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/html');
            expect(res.text).toContain('Lead Hunter Service');
            expect(res.text).toContain('1,499');
            expect(res.text).toContain('raunaksharma2005mt@okaxis');
            expect(res.text).toContain('upi://pay?pa=raunaksharma2005mt@okaxis');
            expect(res.text).toContain('&amp;am=1499.00');
            expect(res.text).toContain('data:image/png;base64,');
        });

        it('returns 404 for non-existent or inactive products', async () => {
            const resNotFound = await request(app).get('/pay/999999');
            expect(resNotFound.status).toBe(404);

            const created = await request(app)
                .post('/api/products')
                .set('Cookie', user1.cookie)
                .send({
                    name: 'Hidden Service',
                    price: '999',
                    payment_link: 'test@okaxis'
                });
            const prodId = created.body.data.id;

            // Hide/deactivate product
            await request(app)
                .put(`/api/products/${prodId}`)
                .set('Cookie', user1.cookie)
                .send({ is_active: 0 });

            const resInactive = await request(app).get(`/pay/${prodId}`);
            expect(resInactive.status).toBe(404);
        });
    });
});
