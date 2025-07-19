import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const domains = [
  'oyisiindonesia.id',
  'depatierp.my.id',
  'depatidigital.com',
  'semata.id'
];

async function seedDomains() {
  try {
    console.log('🌱 Seeding domains...');

    // Get the first user (admin) to assign domains to
    const user = await prisma.user.findFirst();
    
    if (!user) {
      console.error('❌ No user found. Please create a user first.');
      return;
    }

    console.log(`📝 Found user: ${user.email}`);

    for (const domainName of domains) {
      // Check if domain already exists
      const existingDomain = await prisma.domain.findUnique({
        where: { name: domainName },
      });

      if (existingDomain) {
        console.log(`⚠️  Domain ${domainName} already exists, skipping...`);
        continue;
      }

      // Create domain
      const domain = await prisma.domain.create({
        data: {
          name: domainName,
          status: 'ACTIVE',
          sslStatus: 'ACTIVE',
          sslExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year from now
          dnsRecords: {
            a: '192.168.1.1',
            cname: 'app.commitbase.com',
            mx: 'mail.commitbase.com',
          },
          userId: user.id,
        },
      });

      console.log(`✅ Created domain: ${domain.name}`);
    }

    console.log('🎉 Domain seeding completed!');
  } catch (error) {
    console.error('❌ Error seeding domains:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the seed function
seedDomains(); 