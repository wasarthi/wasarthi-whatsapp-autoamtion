# WhatsApp Automation & AI Assistant 🤖

A self-hosted WhatsApp automation bot with a real-time admin dashboard. Powered by **Node.js**, **Google Gemini AI**, and **whatsapp-web.js**.

---

## ✨ Features

- 🤖 **Gemini AI Replies** — Responds to WhatsApp messages naturally on your behalf using Google Gemini.
- 📱 **QR Code Login** — Connect your WhatsApp account by scanning a QR code in the dashboard.
- 💬 **Admin Dashboard** — Manage conversations, contacts, chatbot rules, and scheduled messages from a web UI.
- 📅 **Scheduled Messages** — Schedule broadcasts to any contact with automatic delivery.
- 🔑 **Keyword Rules** — Set up keyword-triggered auto-replies with exact, contains, startswith, or regex matching.
- 💾 **Persistent SQLite Database** — All your data is saved locally. No external database needed.
- 🔄 **Crash-Proof** — Automatic restart with exponential back-off if anything goes wrong.

---

## 🛠️ Requirements

Before running, make sure you have:

- [Node.js](https://nodejs.org/) v18 or higher — **required**
- [Git](https://git-scm.com/) — to clone the repo
- A Google account with a [Gemini API key](https://aistudio.google.com/app/apikey) — for AI replies (free)

---

## 🚀 Quick Start

### 1. Clone the repository
```bash
git clone https://github.com/vedicagrawal12/whatsapp-automation.git
cd whatsapp-automation
```

### 2. Install dependencies
```bash
npm install
```

> ⚠️ On **Linux/Mac servers**, Chrome requires extra system packages. Run:
> ```bash
> sudo apt-get install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils
> ```

### 3. Configure your environment
Copy the example config file and fill in your Gemini API key:
```bash
# Windows (Command Prompt)
copy .env.example .env

# Mac / Linux
cp .env.example .env
```

Then open `.env` and set your Gemini API key:
```env
PORT=3000
DEMO_MODE=false
GEMINI_API_KEY=your_gemini_api_key_here
```

Get a free API key at: https://aistudio.google.com/app/apikey

### 4. Start the server
```bash
npm run dev
```

### 5. Open the dashboard
Navigate to **http://localhost:3000** in your browser.

Go to **Settings → WhatsApp QR** and scan the QR code with your WhatsApp mobile app:
- Open WhatsApp → tap the three dots (⋮) → **Linked Devices** → **Link a Device** → scan the QR.

Once scanned, the bot is live and will automatically reply to incoming messages using Gemini AI!

---

## 📁 Project Structure

```
whatsapp-automation/
├── .env.example          # Template for your environment config
├── .gitignore            # Ignores secrets, session data, and database
├── package.json          # Node.js dependencies & scripts
├── launcher.js           # Crash-proof server wrapper (exponential back-off)
├── server.js             # Express HTTP server & API
├── public/               # Web dashboard (HTML, CSS, JS)
│   └── index.html
└── src/
    ├── ai.js             # Google Gemini AI integration
    ├── chatbot.js        # Message processing & rule matching
    ├── database.js       # SQLite database (sql.js)
    ├── scheduler.js      # Cron-based scheduled message delivery
    ├── whatsapp-client.js # whatsapp-web.js client & session management
    └── routes/
        └── api.js        # REST API endpoints
```

---

## 🔒 Security Notes

- **Never share your `.env` file.** It contains your API key.
- **Never commit `.wwebjs_auth/`** — it contains your WhatsApp session tokens.
- The `.gitignore` is pre-configured to protect all sensitive files automatically.

---

## 📄 License
MIT License. Free to use and customise for personal or business projects.
