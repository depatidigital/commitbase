module.exports = {
  apps: [
    {
      name: 'backend',
      cwd: './backend',
      script: 'yarn',
      args: 'start',
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
        script: 'yarn',
        args: 'dev'
      }
    },
    {
      name: 'frontend',
      cwd: './frontend',
      script: 'yarn',
      args: 'dev',
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development'
      }
    }
  ]
};
