import mongoose from 'mongoose';

const PaymentObservationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  merchant_id: { type: String, default: null, index: true },
  receiving_account_id: { type: String, default: null, index: true },
  amount_paise: { type: Number, required: true },
  sender_upi_id: { type: String, default: null },
  utr_number: { type: String, default: null, index: true },
  transaction_note: { type: String, default: null },
  source: { type: String, default: 'SMS' },
  raw_payload: { type: String, default: '{}' },
  observed_at: { type: String, default: () => new Date().toISOString() },
  is_attributed: { type: Number, default: 0 },
  payment_session_id: { type: String, default: null },
  created_at: { type: String, default: () => new Date().toISOString() }
}, { collection: 'payment_observations', timestamps: false });

export const PaymentObservation = mongoose.models.PaymentObservation || mongoose.model('PaymentObservation', PaymentObservationSchema);
