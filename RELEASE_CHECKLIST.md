# Release Checklist

Complete every item before deploying to production.

## Build & Dependencies
- [ ] npm ci completes with no errors
- [ ] npm audit reviewed - no Critical/High unfixed vulnerabilities
- [ ] node --version confirms Node 20+

## Automated Tests (VERIFIED)
- [x] 239/239 tests pass - npm test exits 0
- [x] 0 failed suites - all 5 suites pass
- [x] tenant-isolation.test.js PASS (0 cross-tenant leaks)
- [x] auth.security.test.js PASS (0 auth bypass)
- [x] validation.test.js PASS
- [x] conversation-queue.test.js PASS
- [x] jobs-scheduler-ai.test.js PASS
- [ ] Tests pass inside Docker container (npm test inside running container)
- [ ] Tests pass in GitHub Actions CI (no .env present)

## Docker
- [ ] docker build --no-cache succeeds
- [ ] docker history shows no .env in layers
- [ ] /health returns {"status":"ok"}
- [ ] /ready returns {"ready":true}
- [ ] docker compose down && up - data persists
- [ ] Non-root user: docker exec whoami returns "node"
- [ ] chromium --version works inside container

## Security
- [x] SESSION_SECRET is at least 64 characters in production .env
- [x] BOOTSTRAP_ADMIN_EMAIL NOT in developer local .env
- [ ] TRUST_PROXY=true only when Caddy confirmed in front
- [ ] FORCE_HTTPS=true in production .env
- [ ] .env in .gitignore, never committed (verify git log --all -- .env)
- [ ] Security headers present (X-Content-Type-Options, X-Frame-Options, CSP, HSTS)
- [ ] Admin panel unreachable by regular user
- [ ] IDOR check: user cannot access another user's data by guessing ID

## Capacity & Performance (VERIFIED)
- [x] 30-user load test PASS - 1800 requests, 100% HTTP 200, 0 data leaks
- [x] p95 < 3000ms under 30-user load (measured: 2158ms)
- [x] 0 cross-tenant data leaks in load test
- [ ] MAX_CONCURRENT_WHATSAPP_SESSIONS set correctly for instance size
- [ ] Memory headroom > 20% after peak load
- [ ] MEM_LIMIT and SWAP_LIMIT set in .env

## AWS Infrastructure
- [ ] EC2 instance sized for session target (t3.large for 19 WA sessions)
- [ ] EBS volume encrypted
- [ ] Security Group: only 80/443 public, 22 SSH from known IP only
- [ ] Port 3000 NOT exposed to internet
- [ ] IMDSv2 required
- [ ] CloudWatch agent sending memory metrics
- [ ] Domain DNS A record points to Elastic IP (not ephemeral)
- [ ] TLS certificate issued by Caddy

## Persistence & Backup
- [ ] Database persists across container restart
- [ ] Backup script tested (scripts/backup-db.sh)
- [ ] Restore drill completed
- [ ] EBS snapshot policy configured (daily, 7-day retention)
- [ ] Disk space alarm at 70%

## Monitoring & Alerting
- [ ] CPU alarm: >85% for 5 minutes
- [ ] Memory alarm: >85%
- [ ] Disk alarm: >70%
- [ ] Health check alarm: /ready non-200

## CI/CD (VERIFIED)
- [x] deploy.yml has npm ci + npm test + docker build gates
- [x] Deploy only runs after test job passes (needs: test)
- [ ] GitHub Actions secrets configured: SSH_HOST, SSH_USER, SSH_PRIVATE_KEY
- [ ] First CI run after gate addition confirms tests pass

## Operational Readiness
- [ ] Admin account created with real password (not placeholder hash)
- [ ] Test WhatsApp QR scan completed on live deployment
- [ ] Graceful shutdown tested (docker stop -> verify DB flush in logs)
- [ ] Rollback procedure tested

---
Last updated: 2026-08-30 | Tests: 239/239 PASS | Load test: 30 users, 0 failures, p95=2158ms
