import apiRequest, { setAuthToken, removeAuthToken } from './api';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'USER';
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
      createdAt: new Date(payload.iat * 1000).toISOString(),
    };
  } catch (error) {
    console.error('Error decoding token:', error);
    removeAuthToken();
    return null;
  }
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