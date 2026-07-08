// Client mirror of the controller's connect catalog shapes (src/connect/
// catalog.ts). Kept as a plain type module so every tab imports one source.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ParamDoc {
  name: string;
  required?: boolean;
  description: string;
  example?: string | number | boolean;
}

export interface EndpointDoc {
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  auth: 'none' | 'admin';
  mutatesAir?: boolean;
  pathParams?: ParamDoc[];
  queryParams?: ParamDoc[];
  bodyExample?: Record<string, unknown>;
  responseExample: unknown;
}

export interface EndpointGroup {
  id: string;
  label: string;
  blurb: string;
  endpoints: EndpointDoc[];
}

export interface McpToolDoc {
  name: string;
  title: string;
  description: string;
  endpoint: string;
  auth: 'none' | 'admin';
  mutatesAir?: boolean;
}

export interface StreamMountDoc {
  mount: string;
  format: string;
  codec: string;
  description: string;
  settingFlag: 'opusEnabled' | 'flacEnabled' | 'aacEnabled' | null;
  alwaysOn: boolean;
  enabled: boolean;
}

export interface Catalog {
  station: string;
  apiBase: string;
  origin: string;
  version: string;
  groups: EndpointGroup[];
  mcpTools: McpToolDoc[];
  mcpHttpPath: string;
  streamMounts: StreamMountDoc[];
  openapiPath: string;
}
