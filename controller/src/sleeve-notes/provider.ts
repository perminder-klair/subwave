// Source-neutral provider boundary. Phase 1 defines the contract only; Phase 2
// is the first code allowed to instantiate a networked provider.
export type SleeveEntityKind = 'artist' | 'release' | 'track' | 'external';
export type SleeveRelationshipType = 'samples' | 'sampled_in' | 'cover_of' | 'covered_by';

export interface SleeveEntityInput {
  kind: SleeveEntityKind;
  title: string;
  artist?: string;
  releaseTitle?: string;
  localId?: string;
}

export interface ProviderIdentity {
  providerId: string;
  canonicalUrl: string;
  title: string;
  artist?: string;
}

export interface ProviderRelationship {
  type: SleeveRelationshipType;
  target: ProviderIdentity;
}

export interface ProviderContributor {
  providerId: string;
  name: string;
  canonicalUrl?: string;
}

export interface SleeveProviderResult {
  identity: ProviderIdentity;
  credits: Array<{ role: string; names: string[]; contributors?: ProviderContributor[] }>;
  relationships: ProviderRelationship[];
  attribution: string;
  retrievedAt: string;
}

export interface SleeveProvider {
  readonly id: string;
  fetch(entity: SleeveEntityInput, signal: AbortSignal): Promise<SleeveProviderResult | null>;
}
