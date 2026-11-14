import mongoose from 'mongoose';

const CustomerSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: null },
  email: { type: String, default: null, unique: true, sparse: true, index: true },
  mobile_number: { type: String, default: null, unique: true, sparse: true, index: true },
  password_hash: { type: String, default: null },
  otp_code: { type: String, default: null },
  otp_expires_at: { type: String, default: null },
  otp_attempts: { type: Number, default: 0 },
  is_phone_verified: { type: Number, default: 0 },
  status: { type: String, default: 'ACTIVE' },
  ban_reason: { type: String, default: null },
  banned_at: { type: String, default: null },
  unbanned_at: { type: String, default: null },
  last_device: { type: String, default: null },
  created_at: { type: String, default: () => new Date().toISOString() },
  updated_at: { type: String, default: () => new Date().toISOString() }
}, { collection: 'customers', timestamps: false });

export const Customer = mongoose.models.Customer || mongoose.model('Customer', CustomerSchema);
