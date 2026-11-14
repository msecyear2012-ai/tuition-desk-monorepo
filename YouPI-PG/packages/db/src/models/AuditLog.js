import mongoose from 'mongoose';

const AuditLogSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  merchant_id: { type: String, default: null, index: true },
  entity_type: { type: String, required: true, index: true },
  entity_id: { type: String, required: true, index: true },
  action: { type: String, required: true },
  actor_type: { type: String, required: true },
  actor_id: { type: String, default: null },
  details: { type: String, default: '{}' },
  ip_address: { type: String, default: null },
  created_at: { type: String, default: () => new Date().toISOString() }
}, { collection: 'audit_logs', timestamps: false });

export const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
