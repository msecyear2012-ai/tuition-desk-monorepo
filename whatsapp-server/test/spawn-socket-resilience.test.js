'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const BaileysProvider = require('../providers/BaileysProvider');

describe('TuitionDesk WhatsApp — Socket Spawn & Reconnection Resilience Suite', () => {
  it('1. _spawnSocket catches DNS/auth-store ENOTFOUND and transitions saved session to reconnecting with backoff', async () => {
    let attempts = 0;
    const provider = new BaileysProvider({
      makeSocketFn: () => ({ ev: new EventEmitter(), ws: new EventEmitter(), end: () => {} }),
      mongooseInstance: { connection: { readyState: 0 } },
    });

    // Mock authStore to throw simulated DNS failure
    provider.authStore.useAuthState = async () => {
      attempts++;
      const err = new Error('getaddrinfo ENOTFOUND ac-bfewcuh-shard-00-00.13svg0o.mongodb.net');
      err.code = 'ENOTFOUND';
      throw err;
    };
    provider.authStore.sessionExists = async () => true;
    provider.savedSessionCenters.add('center-dns-fail');

    await assert.rejects(
      async () => provider._spawnSocket('center-dns-fail'),
      /getaddrinfo ENOTFOUND/
    );

    const sessionObj = provider.sessions.get('center-dns-fail');
    assert.ok(sessionObj, 'Session object must exist in memory');
    assert.strictEqual(sessionObj.status, 'reconnecting', 'Session MUST transition out of initializing to reconnecting');
    assert.strictEqual(sessionObj.sock, null, 'Stalled socket must be cleaned up to null');
    assert.strictEqual(sessionObj.isReady, false, 'isReady must be false');
    assert.strictEqual(sessionObj.reconnectAttempts, 1, 'reconnectAttempts must be incremented to 1');
    assert.ok(sessionObj.reconnectTimer, 'reconnectTimer must be scheduled for auto-retry');

    // getStatus must report reconnecting, not initializing
    const status = await provider.getStatus('center-dns-fail');
    assert.strictEqual(status.status, 'reconnecting', 'getStatus must return reconnecting');
    assert.strictEqual(status.hasClientProcess, false);
    assert.strictEqual(status.hasSavedSession, true);

    await provider.shutdown();
  });

  it('2. _spawnSocket transitions to disconnected when DNS fails for an unlinked center without saved session', async () => {
    const provider = new BaileysProvider({
      makeSocketFn: () => ({ ev: new EventEmitter(), ws: new EventEmitter(), end: () => {} }),
      mongooseInstance: { connection: { readyState: 0 } },
    });

    provider.authStore.useAuthState = async () => {
      throw new Error('Database connection failed');
    };
    provider.authStore.sessionExists = async () => false;

    await assert.rejects(
      async () => provider._spawnSocket('center-unsaved-fail'),
      /Database connection failed/
    );

    const sessionObj = provider.sessions.get('center-unsaved-fail');
    assert.ok(sessionObj);
    assert.strictEqual(sessionObj.status, 'disconnected', 'Unsaved center must transition to disconnected');
    assert.strictEqual(sessionObj.sock, null);
    assert.strictEqual(sessionObj.reconnectTimer, null, 'No retry timer should be scheduled for unsaved session');

    await provider.shutdown();
  });

  it('3. initializeSession overrides a stalled initializing session that has no active socket', async () => {
    let socketSpawned = false;
    const provider = new BaileysProvider({
      makeSocketFn: () => {
        socketSpawned = true;
        const ev = new EventEmitter();
        const ws = new EventEmitter();
        return { ev, ws, end: () => {} };
      },
      mongooseInstance: { connection: { readyState: 0 } },
    });

    provider.authStore.useAuthState = async () => ({
      state: { creds: { registered: true }, keys: {} },
      saveCreds: async () => {},
    });

    // Manually inject a stalled session with sock = null and status = 'initializing'
    provider.sessions.set('center-stalled-override', {
      centerId: 'center-stalled-override',
      sock: null,
      status: 'initializing',
      isReady: false,
      qr: null,
      updatedAt: new Date(Date.now() - 30000).toISOString(), // 30s ago
      reconnectAttempts: 1,
      generation: 1,
    });

    // Calling initializeSession should override the stalled session and spawn a new socket
    const result = await provider.initializeSession('center-stalled-override');
    assert.strictEqual(socketSpawned, true, 'Must spawn new socket and not short-circuit on stalled state');
    assert.strictEqual(result.centerId, 'center-stalled-override');

    await provider.shutdown();
  });

  it('4. Concurrent reconnectSession calls coalesce into the same in-flight promise', async () => {
    let spawnCount = 0;
    const provider = new BaileysProvider({
      makeSocketFn: () => {
        spawnCount++;
        const ev = new EventEmitter();
        const ws = new EventEmitter();
        return { ev, ws, end: () => {} };
      },
      mongooseInstance: { connection: { readyState: 0 } },
    });

    provider.authStore.useAuthState = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        state: { creds: { registered: true }, keys: {} },
        saveCreds: async () => {},
      };
    };

    // Fire two concurrent reconnect requests
    const [res1, res2] = await Promise.all([
      provider.reconnectSession('center-concurrent'),
      provider.reconnectSession('center-concurrent'),
    ]);

    assert.strictEqual(spawnCount, 1, 'Only one socket must be spawned for concurrent reconnects');
    assert.strictEqual(res1.centerId, 'center-concurrent');
    assert.strictEqual(res2.centerId, 'center-concurrent');

    await provider.shutdown();
  });

  it('5. getStatus normalizes stalled initializing sessions (sock = null, elapsed > 15s) to reconnecting', async () => {
    const provider = new BaileysProvider({
      mongooseInstance: { connection: { readyState: 0 } },
    });

    provider.savedSessionCenters.add('center-stalled-status');
    provider.sessions.set('center-stalled-status', {
      centerId: 'center-stalled-status',
      sock: null,
      status: 'initializing',
      isReady: false,
      qr: null,
      updatedAt: new Date(Date.now() - 20000).toISOString(), // 20s ago
      reconnectAttempts: 1,
      generation: 1,
    });

    const status = await provider.getStatus('center-stalled-status');
    assert.strictEqual(status.status, 'reconnecting', 'Must normalize to reconnecting when stalled with sock=null');
    assert.strictEqual(status.hasClientProcess, false);
    assert.strictEqual(status.hasSavedSession, true);

    await provider.shutdown();
  });
});
