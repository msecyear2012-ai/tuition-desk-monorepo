import mongoose from 'mongoose';

const DeviceSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  customer_id: { type: String, default: null, index: true },
  public_key: { type: String, default: '' },
  fingerprint_hash: { type: String, default: '' },
  user_agent: { type: String, default: null },
  platform: { type: String, default: null },
  browser: { type: String, default: null },
  timezone: { type: String, default: null },
  language: { type: String, default: null },
  screen_signature: { type: String, default: null },
  device_token: { type: String, default: null, unique: true, sparse: true },
  status: { type: String, default: 'ACTIVE' },
  created_at: { type: String, default: () => new Date().toISOString() },
  last_seen_at: { type: String, default: () => new Date().toISOString() }
}, { collection: 'devices', timestamps: false });

export const Device = mongoose.models.Device || mongoose.model('Device', DeviceSchema);
