import { describe, expect, it } from 'vitest';
import { isAcceptedFileName, parseFile, rejectionMessage } from '@/app/importer';

describe('which files the importer accepts, and what it says when it rejects one', () => {
  it('accepts exactly the four PowerPoint extensions the file picker offers, in any case', () => {
    for (const name of ['a.pptx', 'a.pptm', 'a.ppsx', 'a.potx', 'LECTURE 1.PPTX', 'x.y.Pptm']) {
      expect(isAcceptedFileName(name), name).toBe(true);
    }
    for (const name of ['a.ppt', 'a.pot', 'a.docx', 'a.pdf', 'a.pptx.txt', 'pptx', '']) {
      expect(isAcceptedFileName(name), name).toBe(false);
    }
  });

  it('names every accepted extension, not only .pptx, when it rejects a file', () => {
    const message = rejectionMessage('notes.docx');
    for (const ext of ['.pptx', '.pptm', '.ppsx', '.potx']) expect(message).toContain(ext);
  });

  it('tells the student how to convert an old .ppt file', () => {
    expect(rejectionMessage('old.PPT')).toMatch(/old \.ppt file/);
    expect(rejectionMessage('old.PPT')).toContain('.pptx');
  });

  it('parseFile rejects with the same message the import list shows', async () => {
    for (const name of ['notes.docx', 'old.ppt']) {
      await expect(parseFile(new File([new Uint8Array(4)], name))).rejects.toMatchObject({ code: 'NOT_PPTX', message: rejectionMessage(name) });
    }
  });
});
