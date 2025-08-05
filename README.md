# CommitBase

CommitBase is an application management platform with a frontend and backend architecture.

## Project Structure

- `frontend/`: React-based frontend application
- `backend/`: Node.js Express backend API

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- PM2 (installed globally or through the project dependencies)

### Installation

1. Clone the repository
2. Install dependencies for the root project, frontend, and backend:

```bash
# Install root dependencies (including PM2)
npm install

# Install backend dependencies
cd backend
npm install
cd ..

# Install frontend dependencies
cd frontend
npm install
cd ..
```

## Running the Application

This project uses PM2 to manage both the frontend and backend processes. The configuration is defined in `ecosystem.config.js`.

### Available Scripts

- `npm start`: Start both frontend and backend in production mode
- `npm run start:dev`: Start both frontend and backend in development mode
- `npm run stop`: Stop all running processes
- `npm run restart`: Restart all processes
- `npm run delete`: Delete all processes from PM2
- `npm run logs`: View logs from all processes
- `npm run status`: Check the status of all processes

### IDE Run Configurations

This project includes run configurations for popular IDEs:

#### Visual Studio Code

The `.vscode/launch.json` file contains the following run configurations:

- **Backend: Start**: Runs the backend server in development mode
- **Frontend: Start**: Runs the frontend server in development mode
- **Full Stack: Start**: Runs both frontend and backend using PM2

To use these configurations:
1. Open the project in VS Code
2. Go to the Run and Debug view (Ctrl+Shift+D)
3. Select the desired configuration from the dropdown
4. Click the green play button or press F5

#### JetBrains IDEs (WebStorm, IntelliJ IDEA, etc.)

The `.idea/runConfigurations/` directory contains the following run configurations:

- **Backend: Start**: Runs the backend server in development mode
- **Frontend: Start**: Runs the frontend server in development mode
- **Full Stack: Start**: Runs both frontend and backend as a compound configuration
- **PM2: Full Stack**: Runs both frontend and backend using PM2

To use these configurations:
1. Open the project in your JetBrains IDE
2. Select the desired configuration from the run configuration dropdown in the toolbar
3. Click the green play button or press Shift+F10

### Development Mode

To start the application in development mode with hot-reloading:

```bash
npm run start:dev
```

### Production Mode

To start the application in production mode:

```bash
npm start
```

## License

MIT