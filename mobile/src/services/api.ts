import axios from 'axios';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// Public (non-secret) build-time configuration. Only EXPO_PUBLIC_* variables are
// embedded in the app bundle; never put secrets in them. See mobile/.env.example.
const CONFIGURED_API_URL = (process.env.EXPO_PUBLIC_API_URL || '').trim().replace(/\/+$/, '');

const getDefaultBaseUrl = () => {
  if (CONFIGURED_API_URL) {
    return CONFIGURED_API_URL;
  }

  // If running on Web
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location) {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      if (window.location.port !== '5000') {
        return 'http://localhost:5000/api/v1';
      }
    }
    return `${window.location.origin}/api/v1`;
  }

  // Native mobile without EXPO_PUBLIC_API_URL: local development backend
  // (Android emulator reaches the host machine via 10.0.2.2).
  return Platform.OS === 'android' ? 'http://10.0.2.2:5000/api/v1' : 'http://localhost:5000/api/v1';
};

export const API_BASE_URL = getDefaultBaseUrl();

export const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: 12000, // 12-second timeout avoids hanging on weak office/mobile connections
  headers: {
    'Content-Type': 'application/json',
  },
});

let inMemoryAuthToken: string | null = null;

export const setAuthToken = (token: string | null) => {
  inMemoryAuthToken = token;
  if (token) {
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      try {
        if (window.sessionStorage) window.sessionStorage.setItem('chitkart_auth_token', token);
      } catch (e) {}
    } else if (Platform.OS !== 'web') {
      SecureStore.setItemAsync('chitkart_auth_token', token).catch(() => {});
    }
  } else {
    delete api.defaults.headers.common['Authorization'];
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      try {
        if (window.sessionStorage) window.sessionStorage.removeItem('chitkart_auth_token');
        if (window.localStorage) window.localStorage.removeItem('chitkart_auth_token');
      } catch (e) {}
    } else if (Platform.OS !== 'web') {
      SecureStore.deleteItemAsync('chitkart_auth_token').catch(() => {});
    }
  }
};

// Retrieve stored token (in-memory first, then web storage)
export const getStoredAuthToken = (): string | null => {
  if (inMemoryAuthToken) return inMemoryAuthToken;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    try {
      if (window.sessionStorage) {
        const s = window.sessionStorage.getItem('chitkart_auth_token');
        if (s) return s;
      }
      if (window.localStorage) {
        return window.localStorage.getItem('chitkart_auth_token');
      }
    } catch (e) {}
  }
  return null;
};

// Ensure EVERY outgoing request carries the Bearer token
api.interceptors.request.use(
  (config) => {
    const activeToken = inMemoryAuthToken || getStoredAuthToken();
    if (activeToken) {
      if (config.headers && typeof (config.headers as any).set === 'function') {
        (config.headers as any).set('Authorization', `Bearer ${activeToken}`);
      } else if (config.headers) {
        config.headers['Authorization'] = `Bearer ${activeToken}`;
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Immediately restore token upon tab launch or reload
const initialToken = getStoredAuthToken();
if (initialToken) {
  setAuthToken(initialToken);
}

// Global response interceptor: kick out screen if same account was logged into another screen
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && error.response?.data?.code === 'SESSION_TERMINATED') {
      if (Platform.OS === 'web' && typeof window !== 'undefined' && (window as any).__chitkart_session_terminated_handler) {
        (window as any).__chitkart_session_terminated_handler(
          error.response?.data?.message || 'This account was logged in from another screen. You have been logged out.'
        );
      }
    }
    return Promise.reject(error);
  }
);
