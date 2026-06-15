import { describe, it, expect } from 'vitest';
import {
  deriveSourceId,
  deriveChunkId,
  deriveSpanId,
  deriveClaimId,
  deriveEntityId,
  deriveRelationshipId,
  deriveNodeId,
} from './idDeriver.js';

describe('idDeriver — deterministic, content-addressed identity', () => {
  it('derives a stable, prefixed source id from raw bytes', () => {
    const a = deriveSourceId(Buffer.from('hello world'));
    const b = deriveSourceId(Buffer.from('hello world'));
    expect(a).toBe(b);
    expect(a.startsWith('src_')).toBe(true);
  });

  it('gives different sources different ids', () => {
    expect(deriveSourceId(Buffer.from('a'))).not.toBe(deriveSourceId(Buffer.from('b')));
  });

  it('derives chunk id from (sourceId, chunkIndex)', () => {
    const src = deriveSourceId(Buffer.from('doc'));
    expect(deriveChunkId(src, 0)).toBe(deriveChunkId(src, 0));
    expect(deriveChunkId(src, 0)).not.toBe(deriveChunkId(src, 1));
    expect(deriveChunkId(src, 0).startsWith('chk_')).toBe(true);
  });

  it('derives span id from (sourceId, start, end) — same span, same id (idempotent provenance)', () => {
    const src = deriveSourceId(Buffer.from('doc'));
    expect(deriveSpanId(src, 10, 20)).toBe(deriveSpanId(src, 10, 20));
    expect(deriveSpanId(src, 10, 20)).not.toBe(deriveSpanId(src, 10, 21));
    expect(deriveSpanId(src, 10, 20).startsWith('spn_')).toBe(true);
  });

  it('derives claim id from (normalizedText, firstSeenSourceId) — node-independent so claims can move', () => {
    const src = deriveSourceId(Buffer.from('doc'));
    expect(deriveClaimId('the service restarts', src)).toBe(
      deriveClaimId('the service restarts', src),
    );
    expect(deriveClaimId('a', src)).not.toBe(deriveClaimId('b', src));
    expect(deriveClaimId('a', src).startsWith('clm_')).toBe(true);
  });

  it('derives entity id from (type, normalizedName)', () => {
    expect(deriveEntityId('Library', 'react 18')).toBe(deriveEntityId('Library', 'react 18'));
    expect(deriveEntityId('Library', 'react 18')).not.toBe(deriveEntityId('Library', 'react'));
    expect(deriveEntityId('Library', 'react')).not.toBe(deriveEntityId('Concept', 'react'));
    expect(deriveEntityId('Library', 'react').startsWith('ent_')).toBe(true);
  });

  it('derives relationship id from (type, subjectId, objectId)', () => {
    const a = deriveEntityId('Service', 'auth');
    const b = deriveEntityId('DataStore', 'pg');
    expect(deriveRelationshipId('depends_on', a, b)).toBe(deriveRelationshipId('depends_on', a, b));
    expect(deriveRelationshipId('depends_on', a, b)).not.toBe(
      deriveRelationshipId('depends_on', b, a),
    );
    expect(deriveRelationshipId('depends_on', a, b).startsWith('rel_')).toBe(true);
  });

  it('derives node id from (parentId, slug); root uses a sentinel parent', () => {
    const root = deriveNodeId(null, 'root');
    expect(root).toBe(deriveNodeId(null, 'root'));
    const child = deriveNodeId(root, 'auth');
    expect(child).toBe(deriveNodeId(root, 'auth'));
    expect(child).not.toBe(root);
    expect(root.startsWith('nod_')).toBe(true);
  });
});
