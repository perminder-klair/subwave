// Replaces Express req/res capture doubles. Initial status is configurable:
// existing tests distinguish an untouched status from explicit 200 or 0.
type Middleware = (req: never, res: never, next: () => void) => unknown;

function capture<Request>(req: Request, options: { initialStatus?: number }) {
  const result = {
    status: 'initialStatus' in options ? options.initialStatus : 200,
    body: null as unknown,
    headers: {} as Record<string, string | string[]>,
    nextCalled: false,
    req,
  };
  const res = {
    status(code: number) { result.status = code; return this; },
    json(body: unknown) { result.body = body; return this; },
    setHeader(name: string, value: string) { result.headers[name.toLowerCase()] = value; },
    append(name: string, value: string) {
      const key = name.toLowerCase();
      const previous = result.headers[key];
      result.headers[key] = previous === undefined ? value : [...[previous].flat(), value];
    },
  };
  return { result, res, next: () => { result.nextCalled = true; } };
}

export function runMiddleware<Request>(fn: Middleware, req: Request, options: { initialStatus?: number } = {}) {
  const { result, res, next } = capture(req, options);
  fn(req as never, res as never, next);
  return result;
}

export async function runMiddlewareAsync<Request>(fn: Middleware, req: Request, options: { initialStatus?: number } = {}) {
  const { result, res, next } = capture(req, options);
  await fn(req as never, res as never, next);
  return result;
}
