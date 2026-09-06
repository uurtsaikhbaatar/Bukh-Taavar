/**
 * Сервертэй холбогдох: fetch (cookie + Bearer), SSE (EventSource) / polling.
 *
 * Хаяг: веб хувилбар серверээсээ өөрөө үйлчлүүлдэг тул ижил origin. Expo dev
 * сервер (8081 порт) дээр байвал API-г 8787 руу чиглүүлнэ.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import type { ApiError as ApiErrorDto, SseMessage } from './shared/api';

export const SERVER_PORT = 8787;
const TOKEN_KEY = 'bukh.session';

export function apiBase(): string {
  if (Platform.OS === 'web' && typeof location !== 'undefined') {
    if (location.port === '8081' || location.port === '19006') return `${location.protocol}//${location.hostname}:${SERVER_PORT}`;
    return '';
  }
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri ? hostUri.split(':')[0] : 'localhost';
  return `http://${host}:${SERVER_PORT}`;
}

let token: string | null = null;

export async function loadToken(): Promise<string | null> {
  try {
    token = await AsyncStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
  return token;
}

export async function saveToken(value: string | null): Promise<void> {
  token = value;
  try {
    if (value) await AsyncStorage.setItem(TOKEN_KEY, value);
    else await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    // хадгалалт боломжгүй бол санах ойд л
  }
}

export function currentToken(): string | null {
  return token;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T = unknown>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(apiBase() + path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'include',
    });
  } catch {
    throw new ApiError(0, 'Сервертэй холбогдож чадсангүй. Интернэтээ шалгана уу.', 'NETWORK');
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = (data ?? {}) as Partial<ApiErrorDto>;
    throw new ApiError(res.status, e.error ?? `Алдаа (${res.status})`, e.code ?? 'ERROR');
  }
  return data as T;
}

/** Хурдан requestId (uuid байвал уuid, үгүй бол санамсаргүй). */
export function newRequestId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Серверийн «өөрчлөгдлөө» мэдэгдлийг сонсоно. Веб дээр SSE, боломжгүй бол
 * 15 сек тутам дуудна. Буцаах функц нь сонсохоо болино.
 */
export function subscribe(onMessage: (m: SseMessage) => void): () => void {
  const ES = (globalThis as { EventSource?: new (url: string, init?: { withCredentials?: boolean }) => EventSourceLike }).EventSource;
  if (ES) {
    const url = `${apiBase()}/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    let es: EventSourceLike | null = null;
    let closed = false;
    const open = () => {
      if (closed) return;
      es = new ES(url, { withCredentials: true });
      es.addEventListener('changed', (ev) => {
        try {
          onMessage(JSON.parse((ev as { data: string }).data) as SseMessage);
        } catch {
          onMessage({ type: 'changed', at: new Date().toISOString() });
        }
      });
      es.onerror = () => {
        // хөтөч өөрөө дахин холбогдоно; хэрэв хаагдсан бол 5 сек дараа шинээр
        if (es && es.readyState === 2) {
          es.close();
          setTimeout(open, 5_000);
        }
      };
    };
    open();
    return () => {
      closed = true;
      es?.close();
    };
  }
  const timer = setInterval(() => onMessage({ type: 'changed', at: new Date().toISOString() }), 15_000);
  return () => clearInterval(timer);
}

interface EventSourceLike {
  readyState: number;
  onerror: ((ev: unknown) => void) | null;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  close(): void;
}
