# WhatsApp Automation & AI Assistant Platform 🚀

An intelligent WhatsApp Business & Web Automation suite powered by **Node.js**, **Google Gemini AI**, and **whatsapp-web.js** / **WhatsApp Cloud API**, featuring a modern real-time Web Dashboard for managing chats, automated responses, scheduled broadcasts, and analytics.

---

## ✨ Features

- 🤖 **Gemini AI Intelligent Responses**: Smart automated answering system with customizable personas and prompt directives.
- 📱 **QR Code Web Client Pairing**: Instant WhatsApp Web connection via real-time QR code display in the browser.
- 💬 **Live Chat & Admin Dashboard**: Monitor conversations, manage contacts, view analytics, and trigger manual or automated actions.
- 📅 **Scheduled Broadcasts**: Schedule messages and marketing campaigns with cron-based triggers.
- 🔒 **Secure Multi-Device Auth**: Persistent session management with automatic credential caching.
- 💾 **Embedded SQLite Database**: Lightweight zero-configuration persistent storage with `sql.js`.
- 🔌 **WhatsApp Cloud API & Webhook Support**: Ready for Meta Cloud API integration.

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js
- **WhatsApp Integration**: `whatsapp-web.js` & WhatsApp Business Cloud API (Axios)
- **AI Engine**: Google Gemini AI (`@google/genai`)
- **Database**: SQLite (`sql.js`)
- **Frontend Dashboard**: HTML5, Modern Vanilla CSS, JavaScript, QR Code Generator

---

## 🚀 Quick Start Guide

### 1. Clone the Repository
```bash
git clone https://github.com/vedicagrawal12/whatsapp-automation.git
cd whatsapp-automation
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Copy the example environment file and fill in your keys:
```bash
cp .env.example .env
```

Edit `.env` with your preferred settings:
```env
PORT=3000
DEMO_MODE=false
GEMINI_API_KEY=your_gemini_api_key_here

# (Optional) If using Meta WhatsApp Cloud API:
WHATSAPP_TOKEN=your_permanent_system_user_token_here
WHATSAPP_PHONE_ID=your_phone_number_id_here
WHATSAPP_BUSINESS_ID=your_business_account_id_here
WEBHOOK_VERIFY_TOKEN=my_secret_verify_token_123
```

### 4. Run the Application
```bash
npm start
```
Then open your browser and navigate to:
```
http://localhost:3000
```
Scan the QR code displayed on screen with your WhatsApp mobile app (**Linked Devices > Link a Device**) to activate automation.

---

## 📁 Project Structure

```
whatsapp-automation/
├── .env.example            # Sample configuration file
├── .gitignore              # Ignored files (auth sessions, db, node_modules)
├── package.json            # Node.js dependencies & scripts
├── launcher.js             # Main application launcher
├── server.js               # Express API and static server
├── fix_db.js               # Database migration & integrity helper
├── public/                 # Web Dashboard interface
│   ├── index.html          # Main dashboard UI
│   └── ...
└── src/
    ├── ai.js               # Google Gemini AI agent logic
    ├── chatbot.js          # Automated conversation flow rules
    ├── database.js         # SQLite database operations
    ├── scheduler.js        # Cron scheduling service
    ├── whatsapp-client.js  # whatsapp-web.js client handler
    ├── whatsapp.js         # WhatsApp Cloud API client
    └── routes/             # Express API endpoints
```

---

## 🔒 Security Best Practices

- **Never commit `.env` or `.wwebjs_auth/` folders.** These contain sensitive authentication tokens and private credentials.
- The repository's `.gitignore` is pre-configured to keep your credentials and database safe.

---

## 📄 License
MIT License. Feel free to use and customize for your projects!
