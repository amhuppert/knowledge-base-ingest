import { describe, it, expect } from 'vitest';
import {
  makeSourceId,
  makeNodeId,
  makeClaimId,
  type SourceId,
  type NodeId,
} from './ids.js';

describe('branded id constructors', () => {
  it('accepts a correctly-prefixed string and brands it', () => {
    const id: SourceId = makeSourceId('src_0123456789abcdef');
    expect(id).toBe('src_0123456789abcdef');
  });

  it('rejects a string with the wrong prefix', () => {
    expect(() => makeSourceId('chk_0123456789abcdef')).toThrow(/SourceId/);
  });

  it('rejects an empty string', () => {
    expect(() => makeNodeId('')).toThrow();
  });

  it('brands distinct id types so they are not interchangeable at the type level', () => {
    // Compile-time guarantee; at runtime they are plain strings.
    const n: NodeId = makeNodeId('nod_abc');
    const c = makeClaimId('clm_abc');
    expect(n).not.toBe(c);
  });
});
