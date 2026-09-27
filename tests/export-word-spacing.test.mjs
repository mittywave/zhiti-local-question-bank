import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { loadSource } from './load-source.mjs';

test('question Word export gives native math and inline images automatic line height', async t => {
  const OriginalImage = globalThis.Image;
  // Only browser image decoding is stubbed; the actual DOCX builder is executed.
  globalThis.Image = class {
    naturalWidth = 160; naturalHeight = 100;
    set src(_value) { queueMicrotask(() => this.onload()); }
  };
  t.after(() => { if (OriginalImage === undefined) delete globalThis.Image; else globalThis.Image = OriginalImage; });
  const { buildQuestionsWordBlob } = await loadSource('lib/export-word.ts');
  const question = { id: 'synthetic', type: '单选题', stem: '计算 $x=\\frac{1}{2}$。',
    options: ['$\\frac{1}{2}$', '1', '2', '4'], answer: 'A', analysis: '$\\frac{1}{2}$',
    tags: [], difficulty: '基础', contentImages: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'], imageLayout: 'right' };
  const blob = await buildQuestionsWordBlob([question], '版式回归', true);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('word/document.xml').async('string');
  const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
  const mediaParagraphs = paragraphs.filter(p => /<m:oMath>|<w:drawing>/.test(p));
  assert.ok(mediaParagraphs.length >= 4);
  for (const p of mediaParagraphs) assert.match(p, /<w:spacing[^>]*w:lineRule="auto"/);
  assert.match(xml, /<m:f>/);
  assert.match(xml, /<w:drawing>/);
  assert.match(xml, /<w:tbl>/);
  const styles = await zip.file('word/styles.xml').async('string');
  assert.match(styles, /<w:spacing[^>]*w:lineRule="auto"/);
});
