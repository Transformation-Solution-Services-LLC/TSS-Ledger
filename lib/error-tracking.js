// Error tracking: unexpected server errors sent to an error tracker.
//
// Off unless ERROR_TRACKING_DSN is set. The DSN is the address a tracker
// gives a project; any tracker that accepts the Sentry envelope format
// works, hosted or self-hosted (Sentry, GlitchTip, Bugsink). No SDK: this
// module decides exactly what leaves the server, and that is deliberately
// little.
//
// What is sent: the error type, a scrubbed message, a stack trace (file,
// function, line), the app name, environment, release, the request method
// and route pattern, the organization id, a one-way hash of the user id, and
// the diagnostic id the user was shown. What is never sent: request or
// response bodies, headers, cookies, query strings, IP addresses, names,
// emails, or source code around the failing line. The message is scrubbed of
// anything shaped like a key, token, password, email address or URL query.
//
// Keep this file identical in TSS-Sherlock, TSS-Watson, TSS-Library, TSS-CRM
// and TSS-Ledger; TSS-Dashboard (Cockpit) and ROOK-E have the same module in
// TypeScript, and tss-circles in its own style.

import crypto from 'node:crypto';

const MAX_PER_MINUTE = 30;
const SEND_TIMEOUT_MS = 5000;

/** Parses a DSN (`https://KEY@HOST/PROJECT`) into where and how to send. */
export function parseDsn(dsn) {
  let url;
  try { url = new URL(String(dsn || '').trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !url.username) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const project = parts.pop();
  if (!project) return null;
  const prefix = parts.length ? `/${parts.join('/')}` : '';
  return {
    key: decodeURIComponent(url.username),
    endpoint: `${url.protocol}//${url.host}${prefix}/api/${encodeURIComponent(project)}/envelope/`,
  };
}

const SECRET_NAMES = 'api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|authorization|cookie|session|ticket|dsn|signature|credential';

/** Removes anything secret- or person-shaped from free text. */
export function scrub(text, max = 1000) {
  return String(text ?? '')
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(new RegExp(`((?:${SECRET_NAMES})["']?\\s*[:=]\\s*["']?)[^\\s"'&,;}]+`, 'gi'), '$1[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abpr]-[\w-]+|AKIA[0-9A-Z]{16})/g, '[redacted]')
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//[redacted]@')
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s"'#]*/g, '$1?[redacted]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
    .slice(0, max);
}

/** A one-way, stable stand-in for an id, so errors can be grouped by person without naming one. */
export function pseudonym(value) {
  return value ? crypto.createHash('sha256').update(`tss-error-tracking|${value}`).digest('hex').slice(0, 16) : undefined;
}

const cwd = process.cwd();

function frameFile(file) {
  let f = String(file).replace(/^file:\/\//, '');
  const nm = f.lastIndexOf('node_modules/');
  if (nm >= 0) return f.slice(nm);
  if (f.startsWith(cwd)) f = f.slice(cwd.length).replace(/^[/\\]/, '');
  return f;
}

/** V8 stack lines to tracker frames, oldest call first. */
export function parseStack(stack) {
  const frames = [];
  for (const line of String(stack || '').split('\n').slice(1, 51)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const filename = frameFile(m[2]);
    frames.push({
      function: m[1] || '<anonymous>',
      filename,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !filename.startsWith('node_modules/') && !filename.startsWith('node:'),
    });
  }
  return frames.reverse();
}

function exceptionOf(error) {
  const values = [];
  let e = error;
  for (let depth = 0; e && depth < 5; depth++) {
    const isError = e instanceof Error;
    values.unshift({
      type: isError ? e.name || 'Error' : typeof e,
      value: scrub(isError ? e.message : e),
      stacktrace: isError && e.stack ? { frames: parseStack(e.stack) } : undefined,
    });
    e = isError ? e.cause : null;
  }
  return { values };
}

/**
 * Creates a reporter. `capture(error, context)` never throws and never
 * waits; `flush()` waits for sends in flight, for use before exiting.
 * context: { level, tags: {k: v}, org_id, user_id, method, route }.
 */
export function createErrorReporter({ dsn, app, environment, release, fetchImpl = globalThis.fetch, maxPerMinute = MAX_PER_MINUTE, logger = console } = {}) {
  const target = dsn ? parseDsn(dsn) : null;
  if (dsn && !target) logger.warn('error tracking: ERROR_TRACKING_DSN is not a valid DSN; error tracking is off');
  const pending = new Set();
  let windowStart = 0;
  let sent = 0;
  let warned = false;

  function capture(error, context = {}) {
    if (!target) return;
    try {
      const now = Date.now();
      if (now - windowStart >= 60000) { windowStart = now; sent = 0; }
      if (sent >= maxPerMinute) return;
      sent++;

      const tags = { app };
      for (const [k, v] of Object.entries(context.tags || {})) if (v !== undefined && v !== null && v !== '') tags[k] = scrub(v, 200);
      if (context.org_id) tags.org = scrub(context.org_id, 200);
      const event = {
        event_id: crypto.randomUUID().replace(/-/g, ''),
        timestamp: now / 1000,
        platform: 'node',
        level: context.level || 'error',
        logger: app,
        environment: environment || undefined,
        release: release || undefined,
        tags,
        user: context.user_id ? { id: pseudonym(`${context.org_id || ''}|${context.user_id}`) } : undefined,
        request: context.method || context.route ? { method: context.method, url: context.route ? scrub(context.route, 300) : undefined } : undefined,
        exception: exceptionOf(error),
      };
      const body = [
        JSON.stringify({ event_id: event.event_id, sent_at: new Date(now).toISOString() }),
        JSON.stringify({ type: 'event' }),
        JSON.stringify(event),
      ].join('\n');
      const p = fetchImpl(target.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_client=tss-error-tracking/1.0, sentry_key=${target.key}`,
        },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      }).then((res) => {
        if (!res.ok && !warned) { warned = true; logger.warn(`error tracking: the tracker answered ${res.status}`); }
      }, () => {
        if (!warned) { warned = true; logger.warn('error tracking: the tracker could not be reached'); }
      }).finally(() => pending.delete(p));
      pending.add(p);
    } catch {
      // Reporting an error must never cause one.
    }
  }

  async function flush(timeoutMs = 2000) {
    if (!pending.size) return;
    await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  return { enabled: Boolean(target), capture, flush };
}

/** The reporter configured by the environment. Off when ERROR_TRACKING_DSN is unset. */
export function errorReporterFromEnv(app, env = process.env) {
  return createErrorReporter({
    dsn: env.ERROR_TRACKING_DSN,
    app,
    environment: env.ERROR_TRACKING_ENVIRONMENT || env.NODE_ENV,
    release: env.ERROR_TRACKING_RELEASE || env.RENDER_GIT_COMMIT,
  });
}

/**
 * Reports a crash (an uncaught exception or an unhandled promise rejection),
 * waits briefly for the report to leave, then exits as Node would have. Only
 * installed when tracking is on, so with it off nothing changes.
 */
export function installCrashHandlers(reporter, logger = console) {
  if (!reporter.enabled) return;
  let exiting = false;
  const crash = (kind) => (error) => {
    logger.error(`${kind}:`, error);
    if (exiting) return;
    exiting = true;
    reporter.capture(error, { level: 'fatal', tags: { kind } });
    reporter.flush().finally(() => process.exit(1));
  };
  process.on('uncaughtException', crash('uncaught_exception'));
  process.on('unhandledRejection', crash('unhandled_rejection'));
}

let shared = null;
/** The process-wide reporter, read from the environment on first use. */
export function errorReporter(app) {
  if (!shared) shared = errorReporterFromEnv(app);
  return shared;
}
/** Replaces the process-wide reporter. For tests. */
export function setErrorReporter(reporter) { shared = reporter; }
