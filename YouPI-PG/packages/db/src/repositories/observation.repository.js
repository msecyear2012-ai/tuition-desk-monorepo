import crypto from 'node:crypto';
import { ObservationAttributionStatus } from '@youpi/common';

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

export class ObservationRepository {
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
    const id = clean.id;
    if (id) {
      this.db.getTable(table).set(String(id), clean);
    }
  }

  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date();
    const nowIso = now.toISOString();
    const rawPayloadObj = typeof data.rawPayload === 'object' ? data.rawPayload : {};
    const rawPayload = JSON.stringify(rawPayloadObj);
    const observedAt = data.observedAt instanceof Date ? data.observedAt.toISOString() : (data.observedAt || nowIso);
    const amountPaise = Number(data.amountPaise);
    const attributionStatus = data.attributionStatus || ObservationAttributionStatus.UNATTRIBUTED;

    const row = {
      id,
      receiving_account_id: data.receivingAccountId,
      source: data.source,
      amount_paise: amountPaise,
      observed_at: observedAt,
      ingested_at: nowIso,
      sender_vpa: data.senderVpa || null,
      bank_reference_number: data.bankReferenceNumber || null,
      fingerprint_hash: data.fingerprintHash,
      raw_payload: rawPayload,
      attribution_status: attributionStatus,
      attributed_payment_id: data.attributedPaymentId || null,
      created_at: nowIso
    };

    this.db.getTable('payment_observations').set(String(id), { ...row });
    const mapped = this.findById(id);

    const Model = this.db.models?.PaymentObservation;
    let persistencePromise = Promise.resolve();

    if (Model && typeof Model.create === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      persistencePromise = Model.create(row)
        .then((doc) => {
          this._syncMemoryRow('payment_observations', doc ? doc.toObject() : row);
          return mapped;
        })
        .catch((err) => {
          if (err.code === 11000) {
            const existing = this.findByFingerprint(data.fingerprintHash);
            if (existing) return existing;
          }
          throw err;
        });
      this.db.trackWrite(persistencePromise);
    }

    return makeThenable(mapped, persistencePromise);
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM payment_observations WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  findByFingerprint(fingerprintHash) {
    const row = this.db.queryOne('SELECT * FROM payment_observations WHERE fingerprint_hash = ?', [fingerprintHash]);
    if (!row) return null;
    return this.mapRow(row);
  }

  findUnattributed(receivingAccountId) {
    const rows = this.db.query(`
      SELECT * FROM payment_observations
      WHERE receiving_account_id = ? AND attribution_status = ?
      ORDER BY observed_at ASC
    `, [receivingAccountId, ObservationAttributionStatus.UNATTRIBUTED]);

    return rows.map(r => this.mapRow(r));
  }

  findByReceivingAccount(receivingAccountId, limit = 50) {
    const rows = this.db.query(`
      SELECT * FROM payment_observations
      WHERE receiving_account_id = ?
      ORDER BY observed_at DESC
      LIMIT ?
    `, [receivingAccountId, limit]);

    return rows.map(r => this.mapRow(r));
  }

  markAttributed(id, paymentId) {
    this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?, attributed_payment_id = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.ATTRIBUTED, paymentId, id]);

    const updated = this.findById(id);
    const Model = this.db.models?.PaymentObservation;
    let persistencePromise = Promise.resolve();

    if (Model && typeof Model.updateOne === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      persistencePromise = Model.updateOne(
        { id },
        { $set: { attribution_status: ObservationAttributionStatus.ATTRIBUTED, attributed_payment_id: paymentId } }
      );
      this.db.trackWrite(persistencePromise);
    }

    return makeThenable(updated, persistencePromise);
  }

  markDuplicate(id) {
    this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.DUPLICATE_IGNORED, id]);

    const updated = this.findById(id);
    const Model = this.db.models?.PaymentObservation;
    let persistencePromise = Promise.resolve();

    if (Model && typeof Model.updateOne === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      persistencePromise = Model.updateOne(
        { id },
        { $set: { attribution_status: ObservationAttributionStatus.DUPLICATE_IGNORED } }
      );
      this.db.trackWrite(persistencePromise);
    }

    return makeThenable(updated, persistencePromise);
  }

  markLateUnmatched(id) {
    this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.LATE_UNMATCHED, id]);

    const updated = this.findById(id);
    const Model = this.db.models?.PaymentObservation;
    let persistencePromise = Promise.resolve();

    if (Model && typeof Model.updateOne === 'function' && (!this.db.options?.inMemory || Boolean(this.db.options?.models) || this.db.mongoose?.connection?.readyState === 1)) {
      persistencePromise = Model.updateOne(
        { id },
        { $set: { attribution_status: ObservationAttributionStatus.LATE_UNMATCHED } }
      );
      this.db.trackWrite(persistencePromise);
    }

    return makeThenable(updated, persistencePromise);
  }

  mapRow(row) {
    return {
      id: row.id,
      receivingAccountId: row.receiving_account_id,
      source: row.source,
      amountPaise: BigInt(row.amount_paise),
      observedAt: new Date(row.observed_at),
      ingestedAt: new Date(row.ingested_at),
      senderVpa: row.sender_vpa,
      bankReferenceNumber: row.bank_reference_number,
      fingerprintHash: row.fingerprint_hash,
      rawPayload: typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload || '{}') : (row.raw_payload || {}),
      attributionStatus: row.attribution_status,
      attributedPaymentId: row.attributed_payment_id,
      createdAt: new Date(row.created_at)
    };
  }
}
