import { z } from 'zod';

// ============ Message Schemas ============
export const MessageSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  sender: z.string(),
  content: z.string(),
  timestamp: z.number(),
  created_at: z.number().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

// ============ Event Schemas ============
export const EventTypeEnum = z.enum(['meeting', 'deadline', 'reminder', 'travel', 'task', 'other']);
export type EventType = z.infer<typeof EventTypeEnum>;

export const EventSchema = z.object({
  id: z.number().optional(),
  message_id: z.string().nullable(),
  event_type: EventTypeEnum,
  title: z.string(),
  description: z.string().nullable(),
  event_time: z.number().nullable(),
  location: z.string().nullable(),
  participants: z.string().nullable(), // JSON array
  keywords: z.string(), // comma-separated
  confidence: z.number().min(0).max(1),
  status: z.enum(['pending', 'completed', 'expired']).default('pending'),
  created_at: z.number().optional(),
});
export type Event = z.infer<typeof EventSchema>;

// ============ Trigger Schemas ============
export const TriggerSchema = z.object({
  id: z.number().optional(),
  event_id: z.number(),
  trigger_type: z.enum(['time', 'url', 'keyword']),
  trigger_value: z.string(),
  is_fired: z.boolean().default(false),
  created_at: z.number().optional(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

// ============ Contact Schemas ============
export const ContactSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  first_seen: z.number(),
  last_seen: z.number(),
  message_count: z.number().default(0),
});
export type Contact = z.infer<typeof ContactSchema>;

// ============ Webhook Schemas ============
export const WhatsAppWebhookSchema = z.object({
  event: z.string(),
  instance: z.string(),
  data: z.object({
    key: z.object({
      remoteJid: z.string(),
      fromMe: z.boolean(),
      id: z.string(),
    }),
    pushName: z.string().optional(),
    message: z.object({
      conversation: z.string().optional(),
      extendedTextMessage: z.object({
        text: z.string(),
      }).optional(),
    }).optional(),
    messageTimestamp: z.union([z.string(), z.number()]),
  }),
});
export type WhatsAppWebhook = z.infer<typeof WhatsAppWebhookSchema>;

// ============ Context Check Schemas ============
export const ContextCheckRequestSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});
export type ContextCheckRequest = z.infer<typeof ContextCheckRequestSchema>;

export const ContextCheckResponseSchema = z.object({
  matched: z.boolean(),
  events: z.array(EventSchema),
  confidence: z.number(),
});
export type ContextCheckResponse = z.infer<typeof ContextCheckResponseSchema>;

// ============ Gemini Extraction Schemas ============
export const GeminiExtractionSchema = z.object({
  events: z.array(z.object({
    type: EventTypeEnum,
    title: z.string(),
    description: z.string().nullable(),
    event_time: z.string().nullable(),
    location: z.string().nullable(),
    participants: z.array(z.string()),
    keywords: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  })),
});
export type GeminiExtraction = z.infer<typeof GeminiExtractionSchema>;

export const GeminiValidationSchema = z.object({
  relevant: z.array(z.number()),
  confidence: z.number().min(0).max(1),
});
export type GeminiValidation = z.infer<typeof GeminiValidationSchema>;

// ============ Config Schema ============
export const ConfigSchema = z.object({
  port: z.number().default(3000),
  geminiApiKey: z.string(),
  geminiModel: z.string().default('gemini-3-flash-preview'),
  geminiApiUrl: z.string().default('https://generativelanguage.googleapis.com/v1beta/openai'),
  dbPath: z.string().default('./data/events.db'),
  evolutionApiUrl: z.string().optional(),
  evolutionApiKey: z.string().optional(),
  evolutionInstanceName: z.string().optional(),
  evolutionPg: z.object({
    host: z.string(),
    port: z.number(),
    database: z.string(),
    user: z.string(),
    password: z.string(),
  }).optional(),
  processOwnMessages: z.boolean().default(true),
  skipGroupMessages: z.boolean().default(false),
  hotWindowDays: z.number().default(90),
});
export type Config = z.infer<typeof ConfigSchema>;

// ============ Helper Functions ============
export function parseConfig(): Config {
  const evolutionPg = process.env.EVOLUTION_PG_HOST ? {
    host: process.env.EVOLUTION_PG_HOST,
    port: parseInt(process.env.EVOLUTION_PG_PORT || '5432'),
    database: process.env.EVOLUTION_PG_DATABASE || 'evolution',
    user: process.env.EVOLUTION_PG_USER || 'postgres',
    password: process.env.EVOLUTION_PG_PASSWORD || 'postgres',
  } : undefined;

  return ConfigSchema.parse({
    port: parseInt(process.env.PORT || '3000'),
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
    geminiApiUrl: process.env.GEMINI_API_URL,
    dbPath: process.env.DATABASE_PATH || './data/events.db',
    evolutionApiUrl: process.env.EVOLUTION_API_URL,
    evolutionApiKey: process.env.EVOLUTION_API_KEY,
    evolutionInstanceName: process.env.EVOLUTION_INSTANCE_NAME,
    evolutionPg,
    processOwnMessages: process.env.PROCESS_OWN_MESSAGES !== 'false',
    skipGroupMessages: process.env.SKIP_GROUP_MESSAGES === 'true',
    hotWindowDays: parseInt(process.env.HOT_WINDOW_DAYS || '90'),
  });
}
