import mongoose from 'mongoose';

const CustomerSessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  customer_id: { type: String, required: true, index: true },
  token: { type: String, required: true, index: true },
  expires_at: { type: String, required: true },
  is_active: { type: Number, default: 1 },
  created_at: { type: String, default: () => new Date().toISOString() }
}, { collection: 'customer_sessions', timestamps: false });

export const CustomerSession = mongoose.models.CustomerSession || mongoose.model('CustomerSession', CustomerSessionSchema);
