import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Starting Git account migration from integration_configs...');

  const users = await prisma.user.findMany();

  let createdCount = 0;

  for (const user of users) {
    const githubToken = await prisma.integrationConfig.findUnique({
      where: {
        provider_key: {
          provider: 'github',
          key: user.id,
        },
      },
    });

    if (githubToken && githubToken.value) {
      await prisma.gitAccount.upsert({
        where: {
          userId_provider_externalId: {
            userId: user.id,
            provider: 'github',
            externalId: user.email,
          },
        },
        create: {
          userId: user.id,
          provider: 'github',
          externalId: user.email,
          username: user.email,
          displayName: user.name || user.email,
          accessToken: githubToken.value,
        },
        update: {
          accessToken: githubToken.value,
        },
      });

      createdCount++;
    }

    const gitlabToken = await prisma.integrationConfig.findUnique({
      where: {
        provider_key: {
          provider: 'gitlab',
          key: user.id,
        },
      },
    });

    if (gitlabToken && gitlabToken.value) {
      await prisma.gitAccount.upsert({
        where: {
          userId_provider_externalId: {
            userId: user.id,
            provider: 'gitlab',
            externalId: user.email,
          },
        },
        create: {
          userId: user.id,
          provider: 'gitlab',
          externalId: user.email,
          username: user.email,
          displayName: user.name || user.email,
          accessToken: gitlabToken.value,
        },
        update: {
          accessToken: gitlabToken.value,
        },
      });

      createdCount++;
    }
  }

  console.log(`✅ Git account migration completed. Accounts created or updated: ${createdCount}`);
}

main()
  .catch((e) => {
    console.error('❌ Error during Git account migration:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

