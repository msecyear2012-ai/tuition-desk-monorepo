import mongoose from 'mongoose';

const PaymentReceivingAccountSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  merchant_id: { type: String, required: true, index: true },
  upi_id: { type: String, required: true },
  display_name: { type: String, required: true },
  is_active: { type: Number, default: 1 },
  is_merchant_enabled: { type: Number, default: 1 },
  daily_limit_paise: { type: Number, default: 10000000 },
  created_at: { type: String, default: () => new Date().toISOString() },
  updated_at: { type: String, default: () => new Date().toISOString() }
}, { collection: 'payment_receiving_accounts', timestamps: false });

export const PaymentReceivingAccount = mongoose.models.PaymentReceivingAccount || mongoose.model('PaymentReceivingAccount', PaymentReceivingAccountSchema);
