import type { ErrorRequestHandler } from 'express';
import { AppError } from '../../domain/errors.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('errorHandler');

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }

  const message = err instanceof Error ? err.message : 'Bilinmeyen hata';
  log.error({ err }, 'İşlenmeyen hata');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
};
