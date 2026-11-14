import mongoose from 'mongoose';

const WebhookDeliverySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  payment_session_id: { type: String, required: true, index: true },
  merchant_id: { type: String, required: true, index: true },
  url: { type: String, required: true },
  event: { type: String, required: true },
  payload: { type: String, required: true },
  response_status: { type: Number, default: null },
  response_body: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  is_successful: { type: Number, default: 0 },
  next_retry_at: { type: String, default: null },
  created_at: { type: String, default: () => new Date().toISOString() },
  updated_at: { type: String, default: () => new Date().toISOString() }
}, { collection: 'webhook_deliveries', timestamps: false });

export const WebhookDelivery = mongoose.models.WebhookDelivery || mongoose.model('WebhookDelivery', WebhookDeliverySchema);
