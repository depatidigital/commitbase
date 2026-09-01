import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Reset a user password from the server.
 *   npx tsx src/scripts/setPassword.ts admin@commitbase.com            # generates one
 *   npx tsx src/scripts/setPassword.ts admin@commitbase.com 'my-pass'  # sets a specific one
 */
async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error('Usage: tsx src/scripts/setPassword.ts <email> [password]');
    process.exit(1);
  }

  const password = process.argv[3] || crypto.randomBytes(12).toString('base64url');

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }

  await prisma.user.update({
    where: { email },
    data: { password: await bcrypt.hash(password, 12) },
  });

  console.log(`✅ Password updated for ${email}`);
  if (!process.argv[3]) {
    console.log(`   New password: ${password}`);
    console.log('   Store it now — it is not recoverable from the database.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
