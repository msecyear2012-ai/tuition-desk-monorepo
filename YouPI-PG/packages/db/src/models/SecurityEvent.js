import mongoose from 'mongoose';

const SecurityEventSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  merchant_id: { type: String, default: null },
  customer_id: { type: String, default: null },
  event_type: { type: String, required: true, index: true },
  severity: { type: String, default: 'INFO' },
  details: { type: String, default: '{}' },
  ip_address: { type: String, default: null },
  user_agent: { type: String, default: null },
  created_at: { type: String, default: () => new Date().toISOString() }
}, { collection: 'security_events', timestamps: false });

export const SecurityEvent = mongoose.models.SecurityEvent || mongoose.model('SecurityEvent', SecurityEventSchema);
