# API Integration Documentation

This document describes the API integration implemented in the CommitBase frontend.

## Overview

The frontend now integrates with the CommitBase backend API to provide real-time application management, authentication, and deployment capabilities.

## API Services

### Authentication (`/src/lib/auth.ts`)
- **login(credentials)**: Authenticate user with email/password
- **register(credentials)**: Create new user account
- **logout()**: Clear authentication and redirect to login
- **getCurrentUser()**: Get current user from JWT token
- **isAuthenticated()**: Check if user is authenticated

### Applications (`/src/lib/applications.ts`)
- **getApplications(page, limit)**: Fetch paginated applications
- **getApplication(id)**: Get single application with details
- **createApplication(data)**: Create new application
- **updateApplication(id, data)**: Update application
- **deleteApplication(id)**: Delete application
- **startApplication(id)**: Start application
- **stopApplication(id)**: Stop application
- **restartApplication(id)**: Restart application

### Databases (`/src/lib/databases.ts`)
- **getDatabases(applicationId, page, limit)**: Fetch databases for app
- **getDatabase(id)**: Get single database
- **createDatabase(applicationId, data)**: Create new database
- **updateDatabase(id, data)**: Update database
- **deleteDatabase(id)**: Delete database

### Logs (`/src/lib/logs.ts`)
- **getLogs(applicationId, page, limit, filters)**: Fetch application logs
- **getRealTimeLogs(applicationId)**: Get real-time log stream
- **clearLogs(applicationId)**: Clear application logs
- **exportLogs(applicationId, format, filters)**: Export logs

## React Query Hooks

### Authentication Hooks (`/src/hooks/useAuth.ts`)
- **useLogin()**: Login mutation with error handling
- **useRegister()**: Registration mutation with error handling
- **useLogout()**: Logout mutation

### Application Hooks (`/src/hooks/useApplications.ts`)
- **useApplications(page, limit)**: Query applications with pagination
- **useApplication(id)**: Query single application
- **useCreateApplication()**: Create application mutation
- **useUpdateApplication()**: Update application mutation
- **useDeleteApplication()**: Delete application mutation
- **useStartApplication()**: Start application mutation
- **useStopApplication()**: Stop application mutation
- **useRestartApplication()**: Restart application mutation

### Database Hooks (`/src/hooks/useDatabases.ts`)
- **useDatabases(applicationId, page, limit)**: Query databases
- **useDatabase(id)**: Query single database
- **useCreateDatabase()**: Create database mutation
- **useUpdateDatabase()**: Update database mutation
- **useDeleteDatabase()**: Delete database mutation

### Log Hooks (`/src/hooks/useLogs.ts`)
- **useLogs(applicationId, page, limit, filters)**: Query logs
- **useClearLogs()**: Clear logs mutation
- **useExportLogs()**: Export logs mutation

## Configuration

### Environment Variables
Create a `.env` file in the frontend directory:

```env
# API Configuration
VITE_API_URL=http://localhost:3001
```

### API Base Configuration (`/src/lib/api.ts`)
- Base URL configuration with environment variable support
- Automatic JWT token handling
- Error handling and 401 redirects
- Request/response interceptors

## Authentication Flow

1. **Login**: User enters credentials → API call → JWT stored in localStorage
2. **Protected Routes**: Check authentication on route access
3. **Token Refresh**: Automatic token validation and cleanup
4. **Logout**: Clear token and redirect to login

## Error Handling

All API calls include comprehensive error handling:
- Network errors
- Authentication errors (401 redirects)
- Validation errors
- Server errors
- User-friendly error messages via toast notifications

## Real-time Features

- **Auto-refresh**: Applications list refreshes every 30 seconds
- **Log streaming**: Real-time log updates every 5 seconds
- **Status updates**: Application status changes reflected immediately

## Usage Examples

### Creating an Application
```typescript
import { useCreateApplication } from '@/hooks/useApplications';

const createApp = useCreateApplication();

const handleCreate = async (data) => {
  try {
    await createApp.mutateAsync(data);
    // Success toast shown automatically
    navigate('/');
  } catch (error) {
    // Error toast shown automatically
  }
};
```

### Fetching Applications
```typescript
import { useApplications } from '@/hooks/useApplications';

const { data, isLoading, error } = useApplications(1, 10);

if (isLoading) return <Loading />;
if (error) return <Error />;

const applications = data?.data || [];
```

## Backend Requirements

The frontend expects the backend to provide:

1. **Authentication endpoints**:
   - `POST /auth/login`
   - `POST /auth/register`

2. **Application endpoints**:
   - `GET /applications`
   - `POST /applications`
   - `GET /applications/:id`
   - `PUT /applications/:id`
   - `DELETE /applications/:id`
   - `POST /applications/:id/start`
   - `POST /applications/:id/stop`
   - `POST /applications/:id/restart`

3. **Database endpoints**:
   - `GET /databases`
   - `POST /databases`
   - `GET /databases/:id`
   - `PUT /databases/:id`
   - `DELETE /databases/:id`

4. **Log endpoints**:
   - `GET /logs`
   - `DELETE /logs/:applicationId/clear`
   - `GET /logs/export`

## Security Features

- JWT token-based authentication
- Automatic token validation
- Secure token storage in localStorage
- CSRF protection via proper headers
- Input validation and sanitization
- Error message sanitization

## Performance Optimizations

- React Query for caching and background updates
- Optimistic updates for better UX
- Debounced search inputs
- Lazy loading of components
- Efficient re-renders with proper memoization 