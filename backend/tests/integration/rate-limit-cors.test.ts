import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

let app: any;

beforeAll(async () => {
  // Load a fresh copy of the app with rate limiting enabled.
  process.env.RATE_LIMIT_ENABLED = 'true';
  vi.resetModules();
  app = (await import('../../src/app.js')).default;
  process.env.RATE_LIMIT_ENABLED = 'false';
});

describe('rate limiting', () => {
  it('limits forgot-password requests per IP (5 / 15 min)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await request(app).post('/api/v1/auth/forgot-password').send({ emailOrUsername: `nobody${i}` });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('limits login attempts per IP (20 / 15 min)', async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await request(app).post('/api/v1/auth/login').send({ usernameOrPhone: `ghost${i}`, password: 'x' })).status;
    }
    expect(last).toBe(429);
  });
});

describe('CORS', () => {
  it('allows configured origins', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:8081');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8081');
  });

  it('refuses unknown browser origins', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows requests without an Origin header (native app, server-to-server)', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
  });

  it('sets security headers', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
