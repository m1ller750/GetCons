/** Minimal subset of the Telegram Bot API types used by GetCons. */

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  /** getMe only: the bot may create and manage other bots (Bot API 9.6, enabled in @BotFather). */
  can_manage_bots?: boolean;
}

/** Bot API 9.6: a bot was created (or its token/owner changed) under the current manager bot. */
export interface TgManagedBotUpdated {
  user: TgUser;
  bot: TgUser;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgFileRef {
  file_id: string;
  file_unique_id?: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  voice?: TgFileRef;
  audio?: TgFileRef;
  video_note?: TgFileRef;
  document?: TgFileRef;
  video?: TgFileRef;
  sticker?: { emoji?: string; file_id: string };
  location?: { latitude: number; longitude: number };
  contact?: { phone_number: string; first_name: string; last_name?: string };
  managed_bot_created?: { bot: TgUser };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  managed_bot?: TgManagedBotUpdated;
}

export interface TgWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections?: number;
  allowed_updates?: string[];
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TgBotCommand {
  command: string;
  description: string;
}
