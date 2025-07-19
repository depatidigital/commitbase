#!/bin/bash

echo "🚀 Setting up PM2 for CommitBase deployment system..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

# Install PM2 globally
echo "📦 Installing PM2 globally..."
npm install -g pm2

# Check if PM2 installation was successful
if ! command -v pm2 &> /dev/null; then
    echo "❌ Failed to install PM2. Please check your npm configuration."
    exit 1
fi

echo "✅ PM2 installed successfully!"

# Create apps directory
echo "📁 Creating apps directory..."
mkdir -p apps

# Set up PM2 startup script
echo "⚙️ Setting up PM2 startup script..."
pm2 startup

echo "🎉 PM2 setup completed successfully!"
echo ""
echo "📋 Next steps:"
echo "1. Run 'pm2 save' to save current PM2 configuration"
echo "2. Start the backend server: npm run dev"
echo "3. Deploy your first application!"
echo ""
echo "📖 PM2 Commands:"
echo "- pm2 list                    # List all processes"
echo "- pm2 logs [app-name]         # View logs"
echo "- pm2 restart [app-name]      # Restart application"
echo "- pm2 stop [app-name]         # Stop application"
echo "- pm2 delete [app-name]       # Delete application"
echo "- pm2 monit                   # Monitor processes" 