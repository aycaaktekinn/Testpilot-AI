import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from '../../domain/errors.js';

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      next(new ValidationError(`Geçersiz istek: ${details}`));
      return;
    }
    req.body = result.data;
    next();
  };
}
