'use client';

import { Pill } from '../ui';
import type { EndpointDoc } from './types';

// The one rendering of an endpoint's / MCP tool's auth class. Both the endpoint
// list and the MCP tool list show the same badge for the same value, and they
// had drifted into two identical ternaries that a third auth class would have
// had to be added to twice — the kind of edit it is easy to make in one place
// and forget in the other, leaving a station-gated tool labelled "public".
const LABEL: Record<EndpointDoc['auth'], string> = {
  none: 'public',
  admin: 'admin',
  station: 'station',
};

export default function AuthPill({ auth }: { auth: EndpointDoc['auth'] }) {
  // Anything carrying a credential is accented; only the open surface is plain.
  return auth === 'none'
    ? <Pill>{LABEL.none}</Pill>
    : <Pill tone="accent">{LABEL[auth] ?? auth}</Pill>;
}
