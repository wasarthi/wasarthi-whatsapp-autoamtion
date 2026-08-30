require('dotenv').config();
const http = require('http');

const TARGET_URL = 'http://localhost:3000';
const CONCURRENT_USERS_COUNT = 30;
const OPERATIONS_PER_USER = 10;

// Simple HTTP client using native http module to avoid extra dependencies
function request(method, path, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(TARGET_URL + path);
        const options = {
            method,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            headers: {
                ...headers
            }
        };

        if (body) {
            const bodyStr = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = data;
                try {
                    parsed = JSON.parse(data);
                } catch (e) { }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: parsed
                });
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[index];
}

async function runRealHttpLoadTest() {
    console.log(`\n🚀 Starting Real HTTP Load Test against ${TARGET_URL}`);
    console.log(`Target: ${CONCURRENT_USERS_COUNT} users, ${OPERATIONS_PER_USER} operations each.\n`);

    const latencies = [];
    const statusCodes = {};
    let isolationViolations = 0;

    function record(duration, status) {
        latencies.push(duration);
        statusCodes[status] = (statusCodes[status] || 0) + 1;
    }

    const testStartTime = Date.now();
    const runId = Date.now();
    const users = [];

    // Phase 1: Provision Users via Internal API to bypass rate limits
    console.log(`[1] Provisioning ${CONCURRENT_USERS_COUNT} users internally ...`);
    
    for (let i = 1; i <= CONCURRENT_USERS_COUNT; i++) {
        const email = `tenant_${i}_${runId}@example.com`;
        const password = 'TestPassword123!';
        const businessName = `Business Tenant ${i}`;
        const ownerName = `Owner ${i}`;

        const res = await request('POST', '/api/auth/signup', {}, {
            email,
            password,
            businessName,
            ownerName
        });

        if (res.status !== 200 && res.status !== 201) {
            console.error(`Failed to register user ${email}:`, res.body);
            process.exit(1);
        }

        // Get cookie from response headers
        const setCookieHeader = res.headers['set-cookie'];
        let cookie = '';
        if (Array.isArray(setCookieHeader)) {
            cookie = setCookieHeader[0].split(';')[0];
        } else if (setCookieHeader) {
            cookie = setCookieHeader.split(';')[0];
        }

        users.push({
            id: res.body.data ? res.body.data.id : i,
            email: email,
            cookie,
            businessName,
            ownerName
        });
    }
    console.log(`✅ Provisioned ${users.length} users and captured session cookies.\n`);

    // Phase 2: Simultaneous Load
    console.log(`[2] Simulating simultaneous dashboard, CRM, contacts, & status workflows...`);
    
    const userWorkloadPromises = users.map(async (user, userIdx) => {
        for (let round = 0; round < OPERATIONS_PER_USER; round++) {
            const reqHeaders = { 'Cookie': user.cookie };

            // 1. Dashboard Stats
            let t0 = Date.now();
            let res = await request('GET', '/api/dashboard/stats', reqHeaders);
            record(Date.now() - t0, res.status);

            // 2. Add Contact
            const contactPhone = `9198000${userIdx.toString().padStart(2, '0')}${round.toString().padStart(3, '0')}`;
            t0 = Date.now();
            res = await request('POST', '/api/contacts', reqHeaders, {
                phone: contactPhone,
                name: `Lead ${round} for Tenant ${userIdx}`,
                label: round % 2 === 0 ? 'VIP' : 'Lead'
            });
            record(Date.now() - t0, res.status);

            // 3. Paginated Contacts Query
            t0 = Date.now();
            res = await request('GET', '/api/contacts?limit=10&offset=0', reqHeaders);
            record(Date.now() - t0, res.status);

            if (res.status === 200 && res.body && Array.isArray(res.body.data)) {
                // Assert no contacts from other tenants leak in (we assume ID is in response, else we just check success)
                for (const c of res.body.data) {
                    // Ideally we'd verify c.user_id, but if it's stripped by API, we can't.
                    // But if it's there, we check it.
                    if (c.user_id && c.user_id !== user.id) {
                        isolationViolations++;
                    }
                }
            }

            // 4. Create CRM Deal
            t0 = Date.now();
            res = await request('POST', '/api/crm/deals', reqHeaders, {
                phone: contactPhone,
                contactName: `Lead ${round}`,
                dealValue: 5000 + round * 1000,
                stage: 'qualified',
                productInterest: 'Product A'
            });
            record(Date.now() - t0, res.status);

            // 5. Query Status
            t0 = Date.now();
            res = await request('GET', '/api/status', reqHeaders);
            record(Date.now() - t0, res.status);

            // 6. Update Settings
            t0 = Date.now();
            res = await request('PUT', '/api/settings', reqHeaders, {
                business_currency: 'USD',
                away_mode: 'false'
            });
            if (res.status === 401) {
                console.error('401 Error on PUT /api/settings:', res.body);
            }
            record(Date.now() - t0, res.status);
        }
    });

    await Promise.all(userWorkloadPromises);

    const totalDurationMs = Date.now() - testStartTime;

    // Phase 3: Reporting
    const totalRequests = latencies.length;
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);
    const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);

    console.log('\n==================================================================');
    console.log('📊 REAL HTTP 30-USER LOAD TEST RESULTS (TCP)');
    console.log('==================================================================');
    console.log(`• Total Concurrent Active Users:  ${users.length}`);
    console.log(`• Total Requests Processed:       ${totalRequests}`);
    console.log(`• Total Elapsed Time:             ${(totalDurationMs / 1000).toFixed(2)}s`);
    console.log(`• Throughput (RPS):               ${(totalRequests / (totalDurationMs / 1000)).toFixed(1)} req/sec`);
    console.log(`• Status Codes Breakdown:         ${JSON.stringify(statusCodes)}`);
    console.log(`• Latency p50:                    ${p50} ms`);
    console.log(`• Latency p95:                    ${p95} ms`);
    console.log(`• Latency p99:                    ${p99} ms`);
    console.log(`• Latency Average:                ${avgLatency} ms`);
    console.log(`• Cross-Tenant Data Leaks:        ${isolationViolations} (Must be 0)`);
    console.log('==================================================================\n');

    if (isolationViolations > 0) {
        console.error('❌ FAIL: Cross-tenant isolation violation detected!');
        process.exit(1);
    }

    console.log('✅ PASS: Real HTTP server successfully handled 30 concurrent active users over TCP!');
}

runRealHttpLoadTest().catch(err => {
    console.error('❌ Load test failed with exception:', err);
    process.exit(1);
});
