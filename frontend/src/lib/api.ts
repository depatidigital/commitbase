import { t } from './i18n';

export const API_BASE_URL = import.meta.env.VITE_API_URL;

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Get auth token from localStorage
const getAuthToken = (): string | null => {
  return localStorage.getItem('authToken');
};

// Set auth token in localStorage
export const setAuthToken = (token: string): void => {
  localStorage.setItem('authToken', token);
};

// Remove auth token from localStorage
export const removeAuthToken = (): void => {
  localStorage.removeItem('authToken');
};

// Base API request function
const apiRequest = async <T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> => {
  const token = getAuthToken();
  
  const config: RequestInit = {
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
    ...options,
  };

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, config);
    // a proxy, a gateway or a limiter can answer in plain text: say what it said, not a JSON parse error
    const text = await response.text();
    let data: ApiResponse<T>;
    try {
      data = text ? JSON.parse(text) : { success: response.ok };
    } catch {
      data = { success: false, error: text.trim().slice(0, 300) || `HTTP ${response.status}` };
    }

    if (!response.ok) {
      // Handle 401 Unauthorized
      if (response.status === 401) {
        removeAuthToken();
        window.location.href = '/login';
      }
      throw new Error(data.error || t('Request failed'));
    }

    return data;
  } catch (error) {
    console.error('API request failed:', error);
    throw error;
  }
};

export default apiRequest;
