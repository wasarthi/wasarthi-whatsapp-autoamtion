const fs = require('fs');
const path = require('path');
const dotenvPath = path.join('F:', 'Sales_agent_demo-main', '.env');
const envContent = fs.readFileSync(dotenvPath, 'utf8');
const dbUrlLine = envContent.split(/\r?\n/).find(line => line.startsWith('DATABASE_URL='));
const dbUrl = dbUrlLine ? dbUrlLine.substring(dbUrlLine.indexOf('=')+1).trim().replace(/^"|"$/g, '') : null;

process.env.DATABASE_URL = dbUrl;

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.adminUser.upsert({
    where: { email: 'vedicagrawalmva@gmail.com' },
    update: {
      password: 'password123',
      name: 'Vedic Agrawal'
    },
    create: {
      email: 'vedicagrawalmva@gmail.com',
      password: 'password123',
      name: 'Vedic Agrawal'
    }
  });
  console.log('Admin user created/updated:', admin.email);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
