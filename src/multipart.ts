import { Busboy } from '@fastify/busboy';
import type { BusboyFileStream } from '@fastify/busboy';
import { Readable } from 'node:stream';
import { HttpError } from './errors.ts';

export interface MultipartFilePart {
  field: string;
  filename: string;
  mimeType: string;
  stream: BusboyFileStream;
}

export interface MultipartResult {
  /** Resolves with the first file field of the multipart body. */
  part: Promise<MultipartFilePart>;
  /** Resolves once the entire multipart body has been consumed. */
  done: Promise<void>;
}

/**
 * Streaming multipart parser built on busboy.
 *
 * The whole request body is piped through busboy; only the first file field is
 * surfaced. The caller must consume `part.stream` (e.g. spool it to disk) so
 * backpressure keeps the pipe flowing — no part of the body is ever buffered
 * in memory, which is what makes >100MB uploads viable.
 */
export function parseFilePart(request: Request): MultipartResult {
  const contentType = request.headers.get('content-type');
  if (!contentType || !contentType.startsWith('multipart/form-data')) {
    throw new HttpError(400, 'expected multipart/form-data request body');
  }
  if (!request.body) {
    throw new HttpError(400, 'request body is empty');
  }

  const bb = Busboy({ headers: { 'content-type': contentType } });
  const nodeBody = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream<Uint8Array>);

  let resolvePart!: (part: MultipartFilePart) => void;
  let rejectPart!: (err: unknown) => void;
  const partPromise = new Promise<MultipartFilePart>((resolve, reject) => {
    resolvePart = resolve;
    rejectPart = reject;
  });

  let resolveDone!: () => void;
  let rejectDone!: (err: unknown) => void;
  const donePromise = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  let partSettled = false;

  bb.on('file', (field, stream, filename, _transferEncoding, mimeType) => {
    if (partSettled) {
      stream.resume(); // discard any additional file fields
      return;
    }
    partSettled = true;
    resolvePart({ field, filename, mimeType, stream });
  });
  bb.on('error', (err) => {
    if (!partSettled) rejectPart(err);
    rejectDone(err);
  });
  bb.on('finish', () => {
    resolveDone();
    if (!partSettled) rejectPart(new HttpError(400, 'multipart body did not include a file field'));
  });
  bb.on('close', () => {
    resolveDone();
    if (!partSettled) rejectPart(new HttpError(400, 'multipart body did not include a file field'));
  });
  nodeBody.on('error', (err) => {
    if (!partSettled) rejectPart(err);
    rejectDone(err);
  });

  nodeBody.pipe(bb);

  return { part: partPromise, done: donePromise };
}
