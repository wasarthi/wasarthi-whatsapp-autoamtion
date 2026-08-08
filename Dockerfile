# --- WhatsApp Automation — production image ---------------------------------
# whatsapp-web.js drives a real headless Chromium per connected WhatsApp
# account, so this image needs the same system libraries a desktop Chrome
# install would need. This is the same package list already documented in
# README.md's "Requirements" section for a bare Linux server — a container
# needs it for the identical reason (it's still just Linux underneath).
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
    libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
    libxtst6 lsb-release wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, in their own layer — this only re-runs (and re-downloads
# Chromium via puppeteer's postinstall) when package.json actually changes,
# not on every code edit.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# Everything that needs to survive a restart or redeploy lives under these
# paths — the SQLite database, the session-signing secret, and every
# tenant's saved WhatsApp login. Mount them as named volumes (see
# docker-compose.yml) or a rebuild wipes every connected account's session.
RUN mkdir -p /app/data /app/.wwebjs_auth /app/.wwebjs_cache
VOLUME ["/app/data", "/app/.wwebjs_auth", "/app/.wwebjs_cache"]

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "launcher.js"]
