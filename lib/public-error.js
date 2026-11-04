import crypto from 'node:crypto';
import { errorReporter } from './error-tracking.js';

export class PublicError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'PublicError';
    this.status = status;
    this.code = code;
    this.diagnosticId = options.diagnosticId || crypto.randomUUID();
    this.category = options.category || code;
  }
}

export function normalizePublicError(error) {
  if (error instanceof PublicError) return error;
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  const code = status === 500 ? 'internal_error' : (error?.code || 'request_rejected');
  const message = status === 500 ? 'The request could not be completed' : (error?.publicMessage || error?.message || 'The request was rejected');
  return new PublicError(status, code, message, { cause: error, category: error?.category || code });
}

export function publicErrorBody(error) {
  const normalized = normalizePublicError(error);
  return {
    error: normalized.message,
    code: normalized.code,
    diagnostic_id: normalized.diagnosticId,
  };
}

export function safeErrorDiagnostic(error, fallbackCategory = 'internal_error') {
  const normalized = error instanceof PublicError
    ? error
    : new PublicError(500, 'internal_error', 'The request could not be completed', {
      cause: error,
      category: fallbackCategory,
    });
  return {
    diagnostic_id: normalized.diagnosticId,
    category: normalized.category || fallbackCategory,
    status: normalized.status,
  };
}

// Logs the safe diagnostic, and sends a server-side failure (5xx) to the
// error tracker when one is configured. context: { org_id, user_id, method,
// route }; see lib/error-tracking.js for what is and is not sent.
export function logSafeError(logger, error, category, context = {}) {
  const diagnostic = safeErrorDiagnostic(error, category);
  const write = logger?.error || logger?.log || console.error;
  write.call(logger || console, 'request failed', diagnostic);
  if (diagnostic.status >= 500) {
    // Report the underlying failure, not the generic wrapper users see.
    const reported = error instanceof PublicError && error.cause ? error.cause : error;
    errorReporter().capture(reported, {
      ...context,
      tags: { category: diagnostic.category, diagnostic_id: diagnostic.diagnostic_id },
    });
  }
  return diagnostic;
}

// The tracker context for an Express request: who (as ids) and which route
// pattern, never the URL itself.
export function requestContext(req) {
  return {
    org_id: req?.user?.org_id,
    user_id: req?.user?.id,
    method: req?.method,
    route: req?.route?.path ? `${req.baseUrl || ''}${req.route.path}` : undefined,
  };
}

export function providerFailure(error, category = 'provider_request_failed') {
  if (error instanceof PublicError && error.category === category) return error;
  return new PublicError(502, 'provider_request_failed', 'The provider request failed', {
    cause: error,
    category,
  });
}
