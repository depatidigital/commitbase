import { DeploymentService } from '../services/deployment';
import { prisma } from '../lib/prisma';

async function testDeployment() {
  try {
    console.log('🧪 Testing deployment service...');

    const deploymentService = new DeploymentService();

    // Test app directory preparation
    console.log('📁 Testing app directory preparation...');
    const appDir = await deploymentService.prepareAppDirectory('test-app');
    console.log('✅ App directory prepared:', appDir);

    // Test repository sync (if you have a test repo)
    console.log('📥 Testing repository sync...');
    try {
      await deploymentService.syncRepository(
        appDir, 
        'https://github.com/your-test-repo.git',
        'main'
      );
      console.log('✅ Repository synced successfully');
    } catch (error) {
      console.log('⚠️ Repository sync failed (expected for test):', error.message);
    }

    // Test dependency installation
    console.log('📦 Testing dependency installation...');
    try {
      const result = await deploymentService.installDependencies(appDir);
      console.log('✅ Dependencies installed:', result);
    } catch (error) {
      console.log('⚠️ Dependency installation failed (expected for test):', error.message);
    }

    // Test build command
    console.log('🔨 Testing build command...');
    const buildResult = await deploymentService.runBuildCommand(
      appDir,
      'echo "Build completed successfully"',
      { NODE_ENV: 'production' }
    );
    console.log('✅ Build result:', buildResult);

    // Test application status
    console.log('📊 Testing application status...');
    const status = await deploymentService.getApplicationStatus('test-app');
    console.log('✅ Application status:', status);

    console.log('🎉 All deployment service tests completed!');

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the test
testDeployment(); 