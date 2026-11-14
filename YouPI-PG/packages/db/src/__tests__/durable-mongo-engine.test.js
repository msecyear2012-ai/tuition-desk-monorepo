import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database, PaymentSessionRepository, ObservationRepository } from '../index.js';
import { PaymentStatus, ObserverSource } from '@youpi/common';

/**
 * Isolated Unit & Invariant Test Suite for YouPI-PG Batch 1:
 * - Awaited MongoDB Persistence
 * - Atomic Conditional Transitions & Conflict Detection
 * - Concurrent Slot Claims & Code 11000 Invariant Guards
 * - Fail-Closed Startup & Hydration Error Handling
 * - Graceful Shutdown Flush of Pending Writes
 */
describe('Batch 1: Durable MongoDB Engine & Awaited Persistence Tests', () => {
  // In-memory mock Mongoose collections for pure dependency injection (no live DB connections)
  class MockMongoCollection {
    constructor(name, uniqueIndexes = []) {
      this.name = name;
      this.uniqueIndexes = uniqueIndexes;
      this.docs = new Map();
      this.writeDelayMs = 5;
      this.shouldFailNextWrite = false;
    }

    async find(filter = {}) {
      const res = [];
      for (const doc of this.docs.values()) {
        let matches = true;
        for (const [k, v] of Object.entries(filter)) {
          if (doc[k] !== v) { matches = false; break; }
        }
        if (matches) res.push({ ...doc });
      }
      return {
        lean: () => ({
          exec: async () => res
        })
      };
    }

    async findOne(filter = {}) {
      if (this.writeDelayMs > 0) await new Promise(r => setTimeout(r, this.writeDelayMs));
      for (const doc of this.docs.values()) {
        let matches = true;
        for (const [k, v] of Object.entries(filter)) {
          if (v && typeof v === 'object' && v.$in) {
            if (!v.$in.includes(doc[k])) { matches = false; break; }
          } else if (doc[k] !== v) {
            matches = false; break;
          }
        }
        if (matches) {
          return {
            ...doc,
            lean: () => ({ exec: async () => ({ ...doc }) })
          };
        }
      }
      return null;
    }

    async create(doc) {
      if (this.shouldFailNextWrite) {
        this.shouldFailNextWrite = false;
        throw new Error('MOCK_MONGO_WRITE_FAILURE: ETIMEDOUT network failure');
      }
      if (this.writeDelayMs > 0) await new Promise(r => setTimeout(r, this.writeDelayMs));

      // Check unique index constraints
      for (const idx of this.uniqueIndexes) {
        if (idx.partialFilterExpression) {
          const p = idx.partialFilterExpression;
          let inPartial = true;
          for (const [pk, pv] of Object.entries(p)) {
            if (pv && pv.$in && !pv.$in.includes(doc[pk])) inPartial = false;
          }
          if (!inPartial) continue;
        }

        for (const existing of this.docs.values()) {
          let conflict = true;
          for (const k of Object.keys(idx.fields)) {
            if (existing[k] !== doc[k] || doc[k] === null || doc[k] === undefined) {
              conflict = false;
              break;
            }
          }
          if (conflict) {
            const err = new Error('E11000 duplicate key error collection: ' + this.name);
            err.code = 11000;
            throw err;
          }
        }
      }

      const copy = { ...doc };
      this.docs.set(copy.id, copy);
      return {
        ...copy,
        toObject: () => ({ ...copy })
      };
    }

    async findOneAndUpdate(filter, update, options = {}) {
      if (this.shouldFailNextWrite) {
        this.shouldFailNextWrite = false;
        throw new Error('MOCK_MONGO_WRITE_FAILURE: ReplicaSet write concern unacknowledged');
      }
      if (this.writeDelayMs > 0) await new Promise(r => setTimeout(r, this.writeDelayMs));

      let matched = null;
      for (const doc of this.docs.values()) {
        let matches = true;
        for (const [k, v] of Object.entries(filter)) {
          if (v && typeof v === 'object' && v.$in) {
            if (!v.$in.includes(doc[k])) { matches = false; break; }
          } else if (doc[k] !== v) {
            matches = false; break;
          }
        }
        if (matches) { matched = doc; break; }
      }

      if (!matched && !options.upsert) {
        return null;
      }

      if (!matched && options.upsert) {
        matched = { ...filter, ...update.$set };
        this.docs.set(matched.id, matched);
        return { ...matched };
      }

      const updated = { ...matched, ...(update.$set || {}) };

      // Check unique partial index on slot acquisition
      for (const idx of this.uniqueIndexes) {
        if (idx.partialFilterExpression) {
          const p = idx.partialFilterExpression;
          let inPartial = true;
          for (const [pk, pv] of Object.entries(p)) {
            if (pv && pv.$in && !pv.$in.includes(updated[pk])) inPartial = false;
          }
          if (!inPartial) continue;
        }

        for (const existing of this.docs.values()) {
          if (existing.id === updated.id) continue;
          let conflict = true;
          for (const k of Object.keys(idx.fields)) {
            if (existing[k] !== updated[k] || updated[k] === null || updated[k] === undefined) {
              conflict = false;
              break;
            }
          }
          if (conflict) {
            const err = new Error('E11000 duplicate key error index on slot allocation');
            err.code = 11000;
            throw err;
          }
        }
      }

      this.docs.set(updated.id, updated);
      return { ...updated };
    }

    async updateOne(filter, update) {
      if (this.writeDelayMs > 0) await new Promise(r => setTimeout(r, this.writeDelayMs));
      for (const doc of this.docs.values()) {
        let matches = true;
        for (const [k, v] of Object.entries(filter)) {
          if (doc[k] !== v) { matches = false; break; }
        }
        if (matches) {
          Object.assign(doc, update.$set || {});
          return { acknowledged: true, modifiedCount: 1 };
        }
      }
      return { acknowledged: true, modifiedCount: 0 };
    }
  }

  let mockModels;
  let db;
  let sessionRepo;
  let obsRepo;

  beforeEach(() => {
    mockModels = {
      PaymentSession: new MockMongoCollection('payment_sessions', [
        { fields: { receiving_account_id: 1 }, partialFilterExpression: { status: { $in: ['ACTIVE', 'PROCESSING'] } } },
        { fields: { merchant_id: 1, order_id: 1 } }
      ]),
      PaymentObservation: new MockMongoCollection('payment_observations', [
        { fields: { fingerprint_hash: 1 } }
      ]),
      PaymentReceivingAccount: new MockMongoCollection('payment_receiving_accounts')
    };

    db = new Database({
      inMemory: true,
      models: mockModels,
      autoConnect: false
    });

    sessionRepo = new PaymentSessionRepository(db);
    obsRepo = new ObservationRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  // TEST 1: Acknowledged Writes
  test('Awaited writes ensure MongoDB acknowledgment before resolving', async () => {
    console.log('START TEST: Awaited writes ensure MongoDB acknowledgment before resolving');
    let writeAcknowledged = false;
    mockModels.PaymentSession.writeDelayMs = 30;

    const sessionPromise = sessionRepo.create({
      merchantId: 'merchant_001',
      receivingAccountId: 'account_001',
      orderId: 'ORDER_ACK_1',
      amountPaise: 150000n,
      currency: 'INR'
    });

    // Before await: ensure persistence is genuinely asynchronous
    sessionPromise.then(() => {
      writeAcknowledged = true;
    });
    assert.equal(writeAcknowledged, false);

    const session = await sessionPromise;
    assert.equal(writeAcknowledged, true);
    assert.equal(session.orderId, 'ORDER_ACK_1');
    assert.equal(mockModels.PaymentSession.docs.has(session.id), true);

    // Verify terminal transition is also awaited
    const termPromise = sessionRepo.transitionToTerminal(session.id, PaymentStatus.SUCCESS);
    const updated = await termPromise;
    assert.equal(updated.status, PaymentStatus.SUCCESS);
    assert.equal(mockModels.PaymentSession.docs.get(session.id).status, PaymentStatus.SUCCESS);
  });

  // TEST 2: Write Failures
  test('Write failures throw and do not falsely report successful persistence', async () => {
    console.log('START TEST: Write failures throw and do not falsely report successful persistence');
    mockModels.PaymentSession.shouldFailNextWrite = true;

    await assert.rejects(
      async () => {
        await sessionRepo.create({
          merchantId: 'merchant_001',
          receivingAccountId: 'account_001',
          orderId: 'ORDER_FAIL_1',
          amountPaise: 50000n
        });
      },
      /MOCK_MONGO_WRITE_FAILURE/
    );

    // Verify document was NOT stored in Mongo collection
    let foundInMongo = false;
    for (const doc of mockModels.PaymentSession.docs.values()) {
      if (doc.order_id === 'ORDER_FAIL_1') foundInMongo = true;
    }
    assert.equal(foundInMongo, false);
  });

  // TEST 3: Concurrent Slot Claims & Code 11000 Protection
  test('Concurrent slot claims on the same receiving account enforce ONE active slot; second is safely queued', async () => {
    console.log('START TEST: Concurrent slot claims on the same receiving account enforce ONE active slot; second is safely queued');
    const s1 = await sessionRepo.create({
      merchantId: 'm1',
      receivingAccountId: 'shared_acc_1',
      orderId: 'ORD_CONCUR_1',
      amountPaise: 10000n
    });

    const s2 = await sessionRepo.create({
      merchantId: 'm1',
      receivingAccountId: 'shared_acc_1',
      orderId: 'ORD_CONCUR_2',
      amountPaise: 10000n
    });

    // Simulate concurrent slot claims
    const [res1, res2] = await Promise.all([
      sessionRepo.acquireSlotAtomic(s1.id, 'shared_acc_1', 300000),
      sessionRepo.acquireSlotAtomic(s2.id, 'shared_acc_1', 300000)
    ]);

    const activeResults = [res1, res2].filter(r => r.status === PaymentStatus.ACTIVE);
    const queuedResults = [res1, res2].filter(r => r.status === PaymentStatus.QUEUED);

    assert.equal(activeResults.length, 1, 'Exactly ONE session must acquire ACTIVE slot');
    assert.equal(queuedResults.length, 1, 'The competing session must be placed in QUEUED');
    assert.equal(queuedResults[0].queuePosition, 1);
  });

  // TEST 4: Conflicting Terminal Transitions
  test('Conflicting terminal transitions are rejected: SUCCESS cannot turn to FAILED and vice-versa', async () => {
    console.log('START TEST: Conflicting terminal transitions are rejected: SUCCESS cannot turn to FAILED and vice-versa');
    const session = await sessionRepo.create({
      merchantId: 'm1',
      receivingAccountId: 'acc_term_1',
      orderId: 'ORD_TERM_CONFLICT',
      amountPaise: 20000n
    });

    await sessionRepo.acquireSlotAtomic(session.id, 'acc_term_1');
    await sessionRepo.transitionToProcessing(session.id);
    await sessionRepo.transitionToTerminal(session.id, PaymentStatus.SUCCESS);

    // Attempting to flip SUCCESS -> FAILED must reject with conflict error
    await assert.rejects(
      async () => {
        await sessionRepo.transitionToTerminal(session.id, PaymentStatus.FAILED);
      },
      /Conflict: session .* is already terminal 'SUCCESS' and cannot transition to 'FAILED'/
    );

    // Verify session remains SUCCESS in durable store
    const current = await sessionRepo.findByIdAsync(session.id);
    assert.equal(current.status, PaymentStatus.SUCCESS);
  });

  // TEST 5: Idempotent Retries
  test('Idempotent retries return existing record without duplicate error or state change', async () => {
    console.log('START TEST: Idempotent retries return existing record without duplicate error or state change');
    const initial = await sessionRepo.create({
      merchantId: 'm_idem',
      receivingAccountId: 'acc_idem',
      orderId: 'ORD_IDEMPOTENT_1',
      amountPaise: 45000n,
      currency: 'INR'
    });

    await sessionRepo.acquireSlotAtomic(initial.id, 'acc_idem');
    await sessionRepo.transitionToProcessing(initial.id);
    await sessionRepo.transitionToTerminal(initial.id, PaymentStatus.SUCCESS);

    // 1. Terminal transition retry with SAME status returns idempotently
    const termRetry = await sessionRepo.transitionToTerminal(initial.id, PaymentStatus.SUCCESS);
    assert.equal(termRetry.id, initial.id);
    assert.equal(termRetry.status, PaymentStatus.SUCCESS);

    // 2. Session creation retry with identical order and amount returns existing session
    const createRetry = await sessionRepo.create({
      merchantId: 'm_idem',
      receivingAccountId: 'acc_idem',
      orderId: 'ORD_IDEMPOTENT_1',
      amountPaise: 45000n,
      currency: 'INR'
    });
    assert.equal(createRetry.id, initial.id);
    assert.equal(createRetry.status, PaymentStatus.SUCCESS);

    // 3. Mismatched amount throws 409 ORDER_AMOUNT_MISMATCH
    await assert.rejects(
      async () => {
        await sessionRepo.create({
          merchantId: 'm_idem',
          receivingAccountId: 'acc_idem',
          orderId: 'ORD_IDEMPOTENT_1',
          amountPaise: 99999n, // DIFFERENT AMOUNT
          currency: 'INR'
        });
      },
      (err) => err.code === 'ORDER_AMOUNT_MISMATCH'
    );
  });

  // TEST 6: Startup & Hydration Failures
  test('Database fails closed if connection or hydration fails during startup', async () => {
    console.log('START TEST: Database fails closed if connection or hydration fails during startup');
    const brokenDb = new Database({
      models: mockModels,
      mockInitError: 'ECONNREFUSED cluster offline',
      autoConnect: false
    });

    await assert.rejects(
      async () => {
        await brokenDb.init();
      },
      /FATAL: MongoDB connection failed: ECONNREFUSED cluster offline/
    );
  });

  // TEST 7: Shutdown Flush of Pending Writes
  test('flush() drains all in-flight pending writes before closing database', async () => {
    console.log('START TEST: flush() drains all in-flight pending writes before closing database');
    mockModels.PaymentSession.writeDelayMs = 40;

    // Trigger an asynchronous write through trackWrite
    let writeSettled = false;
    const writePromise = mockModels.PaymentSession.create({
      id: 'flush_test_id',
      merchant_id: 'm_flush',
      order_id: 'ORD_FLUSH',
      amount_paise: 1000
    }).then(() => {
      writeSettled = true;
    });

    db.trackWrite(writePromise);
    assert.equal(writeSettled, false);
    assert.equal(db.pendingWrites.size, 1);

    // flush() must await until all pending writes resolve
    await db.flush();
    assert.equal(writeSettled, true);
    assert.equal(db.pendingWrites.size, 0);
  });
});
