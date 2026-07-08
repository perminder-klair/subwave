// Pure catalog → OpenAPI 3.1 mapper. The Connect page's "Download OpenAPI"
// button and GET /connect/openapi.json both go through toOpenApi(). No SDK —
// the catalog shapes are simple enough to map by hand, and this stays a pure,
// dependency-free function so it can be unit-checked.
//
// Every path is emitted under the `/api` prefix (that's how the endpoints are
// reached from outside the controller, behind Caddy), even though the catalog
// stores them prefix-free. Admin endpoints carry a basicAuth security
// requirement; public ones carry none.

import {
  ENDPOINTS,
  type EndpointDoc,
  type ParamDoc,
} from './catalog.js';

interface OpenApiDoc {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: { url: string; description?: string }[];
  components: {
    securitySchemes: {
      basicAuth: { type: 'http'; scheme: 'basic'; description: string };
    };
  };
  paths: Record<string, Record<string, unknown>>;
}

function paramObjects(params: ParamDoc[] | undefined, location: 'path' | 'query') {
  return (params || []).map(p => ({
    name: p.name,
    in: location,
    // Path params are always required in OpenAPI; query params follow the doc.
    required: location === 'path' ? true : p.required === true,
    description: p.description,
    schema: { type: typeof p.example === 'number' ? 'number' : typeof p.example === 'boolean' ? 'boolean' : 'string' },
    ...(p.example !== undefined ? { example: p.example } : {}),
  }));
}

// Express `:id` → OpenAPI `{id}`.
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function operationFor(ep: EndpointDoc) {
  const parameters = [
    ...paramObjects(ep.pathParams, 'path'),
    ...paramObjects(ep.queryParams, 'query'),
  ];

  const op: Record<string, unknown> = {
    summary: ep.summary,
    description: ep.description,
    // Group operations in generated clients / Swagger UI by their air-safety.
    tags: [ep.mutatesAir ? 'mutates-air' : ep.auth === 'admin' ? 'admin-read' : 'public-read'],
    ...(parameters.length ? { parameters } : {}),
    responses: {
      '200': {
        description: 'Success',
        content: {
          'application/json': {
            example: ep.responseExample,
          },
        },
      },
    },
  };

  if (ep.auth === 'admin') op.security = [{ basicAuth: [] }];

  if (ep.bodyExample) {
    op.requestBody = {
      required: true,
      content: {
        'application/json': { example: ep.bodyExample },
      },
    };
  }

  return op;
}

export function toOpenApi(origin: string, version = 'latest'): OpenApiDoc {
  const base = `${origin.replace(/\/+$/, '')}/api`;
  const paths: Record<string, Record<string, unknown>> = {};

  for (const ep of ENDPOINTS) {
    const key = toOpenApiPath(ep.path);
    paths[key] ??= {};
    paths[key][ep.method.toLowerCase()] = operationFor(ep);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'SUB/WAVE API',
      version,
      description:
        'The integration subset of the SUB/WAVE controller HTTP API — station ' +
        'state, listener requests, DJ control, and operational reads. Admin ' +
        'endpoints use HTTP Basic auth (the station\'s ADMIN_USER / ADMIN_PASS). ' +
        'Explore and try these live at /admin/connect.',
    },
    servers: [{ url: base, description: 'This station' }],
    components: {
      securitySchemes: {
        basicAuth: {
          type: 'http',
          scheme: 'basic',
          description: 'The station\'s ADMIN_USER / ADMIN_PASS.',
        },
      },
    },
    paths,
  };
}
