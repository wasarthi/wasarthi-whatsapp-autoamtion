# WA Sarthi -- WHATSAPP AUTOMATION PLATFORM

## Final AWS Pre-Deployment Audit

Audit date: 25 September 2026
Target repository: https://github.com/wasarthi/wasarthi-whatsapp-autoamtion.git

---

## 1. Release Gate Summary

The codebase is broadly ready to push for AWS deployment after the security cleanup below.

### Passed Checks

- Full Jest suite passed after dependency updates:
  - 8 test suites passed
  - 283 tests passed
  - 0 failed assertions
- Portable lint/syntax check passed:
  - 44 JavaScript files checked
- Runtime secrets are ignored:
  - `.env`
  - `data/`
  - `documents/`
  - `.wwebjs_auth/`
  - `.wwebjs_cache/`
  - `keys/`
  - `*.pem`
  - `*.key`
- Previously tracked SSH key files were removed from git tracking:
  - `keys/id_rsa.pem`
  - `keys/id_rsa.pub`
- Safe dependency audit fixes were applied for:
  - `express`
  - `body-parser`
  - `qs`
  - `js-yaml`

### Remaining Deployment Notes

- Docker is installed on the local Windows machine, but the Docker Desktop Linux engine was not running during this audit. Local image build could not be completed here.
- `npm audit` still reports a high-severity advisory through `whatsapp-web.js -> puppeteer -> @puppeteer/browsers -> extract-zip`.
- The suggested `npm audit fix --force` path would downgrade `whatsapp-web.js`, which may break WhatsApp Web compatibility. It was intentionally not applied.
- Jest exits with open-handle warnings from the metrics timer when using `--detectOpenHandles`; tests pass, but cleanup can be improved later.

---

## 2. Admin Setup for AWS

Use `BOOTSTRAP_ADMIN_EMAIL` in production `.env` for the first admin.

Recommended production `.env` values:

```env
NODE_ENV=production
PORT=3000
SESSION_SECRET=<generate-48-byte-random-hex>
BOOTSTRAP_ADMIN_EMAIL=admin@yourdomain.com
APP_URL=https://your-domain.com
ALLOWED_ORIGINS=https://your-domain.com
TRUST_PROXY=true
FORCE_HTTPS=true
MAX_CONCURRENT_WHATSAPP_SESSIONS=19
SESSION_IDLE_TIMEOUT_MS=7200000
```

Generate a strong session secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Important Admin Behavior

- New public signups do not automatically become admin once the system has users.
- `BOOTSTRAP_ADMIN_EMAIL` promotes an existing account to admin or creates a placeholder admin if the account does not exist.
- If the placeholder admin is created, set a real password immediately using the documented production database update method or a controlled admin creation script.
- Do not leave weak admin passwords.
- After deployment, log in as admin and confirm:
  - Admin panel opens at `/admin`
  - User list loads
  - WhatsApp access can be enabled/disabled
  - Document sending can be enabled/disabled
  - Business vertical can be changed

---

## 3. Security Review

### Good

- Passwords are bcrypt-hashed.
- Session cookies are signed with a server-side secret.
- Production rejects weak placeholder session secrets.
- Admin authorization is checked from the database, not only from token claims.
- Demoted/suspended users have sessions revoked.
- Tenant data is scoped by `user_id`.
- WhatsApp sessions are isolated per user.
- Runtime data is excluded from git.
- Document upload validation checks extension, MIME type, size, and file signature.
- Admin controls exist for WhatsApp access and document sending.
- Rate limits exist for login/signup, writes, sends, imports, AI jobs, and WhatsApp connection attempts.
- Caddy production reverse proxy is configured for HTTPS and SSE streaming.

### Must Do Before AWS Production

1. Rotate the SSH key previously tracked in git.
2. Do not reuse `keys/id_rsa.pem` for GitHub Actions, AWS, or SSH.
3. Store deployment SSH key as a GitHub Actions secret, not in the repo.
4. Set `.env` permissions on EC2:

```bash
chmod 600 .env
```

5. Do not expose port `3000` publicly. Only ports `80` and `443` should be open to the internet.
6. Restrict SSH `22` to your own IP address.
7. Use an Elastic IP and domain DNS before enabling Caddy TLS.
8. Set `APP_URL` and `ALLOWED_ORIGINS` to the real production domain.
9. Rotate `SESSION_SECRET` if it was ever shared.
10. Rotate Gemini and Google Calendar credentials if they were ever placed in a shared file.

---

## 4. AWS Deployment Recommendation

Recommended starting instance:

- EC2: `t3.large`
- RAM: 8 GB
- Disk: 30 GB gp3 encrypted EBS
- Swap: 4 GB
- Reverse proxy: Caddy
- App runtime: Docker Compose
- Public ports: `80`, `443`
- Private app port: `3000`

Recommended WhatsApp capacity:

```env
MAX_CONCURRENT_WHATSAPP_SESSIONS=19
SESSION_IDLE_TIMEOUT_MS=7200000
MEM_LIMIT=6G
SWAP_LIMIT=6G
```

For true 30 simultaneous active WhatsApp browser sessions, use a larger instance such as `t3.xlarge` and validate memory under real sessions.

---

## 5. Deployment Steps

1. Push the cleaned code to GitHub.
2. Launch EC2 Ubuntu.
3. Install Docker and Docker Compose plugin.
4. Clone the GitHub repository on EC2.
5. Copy `PRODUCTION_ENV.example` to `.env`.
6. Fill all production values.
7. Set `.env` permissions to `600`.
8. Update `Caddyfile` to the real domain.
9. Start production stack:

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

10. Verify:

```bash
curl -sf https://your-domain.com/health
curl -sf https://your-domain.com/ready
sudo docker compose logs -f --tail=100
```

---

## 6. Final Status

The code can be pushed after committing the current cleanup and audit changes.

Deployment is acceptable with the following conditions:

- Rotate the previously tracked SSH key.
- Complete Docker build verification on a running Docker engine or on EC2.
- Accept or monitor the remaining Puppeteer/extract-zip advisory until upstream packages provide a non-breaking fix.
- Use HTTPS through Caddy and keep the app port private.
- Use a strong `SESSION_SECRET`.
- Configure the admin account intentionally with `BOOTSTRAP_ADMIN_EMAIL`.
