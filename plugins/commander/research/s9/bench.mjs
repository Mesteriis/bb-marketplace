import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { BlobWriter, BlobReader, Reader, TextReader, TextWriter, ZipReader, ZipWriter, configure } from '@zip.js/zip.js';
import tar from 'tar-stream';
import { diffLines } from 'diff';
configure({ useWebWorkers: false });
const [format, operation, dir] = process.argv.slice(2);
const size = 2147483648;
const empty = Buffer.alloc(0);
const block = Buffer.alloc(1024 * 1024, 65);
const chunks = () => Readable.from((function* () {
  for (let n = 0; n < 2048; n++) yield block;
})());
const archive = dir + '/mass.' + format;
let bytes = 0;
let entries = 0;
const sink = () => new Writable({ write(chunk, _, done) { bytes += chunk.length; done(); } });
const started = performance.now();
if (format === 'zip' && operation === 'write') {
  const zip = new ZipWriter(Writable.toWeb(fs.createWriteStream(archive)), { level: 0, zip64: true });
  await zip.add('large.txt', Readable.toWeb(chunks()));
  for (let i = 1; i < 100000; i++) await zip.add('empty-' + i);
  await zip.close();
} else if (format === 'zip' && operation === 'read') {
  // Use the Node file handle as a range reader. No Blob of the whole file.
  const handle = await fs.promises.open(archive);
  class FileReader extends Reader {
    async readUint8Array(offset, length) {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      assert.equal(bytesRead, length);
      return buffer;
    }
  };
  const reader = new FileReader();
  reader.size = (await handle.stat()).size;
  const zip = new ZipReader(reader);
  for await (const entry of zip.getEntriesGenerator()) {
    await entry.getData(Writable.toWeb(sink()), { checkSignature: true });
    entries++;
  }
  await zip.close();
  await handle.close();
} else if (format === 'tar' && operation === 'write') {
  const pack = tar.pack();
  const output = pipeline(pack, fs.createWriteStream(archive));
  await pipeline(chunks(), pack.entry({ name: 'large.txt', size }));
  for (let i = 1; i < 100000; i++)
    await new Promise((resolve, reject) => pack.entry({ name: 'empty-' + i }, empty, err => err ? reject(err) : resolve()));
  pack.finalize();
  await output;
} else if (format === 'tar' && operation === 'read') {
  const extract = tar.extract();
  extract.on('entry', (_header, stream, next) => {
    entries++;
    pipeline(stream, sink()).then(() => next(), next);
  });
  await pipeline(fs.createReadStream(archive), extract);
} else if (format === 'diff') {
  const hash = createHash('sha256');
  await pipeline(chunks(), hash);
  assert.equal(hash.digest('hex').length, 64);
  const different = diffLines('before\n'.repeat(100000), 'after\n'.repeat(100000), { timeout: 150, maxEditLength: 2000 });
  assert.equal(different, undefined);
  const result = diffLines('a\nb\n', 'a\nc\n', { timeout: 150, maxEditLength: 2000 });
  assert.deepEqual(result.map(({ value }) => value), ['a\n', 'b\n', 'c\n']);
  console.log('diff: 100000 строк с бюджетом и проверка результата PASS; SHA-256: 2 ГиБ');
} else if (format === 'compat') {
  for (const zipCrypto of [false, true]) {
    const zip = new ZipWriter(new BlobWriter(), { zip64: true });
    await zip.add('café.txt', new TextReader('payload'), {
      useUnicodeFileNames: false,
      encodeText: () => Uint8Array.from([99, 97, 102, 130, 46, 116, 120, 116]),
      password: 'synthetic', zipCrypto, encryptionStrength: 3
    });
    const blob = await zip.close();
    await fs.promises.writeFile(dir + (zipCrypto ? '/zipcrypto.zip' : '/aes.zip'), Buffer.from(await blob.arrayBuffer()));
    const input = new ZipReader(new BlobReader(blob));
    const [file] = await input.getEntries({ filenameEncoding: 'cp437' });
    assert.equal(file.filename, 'café.txt');
    await assert.rejects(file.getData(new TextWriter(), { password: 'incorrect', checkSignature: true }));
    assert.equal(await file.getData(new TextWriter(), { password: 'synthetic', checkSignature: true }), 'payload');
    await input.close();
    console.log(zipCrypto ? 'ZIP64 CP437 ZipCrypto PASS' : 'ZIP64 CP437 AES-256 PASS');
  }
}
if (operation === 'read') {
  assert.equal(bytes, 2147483648);
  assert.equal(entries, 100000);
}
console.log(JSON.stringify({ format, operation, entries, bytes, ms: Math.round(performance.now() - started), maxRssKiB: process.resourceUsage().maxRSS }));
