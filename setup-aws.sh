#!/usr/bin/env bash
set -e

# ==============================================================================
# WA Sarthi — 1-Click AWS EC2 Production Deployment Script
# ==============================================================================

echo "🚀 [WA Sarthi] Starting 1-Click AWS Deployment..."

# 1. Update OS and install prerequisites
sudo apt-get update -y
sudo apt-get install -y curl git ufw

# 2. Install Docker & Docker Compose Plugin (if not installed)
if ! command -v docker &> /dev/null; then
    echo "📦 [WA Sarthi] Installing Docker..."
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER" 2>/dev/null || true
    sudo apt-get install -y docker-compose-plugin
fi

# 3. Create 4GB Swap (Essential for WhatsApp Chromium Puppeteer stability)
if [ ! -f /swapfile ]; then
    echo "💾 [WA Sarthi] Setting up 4GB swap space for Chromium memory safety..."
    sudo fallocate -l 4G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

# 4. Clone or update repository
APP_DIR="/home/$USER/wasarthi-whatsapp-autoamtion"
if [ ! -d "$APP_DIR" ]; then
    echo "📥 [WA Sarthi] Cloning repository into $APP_DIR..."
    git clone https://github.com/wasarthi/wasarthi-whatsapp-autoamtion.git "$APP_DIR"
    cd "$APP_DIR"
else
    echo "🔄 [WA Sarthi] Pulling latest code into $APP_DIR..."
    cd "$APP_DIR"
    git pull origin main || true
fi

# 5. Prepare Environment file
if [ ! -f .env ]; then
    echo "⚙️ [WA Sarthi] Creating .env from .env.example..."
    cp .env.example .env
    # Generate random session secret
    RANDOM_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" 2>/dev/null || openssl rand -hex 48)
    sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${RANDOM_SECRET}|" .env
    sed -i "s|^TRUST_PROXY=.*|TRUST_PROXY=true|" .env
fi

# 6. Build and launch container stack
echo "🐳 [WA Sarthi] Building and starting Docker containers..."
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

echo ""
echo "================================================================================"
echo "✅ [WA Sarthi] Successfully deployed and running!"
echo "================================================================================"
echo "📌 Ensure your AWS Security Group has inbound rules for:"
echo "   - Port 80  (HTTP)"
echo "   - Port 443 (HTTPS)"
echo "   - Port 22  (SSH)"
echo ""
echo "🔍 Check logs with: sudo docker compose logs -f"
echo "================================================================================"
