import mongoose from 'mongoose';

const PaymentSessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  merchant_id: { type: String, required: true, index: true },
  customer_id: { type: String, default: null, index: true },
  receiving_account_id: { type: String, default: null, index: true },
  order_id: { type: String, required: true, index: true },
  attempt_id: { type: String, default: null },
  amount_paise: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  method: { type: String, default: 'UPI' },
  status: { type: String, default: 'INITIATED', index: true },
  queue_position: { type: Number, default: 0 },
  slot_acquired_at: { type: String, default: null },
  expires_at: { type: String, default: null },
  processing_started_at: { type: String, default: null },
  processing_expires_at: { type: String, default: null },
  completed_at: { type: String, default: null },
  return_url: { type: String, default: null },
  attributed_observation_id: { type: String, default: null },
  idempotency_key: { type: String, default: null },
  device_id: { type: String, default: null },
  verification_level: { type: Number, default: 0 },
  verification_sources: { type: String, default: '[]' },
  verification_tag: { type: String, default: 'UNVERIFIED' },
  metadata: { type: String, default: '{}' },
  created_at: { type: String, default: () => new Date().toISOString() },
  updated_at: { type: String, default: () => new Date().toISOString() }
}, { collection: 'payment_sessions', timestamps: false });


PaymentSessionSchema.index(
  { receiving_account_id: 1 },
  { 
    unique: true, 
    partialFilterExpression: { 
      status: { $in: ['ACTIVE', 'PROCESSING'] },
      receiving_account_id: { $type: 'string' }
    } 
  }
);

PaymentSessionSchema.index(
  { merchant_id: 1, order_id: 1 },
  { 
    unique: true, 
    partialFilterExpression: { 
      status: { $in: ['INITIATED', 'ACTIVE', 'PROCESSING', 'QUEUED', 'SUCCESS'] } 
    } 
  }
);

PaymentSessionSchema.index(
  { idempotency_key: 1 },
  { 
    unique: true, 
    sparse: true 
  }
);

export const PaymentSession = mongoose.models.PaymentSession || mongoose.model('PaymentSession', PaymentSessionSchema);
