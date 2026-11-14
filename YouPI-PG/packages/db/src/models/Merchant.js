import mongoose from 'mongoose';

const MerchantSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, index: true },
  password_hash: { type: String, required: true },
  api_key_hash: { type: String, default: null },
  webhook_url: { type: String, default: null },
  webhook_secret: { type: String, default: null },
  status: { type: String, default: 'ACTIVE' },
  created_at: { type: String, default: () => new Date().toISOString() },
  updated_at: { type: String, default: () => new Date().toISOString() }
}, { collection: 'merchants', timestamps: false });

export const Merchant = mongoose.models.Merchant || mongoose.model('Merchant', MerchantSchema);
