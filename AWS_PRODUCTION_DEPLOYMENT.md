# AWS Production Deployment Guide
# WhatsApp Automation SaaS — ai4automation.in

---

## Instance Sizing Guide

| Users (WA sessions) | Instance     | RAM  | MAX_CONCURRENT_WHATSAPP_SESSIONS |
|---------------------|--------------|------|----------------------------------|
| Up to 7 sessions    | t3.medium    | 4 GB | 7                                |
| Up to 19 sessions   | t3.large     | 8 GB | 19  <- recommended               |
| Up to 43 sessions   | t3.xlarge    | 16GB | 43                               |

Rule: (RAM_GB - 1.5) x 3 = max sessions
Note: "30 dashboard users" does not require "30 simultaneous Chrome sessions" —
SESSION_IDLE_TIMEOUT_MS hibernates Chrome for idle users.

---

## Pre-requisites

- AWS CLI v2 configured with appropriate IAM credentials
- Docker and Docker Compose installed on the EC2 instance
- Domain DNS pointing to an Elastic IP (not ephemeral IP)
- GitHub repository with Actions secrets: SSH_HOST, SSH_USER, SSH_PRIVATE_KEY

---

## Step 1 — Launch EC2 Instance

```bash
# Choose Ubuntu 22.04 LTS, t3.large, and your key pair
aws ec2 run-instances \
  --image-id ami-0c02fb55956c7d316 \
  --instance-type t3.large \
  --key-name your-key-pair \
  --security-group-ids sg-XXXXXXXX \
  --subnet-id subnet-XXXXXXXX \
  --block-device-mappings '[{
    "DeviceName":"/dev/sda1",
    "Ebs":{"VolumeSize":30,"VolumeType":"gp3","Encrypted":true}
  }]' \
  --metadata-options HttpTokens=required \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=whatsapp-automation-prod}]'
```

## Step 2 — Allocate and Associate Elastic IP

```bash
ALLOC_ID=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
aws ec2 associate-address --instance-id i-XXXXXXXXX --allocation-id $ALLOC_ID
```

## Step 3 — Security Group Rules

Allow only:
- Port 22  (SSH) from YOUR_IP/32 only (not 0.0.0.0/0)
- Port 80  (HTTP) from 0.0.0.0/0 — Caddy redirects to HTTPS
- Port 443 (HTTPS) from 0.0.0.0/0

DENY everything else inbound. Port 3000 must NOT be open to the internet.

```bash
aws ec2 authorize-security-group-ingress --group-id sg-XXX --protocol tcp --port 22 --cidr YOUR_IP/32
aws ec2 authorize-security-group-ingress --group-id sg-XXX --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id sg-XXX --protocol tcp --port 443 --cidr 0.0.0.0/0
```

## Step 4 — Server Setup (run on EC2 via SSH)

```bash
# Update system
sudo apt-get update && sudo apt-get upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sudo bash
sudo usermod -aG docker ubuntu

# Install Docker Compose plugin
sudo apt-get install -y docker-compose-plugin

# Create swap (recommended for Chrome burst tolerance)
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Verify swap is active
free -h
```

## Step 5 — Deploy Application

```bash
# Clone or rsync the code (CI does this automatically after passing tests)
git clone https://github.com/yourusername/whatsapp-automation.git /home/ubuntu/whatsapp-automation
cd /home/ubuntu/whatsapp-automation

# Create production .env from the template
cp PRODUCTION_ENV.example .env
nano .env   # Fill in SESSION_SECRET, GEMINI_API_KEY, BOOTSTRAP_ADMIN_EMAIL, etc.

# Set secure permissions on .env
chmod 600 .env

# Update Caddyfile with your domain (already set to ai4automation.in)
# cat Caddyfile   # verify domain

# Start the stack
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Watch logs for startup
sudo docker compose logs -f --tail=50
```

## Step 6 — Verify Deployment

```bash
# Check container is running
sudo docker compose ps

# Health check
curl -sf https://ai4automation.in/health

# Ready check
curl -sf https://ai4automation.in/ready

# Check no secrets in image layers
sudo docker history whatsapp-automation-app --no-trunc | grep -i "env\|secret\|key\|password"
# Expect: nothing returned (no secrets in layers)
```

## Step 7 — DNS Setup

```bash
# Point your domain to the Elastic IP
# In your DNS provider, create:
#   A    @           <ELASTIC_IP>
#   A    www         <ELASTIC_IP>
# Or CNAME www -> @ if your provider supports it

# Caddy will auto-provision Let's Encrypt TLS on first HTTPS request
# Watch for it:
sudo docker compose logs caddy -f | grep -i "certificate\|acme\|tls"
```

