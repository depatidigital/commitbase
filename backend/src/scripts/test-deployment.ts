import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function createTestDeployment() {
  try {
    // Get the first application
    const application = await prisma.application.findFirst();
    
    if (!application) {
      console.log('No applications found. Please create an application first.');
      return;
    }

    console.log('Creating test deployment for application:', application.name);

    // Create a test deployment
    const deployment = await prisma.deployment.create({
      data: {
        applicationId: application.id,
        userId: application.userId,
        status: 'SUCCESS',
        buildLogs: 'Test build logs\nBuilding application...\nBuild completed successfully',
        deployLogs: 'Test deploy logs\nStarting application...\nApplication started successfully',
        buildTime: 120, // 2 minutes
        buildSize: '45MB',
      },
      include: {
        application: {
          select: {
            id: true,
            name: true,
            domain: true,
          },
        },
      },
    });

    console.log('Test deployment created:', deployment);

    // Test the deployment history API
    const deployments = await prisma.deployment.findMany({
      where: {
        applicationId: application.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        application: {
          select: {
            id: true,
            name: true,
            domain: true,
          },
        },
      },
    });

    console.log('Deployment history:', deployments);

  } catch (error) {
    console.error('Error creating test deployment:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createTestDeployment(); 