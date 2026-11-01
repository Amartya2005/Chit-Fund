import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { Platform, AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { api, setAuthToken } from '../services/api';

export interface User {
  id: string;
  username: string;
  fullName: string;
  phone: string;
  email?: string | null;
  role: 'SUPER_ADMIN' | 'MANAGER' | 'COLLECTION_STAFF' | 'MEMBER';
  aadhaarNo?: string | null;
  panNo?: string | null;
  address?: string | null;
  emergencyContact?: string | null;
  dateOfBirth?: string | null;
  company: { id: string; name: string; code: string } | null;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (usernameOrPhone: string, password: string) => Promise<{ success: boolean; message?: string }>;
  logout: (reason?: string) => void;
  refreshUser: () => Promise<void>;
  inactivityMessage: string | null;
  clearInactivityMessage: () => void;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

const getInitialAuth = () => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    // Purge any lingering tokens in localStorage to prevent session bleed to new tabs
    try {
      if (window.localStorage) {
        window.localStorage.removeItem('chitkart_auth_token');
        window.localStorage.removeItem('chitkart_auth_user');
      }
    } catch (e) {}

    try {
      // ONLY check tab-isolated sessionStorage so newly opened tabs always start on the Login screen
      const storedToken = window.sessionStorage ? window.sessionStorage.getItem('chitkart_auth_token') : null;
      const storedUser = window.sessionStorage ? window.sessionStorage.getItem('chitkart_auth_user') : null;

      if (storedToken && storedUser) {
        const parsed = JSON.parse(storedUser);
        if (parsed && parsed.id) {
          setAuthToken(storedToken);
          return { token: storedToken, user: parsed as User };
        }
      }
    } catch (e) {}
  }
  return { token: null, user: null };
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initialAuth = getInitialAuth();
  const [user, setUser] = useState<User | null>(initialAuth.user);
  const [token, setToken] = useState<string | null>(initialAuth.token);
  const [loading, setLoading] = useState<boolean>(false);
  const [inactivityMessage, setInactivityMessage] = useState<string | null>(null);

  const clearInactivityMessage = () => setInactivityMessage(null);

  // Restore auth on Native Mobile devices from SecureStore
  useEffect(() => {
    async function restoreNativeSession() {
      if (Platform.OS !== 'web') {
        try {
          const storedToken = await SecureStore.getItemAsync('chitkart_auth_token');
          const storedUser = await SecureStore.getItemAsync('chitkart_auth_user');
          if (storedToken && storedUser) {
            const parsed = JSON.parse(storedUser);
            if (parsed && parsed.id) {
              setAuthToken(storedToken);
              setToken(storedToken);
              setUser(parsed as User);
            }
          }
        } catch (e) {}
      }
    }
    restoreNativeSession();
  }, []);

  // Connect global session termination handler (triggered when this screen was superseded by a newer login with the same credentials)
  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      (window as any).__chitkart_session_terminated_handler = (msg: string) => {
        logout(msg);
      };
    }
    return () => {
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        delete (window as any).__chitkart_session_terminated_handler;
      }
    };
  }, []);

  // Periodic heartbeat session monitor: verifies that this account has not been logged into from another screen
  // Optimized to 45s and checks AppState to prevent battery drain and network lag at work
  useEffect(() => {
    if (!token || !user) return;
    const checkSession = () => {
      if (Platform.OS !== 'web' && AppState.currentState !== 'active') return;
      api.get('/auth/me').catch((err) => {
        if (err.response?.status === 401 && err.response?.data?.code === 'SESSION_TERMINATED') {
          logout(
            err.response?.data?.message ||
              'This account was logged in on another screen/device. You have been logged out.'
          );
        }
      });
    };

    const interval = setInterval(checkSession, 45000);
    return () => clearInterval(interval);
  }, [token, user?.id]);

  // Background profile sync upon launch without kicking out the user
  useEffect(() => {
    if (token) {
      api.get('/auth/me')
        .then((res) => {
          if (res.data?.success && res.data?.data) {
            setUser(res.data.data);
            if (Platform.OS !== 'web') {
              SecureStore.setItemAsync('chitkart_auth_user', JSON.stringify(res.data.data)).catch(() => {});
            } else if (typeof window !== 'undefined' && window.sessionStorage) {
              try {
                window.sessionStorage.setItem('chitkart_auth_user', JSON.stringify(res.data.data));
              } catch (e) {}
            }
          }
        })
        .catch((err) => {
          if (err.response?.status === 401 && err.response?.data?.code === 'SESSION_TERMINATED') {
            logout(
              err.response?.data?.message ||
                'This account was logged in on another screen/device. You have been logged out.'
            );
          }
        });
    }
  }, []);

  // Login handler
  const login = async (usernameOrPhone: string, password: string) => {
    try {
      setLoading(true);
      setInactivityMessage(null);
      const res = await api.post('/auth/login', { usernameOrPhone, password });
      if (res.data.success) {
        const { accessToken, user: loggedUser } = res.data.data;
        setToken(accessToken);
        setUser(loggedUser);
        setAuthToken(accessToken);

        // Store in SecureStore on mobile, and sessionStorage on web
        if (Platform.OS !== 'web') {
          SecureStore.setItemAsync('chitkart_auth_token', accessToken).catch(() => {});
          SecureStore.setItemAsync('chitkart_auth_user', JSON.stringify(loggedUser)).catch(() => {});
        } else if (typeof window !== 'undefined') {
          try {
            if (window.sessionStorage) {
              window.sessionStorage.setItem('chitkart_auth_token', accessToken);
              window.sessionStorage.setItem('chitkart_auth_user', JSON.stringify(loggedUser));
            }
            if (window.localStorage) {
              window.localStorage.removeItem('chitkart_auth_token');
              window.localStorage.removeItem('chitkart_auth_user');
            }
          } catch (e) {}
        }

        setLoading(false);
        return { success: true };
      }
      setLoading(false);
      return { success: false, message: res.data.message || 'Invalid credentials' };
    } catch (err: any) {
      setLoading(false);
      const msg = !err.response
        ? 'Network Error: Unable to reach server. Please check connection.'
        : err.response?.data?.message || err.message || 'Login failed';
      return { success: false, message: msg };
    }
  };

  const refreshUser = async () => {
    try {
      const res = await api.get('/auth/me');
      if (res.data.success && res.data.data) {
        setUser(res.data.data);
        if (Platform.OS !== 'web') {
          SecureStore.setItemAsync('chitkart_auth_user', JSON.stringify(res.data.data)).catch(() => {});
        } else if (typeof window !== 'undefined' && window.sessionStorage) {
          try {
            window.sessionStorage.setItem('chitkart_auth_user', JSON.stringify(res.data.data));
          } catch (e) {}
        }
      }
    } catch (e) {
      // Ignore background errors
    }
  };

  // Logout handler
  const logout = async (reason?: string) => {
    try {
      await api.post('/auth/logout');
    } catch (e) {
      // Ignore network errors on logout
    }

    if (Platform.OS !== 'web') {
      SecureStore.deleteItemAsync('chitkart_auth_token').catch(() => {});
      SecureStore.deleteItemAsync('chitkart_auth_user').catch(() => {});
    } else if (typeof window !== 'undefined') {
      try {
        if (window.sessionStorage) {
          window.sessionStorage.removeItem('chitkart_auth_token');
          window.sessionStorage.removeItem('chitkart_auth_user');
        }
        if (window.localStorage) {
          window.localStorage.removeItem('chitkart_auth_token');
          window.localStorage.removeItem('chitkart_auth_user');
        }
      } catch (e) {}
    }

    setUser(null);
    setToken(null);
    setAuthToken(null);
    if (reason) {
      setInactivityMessage(reason);
    }
  };

  // 5-Minute Inactivity Auto-Logout (Web only):
  // On web, if there is no mouse movement or interaction for 5 minutes, auto log out.
  // On Native Mobile (Android/iOS), OS handles app lifecycle and native backgrounding.
  useEffect(() => {
    if (!user || Platform.OS !== 'web') return;

    const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    let lastActivityTime = Date.now();
    let timeoutId: any = null;
    let intervalId: any = null;

    const performAutoLogout = () => {
      logout('You were automatically logged out due to 5 minutes of inactivity (no mouse movement).');
    };

    const resetTimer = () => {
      lastActivityTime = Date.now();
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(performAutoLogout, INACTIVITY_TIMEOUT_MS);
    };

    // Start initial 5-minute timer
    resetTimer();

    // Check periodically every 5 seconds (handles background tabs or system sleep)
    intervalId = setInterval(() => {
      if (Date.now() - lastActivityTime >= INACTIVITY_TIMEOUT_MS) {
        performAutoLogout();
      }
    }, 5000);

    // Listen to mouse movement and user interactions on web
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      let lastThrottle = 0;
      const onUserActivity = () => {
        const now = Date.now();
        // Throttle updates to at most once per second for zero CPU overhead
        if (now - lastThrottle >= 1000) {
          lastThrottle = now;
          resetTimer();
        }
      };

      const events = ['mousemove', 'pointermove', 'mousedown', 'keydown', 'scroll', 'click', 'touchstart'];

      events.forEach((evt) => {
        window.addEventListener(evt, onUserActivity, { passive: true });
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener(evt, onUserActivity, { passive: true });
        }
      });

      return () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (intervalId) clearInterval(intervalId);
        events.forEach((evt) => {
          window.removeEventListener(evt, onUserActivity as any);
          if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener(evt, onUserActivity as any);
          }
        });
      };
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, [user?.id]);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, refreshUser, inactivityMessage, clearInactivityMessage }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
