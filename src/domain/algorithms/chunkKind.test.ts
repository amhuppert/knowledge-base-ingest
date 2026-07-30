import { describe, expect, it } from 'vitest';
import { classifyChunkText, type ChunkKind } from './chunkKind.js';

describe('classifyChunkText', () => {
  it.each<{ name: string; text: string; expected: ChunkKind }>([
    { name: 'single ATX heading', text: '# Heading', expected: 'structural' },
    {
      name: 'multiple ATX headings with blank lines',
      text: '# Heading\n\n## Child\n###### Deep',
      expected: 'structural',
    },
    {
      name: 'heading plus prose',
      text: '# Heading\nThis paragraph contains knowledge.',
      expected: 'substantive',
    },
    { name: 'list only', text: '- first\n- second', expected: 'substantive' },
    { name: 'code fence only', text: '```ts\n```', expected: 'substantive' },
    { name: 'blank only', text: ' \n\t\n', expected: 'substantive' },
    { name: 'empty string', text: '', expected: 'substantive' },
  ])('classifies $name as $expected', ({ text, expected }) => {
    expect(classifyChunkText(text)).toBe(expected);
  });
});
