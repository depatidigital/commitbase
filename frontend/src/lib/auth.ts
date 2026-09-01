import apiRequest, { setAuthToken, removeAuthToken } from './api';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'SUPERADMIN' | 'ADMIN' | 'USER' | 'CLIENT';
  mustChangePassword?: boolean;
  createdAt: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterCredentials {
  email: string;
  name?: string;
  password: string;
}

export interface AuthResponse {
  user: User;
  token: string;
}

// Re-export removeAuthToken for convenience
export { removeAuthToken };

// Login user
export const login = async (credentials: LoginCredentials): Promise<AuthResponse> => {
  const response = await apiRequest<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
  });

  if (response.success && response.data) {
    setAuthToken(response.data.token);
    return response.data;
  }

  throw new Error(response.error || 'Login failed');
};

// Register user
export const register = async (credentials: RegisterCredentials): Promise<AuthResponse> => {
  const response = await apiRequest<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(credentials),
  });

  if (response.success && response.data) {
    setAuthToken(response.data.token);
    return response.data;
  }

  throw new Error(response.error || 'Registration failed');
};

// Logout user
export const logout = (): void => {
  removeAuthToken();
  window.location.href = '/login';
};

// Validate user token with backend
export const validateUserToken = async (): Promise<boolean> => {
  try {
    const token = localStorage.getItem('authToken');
    if (!token) return false;

    // Try to make an authenticated request to validate the token
    const response = await apiRequest('/auth/validate', {
      method: 'GET',
    });

    return response.success;
  } catch (error) {
    console.error('Token validation failed:', error);
    return false;
  }
};

// Get current user from token
export const getCurrentUser = (): User | null => {
  const token = localStorage.getItem('authToken');
  if (!token) return null;

  try {
    // Decode JWT token to get user info
    const payload = JSON.parse(atob(token.split('.')[1]));
    return {
      id: payload.userId,
      email: payload.email,
      name: payload.name || '',
      role: payload.role,
      mustChangePassword: !!payload.mustChangePassword,
      createdAt: new Date(payload.iat * 1000).toISOString(),
    };
  } catch (error) {
    console.error('Error decoding token:', error);
    removeAuthToken();
    return null;
  }
};

// Role of the signed-in user, read from the JWT. UI gating only —
// every admin action is also blocked server-side by requireRole().
export const isAdmin = (): boolean => {
  const role = getCurrentUser()?.role;
  return role === 'ADMIN' || role === 'SUPERADMIN';
};

// Platform owner. Integration credentials (RDASH, Cloudflare) are theirs alone.
export const isSuperAdmin = (): boolean => getCurrentUser()?.role === 'SUPERADMIN';

// Admin-issued accounts start with a password the admin also knows.
export const mustChangePassword = (): boolean =>
  !!getCurrentUser()?.mustChangePassword;

export const changePassword = async (
  currentPassword: string,
  newPassword: string
): Promise<void> => {
  const response = await apiRequest<{ token: string }>('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });

  if (response.success && response.data) {
    setAuthToken(response.data.token);
    return;
  }

  throw new Error(response.error || 'Failed to change password');
};

// Check if user is authenticated
export const isAuthenticated = (): boolean => {
  const token = localStorage.getItem('authToken');
  if (!token) return false;

  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const currentTime = Math.floor(Date.now() / 1000);
    return payload.exp > currentTime;
  } catch (error) {
    removeAuthToken();
    return false;
  }
}; 