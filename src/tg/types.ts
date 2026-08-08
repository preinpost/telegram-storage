/**
 * Minimal Telegram storage surface used by the app.
 *
 * Only `sendDocument` (upload) and `getFile` (download) are needed; everything
 * else (rate limiting, retries, checksums, chunking) lives outside this
 * interface so the real grammY implementation and the token-less mock stay
 * interchangeable.
 */
export interface SendDocumentInput {
  chatId: string;
  fileName: string;
  data: Buffer;
  /** Called as bytes of `data` are handed to the network (0 → data.length). */
  onProgress?: (sentBytes: number) => void;
}

export interface SendDocumentResult {
  /** Telegram message id of the sent document (integrity/tracing). */
  messageId: number;
  /** Telegram file_id of the sent document (download key). */
  fileId: string;
}

export interface TgClient {
  sendDocument(input: SendDocumentInput): Promise<SendDocumentResult>;
  /** Returns the raw bytes of a previously uploaded file_id. */
  getFile(fileId: string): Promise<Buffer>;
  /**
   * Deletes a previously sent message (used to roll back partially uploaded
   * files). Best-effort — callers treat failures as non-fatal.
   */
  deleteMessage(chatId: string, messageId: number): Promise<void>;
}
