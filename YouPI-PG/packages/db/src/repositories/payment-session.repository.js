import crypto from 'node:crypto';
import { PaymentStatus, PaymentMethod, isValidTransition, TERMINAL_STATES } from '@youpi/common';

function makeThenable(data, persistencePromise) {
  if (!persistencePromise || typeof persistencePromise.then !== 'function') {
    return data;
  }
  const p = persistencePromise.then(() => data);
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      p[k] = v;
    }
  }
  return p;
}

export class PaymentSessionRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  _syncMemoryRow(table, rowData) {
    if (!rowData) return;
    const clean = { ...rowData };
    if (clean._doc) Object.assign(clean, clean._doc);
    delete clean._id;
    delete clean.__v;
    const id = clean.id || clean.sessionId;
    if (id) {
      this.db.getTable(table).set(String(id), clean);
    }
  }

  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date();
    const nowIso = now.toISOString();
    const metadata = typeof data.metadata === 'object' ? data.metadata : {};
    const metadataStr = JSON.stringify(metadata);
    const attemptId = data.attemptId || id;
    const amountPaise = Number(data.amountPaise);
    const currency = (data.currency || 'INR').toUpperCase();
    const method = data.method || PaymentMethod.UPI;
    const status = data.status || PaymentStatus.INITIATED;
    const queuePosition = data.queuePosition || 0;

    const row = {
      id,
      merchant_id: data.merchantId,
      customer_id: data.customerId || null,
      receiving_account_id: data.receivingAccountId || null,
      order_id: data.orderId,
      attempt_id: attemptId,
      amount_paise: amountPaise,
      currency,
      method,
      status,
      queue_position: queuePosition,
      return_url: data.returnUrl || null,
      idempotency_key: data.idempotencyKey || null,
      device_id: data.deviceId || null,
      verification_level: 0,
      verification_sources: '[]',
      verification_tag: 'UNVERIFIED',
      metadata: metadataStr,
      created_at: nowIso,
      updated_at: nowIso
    };

    // Update in-memory state immediately so sync callers have instant access
    this.db.getTable('payment_sessions').set(String(id), { ...row });
    const mapped = this.findById(id);

    const Model = this.db.models?.PaymentSession;
    let persistencePromise = Promise.resolve();

    if (Model && typeof Model.create === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      persistencePromise = Model.create(row)
        .then((doc) => {
          this._syncMemoryRow('payment_sessions', doc ? doc.toObject() : row);
          return mapped;
        })
        .catch((err) => {
          if (err.code === 11000) {
            const existing = this.findByOrderId(data.merchantId, data.orderId);
            if (existing) {
              const existingCurrency = (existing.currency || 'INR').toUpperCase();
              if (Number(existing.amountPaise) !== amountPaise || existingCurrency !== currency) {
                const conflictErr = new Error(`Order ${data.orderId} already exists with a different amount or currency.`);
                conflictErr.code = 'ORDER_AMOUNT_MISMATCH';
                conflictErr.statusCode = 409;
                throw conflictErr;
              }
              return existing;
            }
          }
          throw err;
        });
      this.db.trackWrite(persistencePromise);
    }

    return makeThenable(mapped, persistencePromise);
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM payment_sessions WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByIdAsync(id) {
    const Model = this.db.models?.PaymentSession;
    if (Model && typeof Model.findOne === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      const doc = await Model.findOne({ id });
      if (doc) {
        this._syncMemoryRow('payment_sessions', doc);
        return this.mapRow(doc);
      }
    }
    return this.findById(id);
  }

  findByOrderId(merchantId, orderId) {
    const row = this.db.queryOne(
      'SELECT * FROM payment_sessions WHERE merchant_id = ? AND order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      [merchantId, orderId]
    );
    if (!row) return null;
    return this.mapRow(row);
  }

  findByCustomerId(customerId) {
    const rows = this.db.query(
      'SELECT * FROM payment_sessions WHERE customer_id = ? ORDER BY created_at DESC',
      [customerId]
    );
    return rows.map(r => this.mapRow(r));
  }

  findByMerchantId(merchantId, limit = 50) {
    const rows = this.db.query(
      'SELECT * FROM payment_sessions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?',
      [merchantId, limit]
    );
    return rows.map(r => this.mapRow(r));
  }

  acquireSlotAtomic(sessionId, receivingAccountId, durationMs = 300000) {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + durationMs);
    const expiresAtIso = expiresAt.toISOString();

    const SessionModel = this.db.models?.PaymentSession;
    const AccountModel = this.db.models?.PaymentReceivingAccount;

    // Check for currently active/processing session on this receiving account
    let activeRow = this.findCurrentActiveOrProcessing(receivingAccountId);

    if (activeRow) {
      const isStale = (activeRow.status === PaymentStatus.ACTIVE && activeRow.expiresAt && activeRow.expiresAt <= now) ||
        (activeRow.status === PaymentStatus.PROCESSING && activeRow.processingExpiresAt && activeRow.processingExpiresAt <= now);

      if (isStale) {
        const terminalStatus = activeRow.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
        this.transitionToTerminal(activeRow.id, terminalStatus);
        activeRow = null;
      }
    }

    // If activeRow is THIS session itself, it's ALREADY ACTIVE
    if (activeRow && activeRow.id === sessionId) {
      const res = {
        status: PaymentStatus.ACTIVE,
        queuePosition: 0,
        expiresAt: activeRow.expiresAt || expiresAt
      };
      return makeThenable(res, Promise.resolve(res));
    }

    if (!activeRow) {
      const current = this.findById(sessionId);
      if (current && !isValidTransition(current.status, PaymentStatus.ACTIVE)) {
        throw new Error(`Illegal payment state transition: cannot move from '${current.status}' to 'ACTIVE'.`);
      }

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?, slot_acquired_at = ?, expires_at = ?, queue_position = 0, updated_at = ?
        WHERE id = ?
      `, [PaymentStatus.ACTIVE, nowIso, expiresAtIso, nowIso, sessionId]);

      this.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_slot_busy = 1, current_active_session_id = ?, updated_at = ?
        WHERE id = ?
      `, [sessionId, nowIso, receivingAccountId]);

      let persistencePromise = Promise.resolve();
      if (SessionModel && typeof SessionModel.findOneAndUpdate === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
        persistencePromise = SessionModel.findOneAndUpdate(
          { id: sessionId, status: { $in: [PaymentStatus.INITIATED, PaymentStatus.QUEUED, PaymentStatus.ACTIVE] } },
          {
            $set: {
              receiving_account_id: receivingAccountId,
              status: PaymentStatus.ACTIVE,
              slot_acquired_at: nowIso,
              expires_at: expiresAtIso,
              queue_position: 0,
              updated_at: nowIso
            }
          },
          { returnDocument: 'after' }
        ).then((updatedDoc) => {
          if (updatedDoc) this._syncMemoryRow('payment_sessions', updatedDoc);
          if (AccountModel && typeof AccountModel.updateOne === 'function') {
            return AccountModel.updateOne(
              { id: receivingAccountId },
              { $set: { is_slot_busy: 1, current_active_session_id: sessionId, updated_at: nowIso } }
            );
          }
        });
        this.db.trackWrite(persistencePromise);
      }

      const res = {
        status: PaymentStatus.ACTIVE,
        queuePosition: 0,
        expiresAt
      };
      return makeThenable(res, persistencePromise);
    }

    // Slot is busy: place into QUEUED
    const existingSession = this.findById(sessionId);
    let queuePosition = existingSession?.queuePosition;
    if (!queuePosition || queuePosition <= 0) {
      const queuedRows = this.findQueuedSessions(receivingAccountId);
      const maxPos = queuedRows.reduce((max, s) => Math.max(max, s.queuePosition || 0), 0);
      queuePosition = maxPos + 1;
    }

    if (existingSession && !isValidTransition(existingSession.status, PaymentStatus.QUEUED)) {
      throw new Error(`Illegal payment state transition: cannot move from '${existingSession.status}' to 'QUEUED'.`);
    }

    this.db.execute(`
      UPDATE payment_sessions
      SET status = ?, queue_position = ?, updated_at = ?
      WHERE id = ?
    `, [PaymentStatus.QUEUED, queuePosition, nowIso, sessionId]);

    let queuedPromise = Promise.resolve();
    if (SessionModel && typeof SessionModel.findOneAndUpdate === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      queuedPromise = SessionModel.findOneAndUpdate(
        { id: sessionId },
        {
          $set: {
            receiving_account_id: receivingAccountId,
            status: PaymentStatus.QUEUED,
            queue_position: queuePosition,
            updated_at: nowIso
          }
        },
        { returnDocument: 'after' }
      ).then((doc) => {
        if (doc) this._syncMemoryRow('payment_sessions', doc);
      });
      this.db.trackWrite(queuedPromise);
    }

    const res = {
      status: PaymentStatus.QUEUED,
      queuePosition,
      expiresAt: null
    };
    return makeThenable(res, queuedPromise);
  }

  transitionToProcessing(sessionId, durationMs = 30000) {
    const session = this.findById(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    if (session.status === PaymentStatus.PROCESSING) {
      return makeThenable(session, Promise.resolve(session));
    }

    if (session.status !== PaymentStatus.ACTIVE) {
      throw new Error(`Cannot transition to PROCESSING from status: ${session.status}`);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const processingExpiresAt = new Date(now.getTime() + durationMs);
    const procExpiresAtIso = processingExpiresAt.toISOString();

    this.db.execute(`
      UPDATE payment_sessions
      SET status = ?, processing_started_at = ?, processing_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `, [PaymentStatus.PROCESSING, nowIso, procExpiresAtIso, nowIso, sessionId, PaymentStatus.ACTIVE]);

    const updated = this.findById(sessionId);

    const SessionModel = this.db.models?.PaymentSession;
    let persistencePromise = Promise.resolve();

    if (SessionModel && typeof SessionModel.findOneAndUpdate === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      persistencePromise = SessionModel.findOneAndUpdate(
        { id: sessionId, status: PaymentStatus.ACTIVE },
        {
          $set: {
            status: PaymentStatus.PROCESSING,
            processing_started_at: nowIso,
            processing_expires_at: procExpiresAtIso,
            updated_at: nowIso
          }
        },
        { returnDocument: 'after' }
      ).then((doc) => {
        if (doc) this._syncMemoryRow('payment_sessions', doc);
        return updated;
      });
      this.db.trackWrite(persistencePromise);
    }

    return makeThenable(updated, persistencePromise);
  }

  transitionToTerminal(sessionId, targetStatus, options = {}) {
    const session = this.findById(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    if (TERMINAL_STATES.includes(session.status)) {
      if (session.status === targetStatus) {
        return makeThenable(session, Promise.resolve(session));
      }
      throw new Error(`Conflict: session ${sessionId} is already terminal '${session.status}' and cannot transition to '${targetStatus}'.`);
    }

    if (!TERMINAL_STATES.includes(targetStatus)) {
      throw new Error(`Not a terminal target status: ${targetStatus}`);
    }
    if (!isValidTransition(session.status, targetStatus)) {
      throw new Error(`Illegal payment state transition: cannot move from '${session.status}' to '${targetStatus}'.`);
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const attributedObsId = options.attributedObservationId || session.attributedObservationId || null;

    let metadata = session.metadata || {};
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
    }
    if (options.reason) metadata.cancelledReason = options.reason;
    if (options.replacedByDeviceId) metadata.replacedByDeviceId = options.replacedByDeviceId;
    if (options.replacedBySessionId) metadata.replacedBySessionId = options.replacedBySessionId;

    const metadataStr = JSON.stringify(metadata);

    this.db.execute(`
      UPDATE payment_sessions
      SET status = ?, completed_at = ?, attributed_observation_id = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `, [targetStatus, nowIso, attributedObsId, metadataStr, nowIso, sessionId]);

    if (session.receivingAccountId) {
      this.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
        WHERE id = ?
      `, [nowIso, session.receivingAccountId]);
    }

    const updated = this.findById(sessionId);

    const SessionModel = this.db.models?.PaymentSession;
    const AccountModel = this.db.models?.PaymentReceivingAccount;
    let persistencePromise = Promise.resolve();

    if (SessionModel && typeof SessionModel.findOneAndUpdate === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      persistencePromise = SessionModel.findOneAndUpdate(
        { id: sessionId, status: session.status },
        {
          $set: {
            status: targetStatus,
            completed_at: nowIso,
            attributed_observation_id: attributedObsId,
            metadata: metadataStr,
            updated_at: nowIso
          }
        },
        { returnDocument: 'after' }
      ).then((doc) => {
        if (doc) this._syncMemoryRow('payment_sessions', doc);
        if (session.receivingAccountId && AccountModel && typeof AccountModel.updateOne === 'function') {
          return AccountModel.updateOne(
            { id: session.receivingAccountId, current_active_session_id: sessionId },
            { $set: { is_slot_busy: 0, current_active_session_id: null, updated_at: nowIso } }
          );
        }
      });
      this.db.trackWrite(persistencePromise);
    }

    return makeThenable(updated, persistencePromise);
  }

  findCurrentActiveOrProcessing(receivingAccountId) {
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status IN (?, ?)
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  async findCurrentActiveOrProcessingAsync(receivingAccountId) {
    const SessionModel = this.db.models?.PaymentSession;
    if (SessionModel && typeof SessionModel.findOne === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      const doc = await SessionModel.findOne({
        receiving_account_id: receivingAccountId,
        status: { $in: [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING] }
      });

      if (!doc) return null;
      const now = new Date();
      const isStale = (doc.status === PaymentStatus.ACTIVE && doc.expires_at && new Date(doc.expires_at) <= now) ||
        (doc.status === PaymentStatus.PROCESSING && doc.processing_expires_at && new Date(doc.processing_expires_at) <= now);

      if (isStale) {
        const terminalStatus = doc.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
        await this.transitionToTerminal(doc.id, terminalStatus);
        return null;
      }
      this._syncMemoryRow('payment_sessions', doc);
      return this.mapRow(doc);
    }
    return this.findCurrentActiveOrProcessing(receivingAccountId);
  }

  findCurrentActiveOrProcessingForMerchant(merchantId) {
    if (!merchantId) return null;
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE merchant_id = ? AND status IN (?, ?)
      ORDER BY created_at DESC
      LIMIT 1
    `, [merchantId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findAllActiveOrPendingForCustomer(customerId) {
    if (!customerId) return [];
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE customer_id = ? AND status IN (?, ?, ?, ?)
      ORDER BY created_at DESC
    `, [customerId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED, PaymentStatus.INITIATED]);
    return rows.map(r => this.mapRow(r));
  }

  findQueuedSessions(receivingAccountId) {
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = ?
      ORDER BY queue_position ASC, created_at ASC
    `, [receivingAccountId, PaymentStatus.QUEUED]);

    return rows.map(r => this.mapRow(r));
  }

  getNextQueuedSession(receivingAccountId) {
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = ?
      ORDER BY queue_position ASC, created_at ASC
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.QUEUED]);

    if (!row) return null;
    return this.mapRow(row);
  }

  reindexQueue(receivingAccountId) {
    const queued = this.findQueuedSessions(receivingAccountId);
    let pos = 1;
    const SessionModel = this.db.models?.PaymentSession;
    const updates = [];

    for (const session of queued) {
      const nowIso = new Date().toISOString();
      const newPos = pos++;
      if (SessionModel && typeof SessionModel.updateOne === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
        updates.push(
          SessionModel.updateOne(
            { id: session.id },
            { $set: { queue_position: newPos, updated_at: nowIso } }
          )
        );
      }
      this.db.execute(`
        UPDATE payment_sessions SET queue_position = ?, updated_at = ?
        WHERE id = ?
      `, [newPos, nowIso, session.id]);
    }

    const persistencePromise = Promise.all(updates);
    this.db.trackWrite(persistencePromise);
    return makeThenable({ count: queued.length }, persistencePromise);
  }

  findRecentlyExpiredOrFailed(receivingAccountId, sinceDate) {
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ?
        AND status IN (?, ?, ?)
        AND updated_at >= ?
      ORDER BY updated_at DESC
      LIMIT 20
    `, [receivingAccountId, PaymentStatus.EXPIRED, PaymentStatus.FAILED, PaymentStatus.CANCELLED, sinceDate.toISOString()]);

    return rows.map(r => this.mapRow(r));
  }

  recordVerificationSource(sessionId, source, observationId, options = {}) {
    const session = this.findById(sessionId);
    if (!session) throw new Error(`Payment session not found: ${sessionId}`);

    const DEAD_STATES = [
      PaymentStatus.FAILED,
      PaymentStatus.EXPIRED,
      PaymentStatus.CANCELLED
    ];
    if (DEAD_STATES.includes(session.status)) {
      const deadRes = {
        session,
        level: session.verificationLevel || 0,
        sources: session.verificationSources || [],
        tag: session.verificationTag || 'UNVERIFIED',
        isFirstSuccess: false
      };
      return makeThenable(deadRes, Promise.resolve(deadRes));
    }

    const sourcesSet = new Set(session.verificationSources || []);
    sourcesSet.add(source);
    const sources = Array.from(sourcesSet);

    const level = Math.min(2, sources.length);
    const sourceLabels = sources.map(s => {
      if (s === 'GOOGLE_MESSAGES') return 'SMS';
      if (s === 'GMAIL') return 'Gmail';
      return s;
    });

    let tag = `Single Verification (${sourceLabels.join(', ')})`;
    if (level >= 2) {
      tag = `Dual Verification (${sourceLabels.join(' + ')})`;
    }

    const shouldFinalize = options.finalizeSuccess !== false;
    const wantsSuccess = shouldFinalize && level >= 1;
    if (wantsSuccess && session.status !== PaymentStatus.SUCCESS && !isValidTransition(session.status, PaymentStatus.SUCCESS)) {
      throw new Error(`Illegal payment state transition: cannot move from '${session.status}' to 'SUCCESS'.`);
    }
    const isFirstSuccess = wantsSuccess && session.status !== PaymentStatus.SUCCESS;
    const targetStatus = wantsSuccess ? PaymentStatus.SUCCESS : session.status;
    const nowIso = new Date().toISOString();

    this.db.execute(`
      UPDATE payment_sessions
      SET status = ?,
          verification_level = ?,
          verification_sources = ?,
          verification_tag = ?,
          attributed_observation_id = COALESCE(attributed_observation_id, ?),
          completed_at = COALESCE(completed_at, ?),
          updated_at = ?
      WHERE id = ?
    `, [
      targetStatus,
      level,
      JSON.stringify(sources),
      tag,
      observationId,
      targetStatus === PaymentStatus.SUCCESS ? nowIso : null,
      nowIso,
      sessionId
    ]);

    if (targetStatus === PaymentStatus.SUCCESS && session.receivingAccountId) {
      this.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
        WHERE id = ? AND current_active_session_id = ?
      `, [nowIso, session.receivingAccountId]);
    }

    const updated = this.findById(sessionId);
    const result = {
      session: updated,
      level,
      sources,
      tag,
      isFirstSuccess
    };

    const SessionModel = this.db.models?.PaymentSession;
    const AccountModel = this.db.models?.PaymentReceivingAccount;
    let persistencePromise = Promise.resolve();

    if (SessionModel && typeof SessionModel.findOneAndUpdate === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      const updatePayload = {
        status: targetStatus,
        verification_level: level,
        verification_sources: JSON.stringify(sources),
        verification_tag: tag,
        updated_at: nowIso
      };
      if (targetStatus === PaymentStatus.SUCCESS) updatePayload.completed_at = nowIso;
      if (observationId) updatePayload.attributed_observation_id = observationId;

      persistencePromise = SessionModel.findOneAndUpdate(
        { id: sessionId },
        { $set: updatePayload },
        { returnDocument: 'after' }
      ).then((doc) => {
        if (doc) this._syncMemoryRow('payment_sessions', doc);
        if (targetStatus === PaymentStatus.SUCCESS && session.receivingAccountId && AccountModel && typeof AccountModel.updateOne === 'function') {
          return AccountModel.updateOne(
            { id: session.receivingAccountId, current_active_session_id: sessionId },
            { $set: { is_slot_busy: 0, current_active_session_id: null, updated_at: nowIso } }
          );
        }
      });
      this.db.trackWrite(persistencePromise);
    }

    return makeThenable(result, persistencePromise);
  }

  bindDevice(sessionId, deviceId) {
    const nowIso = new Date().toISOString();
    this.db.execute(
      'UPDATE payment_sessions SET device_id = ?, updated_at = ? WHERE id = ?',
      [deviceId, nowIso, sessionId]
    );
    const updated = this.findById(sessionId);

    const SessionModel = this.db.models?.PaymentSession;
    let persistencePromise = Promise.resolve();

    if (SessionModel && typeof SessionModel.findOneAndUpdate === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      persistencePromise = SessionModel.findOneAndUpdate(
        { id: sessionId },
        { $set: { device_id: deviceId, updated_at: nowIso } },
        { returnDocument: 'after' }
      ).then((doc) => {
        if (doc) this._syncMemoryRow('payment_sessions', doc);
      });
      this.db.trackWrite(persistencePromise);
    }

    return makeThenable(updated, persistencePromise);
  }

  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      receivingAccountId: row.receiving_account_id,
      orderId: row.order_id,
      attemptId: row.attempt_id || row.id,
      amountPaise: BigInt(row.amount_paise),
      currency: row.currency,
      method: row.method,
      status: row.status,
      queuePosition: row.queue_position,
      slotAcquiredAt: row.slot_acquired_at ? new Date(row.slot_acquired_at) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      processingStartedAt: row.processing_started_at ? new Date(row.processing_started_at) : null,
      processingExpiresAt: row.processing_expires_at ? new Date(row.processing_expires_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      returnUrl: row.return_url,
      attributedObservationId: row.attributed_observation_id,
      idempotencyKey: row.idempotency_key,
      deviceId: row.device_id || null,
      verificationLevel: row.verification_level !== undefined && row.verification_level !== null ? Number(row.verification_level) : 0,
      verificationSources: typeof row.verification_sources === 'string' ? JSON.parse(row.verification_sources || '[]') : (row.verification_sources || []),
      verificationTag: row.verification_tag || 'UNVERIFIED',
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {}),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}
