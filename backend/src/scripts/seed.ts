import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seeding...');

  // Create admin user
  const adminPassword = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@commitbase.com' },
    update: {},
    create: {
      email: 'admin@commitbase.com',
      name: 'Admin User',
      password: adminPassword,
      role: 'SUPERADMIN',
    },
  });

  // Create regular user
  const userPassword = await bcrypt.hash('user123', 12);
  const user = await prisma.user.upsert({
    where: { email: 'user@commitbase.com' },
    update: {},
    create: {
      email: 'user@commitbase.com',
      name: 'Demo User',
      password: userPassword,
      role: 'USER',
    },
  });

  console.log('✅ Users created:', { admin: admin.email, user: user.email });

  // Create sample applications for the user
  const applications = await Promise.all([
    prisma.application.create({
      data: {
        name: 'Portfolio Website',
        domain: 'portfolio.yourdomain.com',
        type: 'STATIC',
        status: 'RUNNING',
        port: 80,
        memory: '45MB',
        cpu: '2%',
        uptime: '2d 14h',
        repository: 'https://github.com/user/portfolio.git',
        branch: 'main',
        buildCommand: 'npm run build',
        envVars: { NODE_ENV: 'production' },
        userId: user.id,
      },
    }),
    prisma.application.create({
      data: {
        name: 'API Server',
        domain: 'api.yourdomain.com',
        type: 'NODEJS',
        status: 'RUNNING',
        port: 3000,
        memory: '120MB',
        cpu: '5%',
        uptime: '5d 8h',
        repository: 'https://github.com/user/api-server.git',
        branch: 'main',
        buildCommand: 'npm install',
        startCommand: 'npm start',
        envVars: { 
          NODE_ENV: 'production',
          PORT: '3000',
          DATABASE_URL: 'postgresql://user:pass@localhost:5432/api_db'
        },
        userId: user.id,
      },
    }),
    prisma.application.create({
      data: {
        name: 'Blog',
        domain: 'blog.yourdomain.com',
        type: 'NODEJS',
        status: 'STOPPED',
        port: 3001,
        memory: '0MB',
        cpu: '0%',
        repository: 'https://github.com/user/blog.git',
        branch: 'main',
        buildCommand: 'npm install',
        startCommand: 'npm start',
        envVars: { NODE_ENV: 'production' },
        userId: user.id,
      },
    }),
  ]);

  console.log('✅ Applications created:', applications.length);

  // Create sample deployments
  const deployments = await Promise.all([
    prisma.deployment.create({
      data: {
        status: 'SUCCESS',
        buildLogs: 'Build completed successfully',
        deployLogs: 'Deployment successful',
        commitHash: 'abc123def456',
        commitMessage: 'Update portfolio design',
        buildTime: 45,
        buildSize: '2.3MB',
        applicationId: applications[0].id,
        userId: user.id,
      },
    }),
    prisma.deployment.create({
      data: {
        status: 'SUCCESS',
        buildLogs: 'Build completed successfully',
        deployLogs: 'Deployment successful',
        commitHash: 'def456ghi789',
        commitMessage: 'Add new API endpoints',
        buildTime: 120,
        buildSize: '15.7MB',
        applicationId: applications[1].id,
        userId: user.id,
      },
    }),
  ]);

  console.log('✅ Deployments created:', deployments.length);

  // Create sample databases
  const databases = await Promise.all([
    prisma.database.create({
      data: {
        name: 'api_database',
        type: 'POSTGRESQL',
        status: 'RUNNING',
        connectionString: 'postgresql://user:password@localhost:5432/api_database',
        port: 5432,
        memory: '256MB',
        cpu: '3%',
        version: '14.5',
        applicationId: applications[1].id,
      },
    }),
    prisma.database.create({
      data: {
        name: 'blog_cache',
        type: 'REDIS',
        status: 'RUNNING',
        connectionString: 'redis://localhost:6379',
        port: 6379,
        memory: '128MB',
        cpu: '1%',
        version: '7.0',
        applicationId: applications[2].id,
      },
    }),
  ]);

  console.log('✅ Databases created:', databases.length);

  // Create sample logs
  const logs = await Promise.all([
    prisma.log.create({
      data: {
        level: 'INFO',
        message: 'Application started successfully',
        applicationId: applications[0].id,
        userId: user.id,
      },
    }),
    prisma.log.create({
      data: {
        level: 'INFO',
        message: 'API server listening on port 3000',
        applicationId: applications[1].id,
        userId: user.id,
      },
    }),
    prisma.log.create({
      data: {
        level: 'WARN',
        message: 'High memory usage detected',
        applicationId: applications[1].id,
        userId: user.id,
      },
    }),
  ]);

  console.log('✅ Logs created:', logs.length);

  // Create sample system metrics
  const metrics = await Promise.all([
    prisma.systemMetric.create({
      data: {
        type: 'CPU_USAGE',
        value: 15.5,
        unit: '%',
        metadata: { timestamp: new Date() },
      },
    }),
    prisma.systemMetric.create({
      data: {
        type: 'MEMORY_USAGE',
        value: 2048,
        unit: 'MB',
        metadata: { timestamp: new Date() },
      },
    }),
    prisma.systemMetric.create({
      data: {
        type: 'DISK_USAGE',
        value: 45.2,
        unit: '%',
        metadata: { timestamp: new Date() },
      },
    }),
  ]);

  console.log('✅ System metrics created:', metrics.length);

  console.log('🎉 Database seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  }); 