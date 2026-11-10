// The MCP tools' published output schemas must carry no `$schema` dialect line.
//
// The SDK turns a zod output shape into JSON Schema with
// `$schema: http://json-schema.org/draft-07/schema#`, and an MCP client that
// validates structured output with a JSON Schema 2020-12-only validator refuses
// the tool outright ("unsupported dialect"), before it can read the result. For
// an on-air tool that error can arrive after the action already ran, which
// invites a retry and a double airing. `output()` in src/mcp/tools.ts clears
// the line so each client reads the schema in its own default dialect.
//
// That is only correct while the schemas use nothing draft-07 and 2020-12 read
// differently, so the second half of this file walks every published schema
// for those keywords. A new output shape that needs one of them has to be
// written another way, not let through here.
//
// The list goes through a real McpServer + Client pair and a JSON round trip,
// because that is what a remote client receives: the SDK's own conversion is
// the thing under test, not a stub of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerSubwaveTools } from '../src/mcp/tools.js';
import type { SubwaveClient } from '../src/mcp/client.js';

// Keywords whose meaning or spelling differs between draft-07 and 2020-12.
const DIALECT_SENSITIVE = [
  '$schema',
  'definitions',
  '$defs',
  '$ref',
  '$recursiveRef',
  '$dynamicRef',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'prefixItems',
  'additionalItems',
  'unevaluatedItems',
  'unevaluatedProperties',
];

async function connect(client: Partial<SubwaveClient>) {
  const server = new McpServer({ name: 'test', version: '0' });
  registerSubwaveTools(server, client as SubwaveClient);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test-client', version: '0' });
  await server.connect(serverSide);
  await mcp.connect(clientSide);
  return mcp;
}

async function publishedTools() {
  const mcp = await connect({});
  try {
    const { tools } = await mcp.listTools();
    // What a client on the other end of HTTP or stdio actually parses.
    return JSON.parse(JSON.stringify(tools)) as typeof tools;
  } finally {
    await mcp.close();
  }
}

/** Every dialect-sensitive keyword (or array-form `items`) under `node`, with its path. */
function sensitiveKeys(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => sensitiveKeys(v, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  const hits: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (DIALECT_SENSITIVE.includes(key)) hits.push(`${path}.${key}`);
    if (key === 'items' && Array.isArray(value)) hits.push(`${path}.items (tuple form)`);
    // `properties` holds field names, which may legitimately spell anything.
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [field, sub] of Object.entries(value)) {
        hits.push(...sensitiveKeys(sub, `${path}.properties.${field}`));
      }
    } else {
      hits.push(...sensitiveKeys(value, `${path}.${key}`));
    }
  }
  return hits;
}

test('tools still publish output schemas (the checks below are not vacuous)', async () => {
  const withOutput = (await publishedTools()).filter((t) => t.outputSchema);
  assert.ok(withOutput.length >= 12, `expected at least 12 output schemas, got ${withOutput.length}`);
});

test('no published output schema declares a $schema dialect', async () => {
  const offenders = (await publishedTools())
    .filter((t) => t.outputSchema && '$schema' in t.outputSchema)
    .map((t) => `${t.name}: ${String((t.outputSchema as Record<string, unknown>).$schema)}`);
  assert.deepEqual(offenders, []);
});

test('output schemas use only keywords draft-07 and 2020-12 read the same way', async () => {
  const offenders = (await publishedTools())
    .filter((t) => t.outputSchema)
    .flatMap((t) => sensitiveKeys(t.outputSchema).map((hit) => `${t.name}: ${hit}`));
  assert.deepEqual(offenders, []);
});

test('the server still validates structured output against the wrapped schema', async () => {
  const good = await connect({ refreshPlaylist: async () => ({ ok: true }) } as Partial<SubwaveClient>);
  try {
    const res = await good.callTool({ name: 'subwave_refresh_playlist', arguments: {} });
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent, { ok: true });
  } finally {
    await good.close();
  }

  // A result that breaks the schema must still be refused, or the wrapper
  // would have quietly turned validation off.
  const bad = await connect({ refreshPlaylist: async () => ({ ok: 'yes' }) } as unknown as Partial<SubwaveClient>);
  let refused: boolean;
  try {
    const res = await bad.callTool({ name: 'subwave_refresh_playlist', arguments: {} });
    refused = res.isError === true;
  } catch {
    // Some SDK versions throw instead of returning an error result; either is a refusal.
    refused = true;
  } finally {
    await bad.close();
  }
  assert.ok(refused, 'a structuredContent that breaks the output schema was accepted');
});
