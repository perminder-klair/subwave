import type { services } from 'ask-sdk-model';

export const REMINDER_PERMISSION = 'alexa::alerts:reminders:skill:readwrite';
export const REMINDER_LEAD_SECONDS = 60;
export const REMINDER_MIN_ETA_SECONDS = 120;
export const REMINDER_MAX_ETA_SECONDS = 1_800;

export interface AlexaReminderClient {
  create(request: services.reminderManagement.ReminderRequest): Promise<{ alertToken: string }>;
  get(alertToken: string): Promise<services.reminderManagement.ReminderResponse>;
  delete(alertToken: string): Promise<void>;
}

interface ReminderServiceClient {
  createReminder(request: services.reminderManagement.ReminderRequest): Promise<{ alertToken?: string | null }>;
  getReminder(alertToken: string): Promise<services.reminderManagement.ReminderResponse>;
  deleteReminder(alertToken: string): Promise<void>;
}

export interface AlexaReminderServiceInput {
  serviceClientFactory?: {
    getReminderManagementServiceClient?: () => ReminderServiceClient;
  };
}

export function reminderEtaAllowed(seconds: number | null | undefined): boolean {
  return Number.isFinite(seconds)
    && seconds! >= REMINDER_MIN_ETA_SECONDS
    && seconds! <= REMINDER_MAX_ETA_SECONDS;
}

export function reminderOffsetSeconds(etaSeconds: number): number {
  return Math.max(REMINDER_LEAD_SECONDS, Math.round(etaSeconds) - REMINDER_LEAD_SECONDS);
}

/** Build the SDK-backed service client from the current Alexa request. */
export function reminderClientFor(input: AlexaReminderServiceInput): AlexaReminderClient {
  const client = input.serviceClientFactory?.getReminderManagementServiceClient?.();
  if (!client) throw new Error('Alexa reminder service is unavailable');
  return {
    async create(request) {
      const response = await client.createReminder(request);
      const alertToken = String(response?.alertToken || '').trim();
      if (!alertToken) throw new Error('Alexa returned no reminder token');
      return { alertToken };
    },
    get: (alertToken: string) => client.getReminder(alertToken),
    delete: (alertToken: string) => client.deleteReminder(alertToken),
  };
}