## Step 8 — First Boot Admin Setup

After deployment, set up the admin account:

1. If BOOTSTRAP_ADMIN_EMAIL is set in .env, the account exists with a placeholder password.
2. Use the change-password API to set a real password:

```bash
# First, log in to get a token (will fail with invalid creds - expected)
# Then use the admin panel to set a password, OR:
# Update the password hash directly in the database (use bcryptjs):

node -e "const b=require('bcryptjs'); b.hash('YourNewPassword123!', 12).then(h => console.log(h))"
# Copy the output hash, then:
sudo docker exec -it whatsapp-automation-app-1 node -e "
  const db = require('./src/services/database');
  db.initDatabase().then(() => {
    db.runSql('UPDATE users SET password_hash=? WHERE email=?', [
      'HASH_FROM_ABOVE',
      'admin@yourdomain.com'
    ]);
    console.log('Password updated');
  });
"
```

## CloudWatch Monitoring Setup

```bash
# Install CloudWatch agent
sudo wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
sudo dpkg -i amazon-cloudwatch-agent.deb

# Configure CloudWatch agent to collect memory metrics (not available by default)
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard

# Create alarms
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)

# CPU alarm
aws cloudwatch put-metric-alarm \
  --alarm-name wa-high-cpu \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=$INSTANCE_ID \
  --statistic Average \
  --period 300 \
  --threshold 85 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --alarm-actions arn:aws:sns:REGION:ACCOUNT:your-sns-topic

# Disk alarm
aws cloudwatch put-metric-alarm \
  --alarm-name wa-high-disk \
  --namespace CWAgent \
  --metric-name disk_used_percent \
  --dimensions Name=InstanceId,Value=$INSTANCE_ID Name=path,Value=/ \
  --statistic Average \
  --period 300 \
  --threshold 70 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --alarm-actions arn:aws:sns:REGION:ACCOUNT:your-sns-topic
```

## Backup and Restore Procedure

### Manual backup:
```bash
sudo docker exec whatsapp-automation-app-1 node -e "
  require('./src/services/database').initDatabase().then(() => {
    require('./src/services/database').forcePersist();
    console.log('Database flushed');
  });
"
sudo cp /home/ubuntu/whatsapp-automation/data/whatsapp.db \
        /home/ubuntu/whatsapp-automation/data/whatsapp.db.bak.$(date +%Y%m%d_%H%M%S)
```

### Restore from backup:
```bash
sudo docker compose down
sudo cp /home/ubuntu/whatsapp-automation/data/whatsapp.db.bak.TIMESTAMP \
        /home/ubuntu/whatsapp-automation/data/whatsapp.db
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### EBS Snapshot (recommended daily):
```bash
VOLUME_ID=$(aws ec2 describe-instances --instance-ids $INSTANCE_ID \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' \
  --output text)
aws ec2 create-snapshot --volume-id $VOLUME_ID --description "whatsapp-automation-$(date +%Y%m%d)"
```

## Rollback Procedure

```bash
# If a deployment fails health check, roll back to the previous image:
sudo docker compose down
git checkout HEAD~1  # or git checkout <last-good-commit>
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
curl -sf https://ai4automation.in/health
```

## Updating the Application

The CI pipeline handles this automatically:
1. Push to updated-WA branch
2. GitHub Actions: npm ci -> npm test -> docker build (all must pass)
3. If all pass: rsync to EC2, docker compose up --build
4. Health check verifies the new container is serving requests
5. If health check fails after retries: workflow fails, old container still running

Manual update:
```bash
cd /home/ubuntu/whatsapp-automation
git pull origin updated-WA
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
curl -sf https://ai4automation.in/health
```

## Cost Estimate (AWS, ap-south-1)

| Component         | Type       | Monthly Cost (approx) |
|-------------------|------------|----------------------|
| EC2 t3.large      | On-Demand  | ~$60                 |
| EC2 t3.large      | 1yr Reserved| ~$38                |
| EBS gp3 30GB      |            | ~$2.40               |
| Elastic IP (active)|           | Free                 |
| Data transfer     | 10GB/month | ~$1                  |
| CloudWatch        | Basic      | ~$3                  |
| **Total**         | On-Demand  | **~$66/month**       |
| **Total**         | 1yr Reserved| **~$44/month**      |

Note: Route53 hosted zone = ~$0.50/month if using AWS DNS.
