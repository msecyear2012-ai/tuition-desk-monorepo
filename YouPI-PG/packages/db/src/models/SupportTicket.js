import mongoose from 'mongoose';

const SupportTicketSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  merchant_id: { type: String, required: true, index: true },
  customer_id: { type: String, default: null },
  payment_session_id: { type: String, default: null },
  subject: { type: String, required: true },
  status: { type: String, default: 'OPEN' },
  priority: { type: String, default: 'MEDIUM' },
  created_at: { type: String, default: () => new Date().toISOString() },
  updated_at: { type: String, default: () => new Date().toISOString() }
}, { collection: 'support_tickets', timestamps: false });

export const SupportTicket = mongoose.models.SupportTicket || mongoose.model('SupportTicket', SupportTicketSchema);
