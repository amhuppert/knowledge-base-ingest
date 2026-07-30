export type ChunkKind = 'substantive' | 'structural';

export function classifyChunkText(text: string): ChunkKind {
  const nonblankLines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return nonblankLines.length > 0 && nonblankLines.every((line) => /^#{1,6}\s/.test(line))
    ? 'structural'
    : 'substantive';
}
