import mongoose from 'mongoose';

const WhatsAppSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  phoneNumber: { type: String, default: null },
  status: { type: String, default: 'DISCONNECTED' },
  platform: { type: String, default: 'BerryProtocol' },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  creds: { type: mongoose.Schema.Types.Mixed, default: null },
  files: [{
    fileName: { type: String, required: true },
    content: { type: String, required: true },
    updatedAt: { type: Date, default: Date.now }
  }],
  qrCode: { type: mongoose.Schema.Types.Mixed, default: null },
  pairingCode: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'whatsapp_sessions', timestamps: false });

export const WhatsAppSession = mongoose.models.WhatsAppSession || mongoose.model('WhatsAppSession', WhatsAppSessionSchema);
