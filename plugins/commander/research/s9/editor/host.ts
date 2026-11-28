import { defineRpcContract, experimental_defineHostEntry } from '@get-bb/plugin-sdk';
import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostMethods } from './wire.ts';

const filename = 's9-synthetic-copy.txt';
export default experimental_defineHostEntry({
  contract: defineRpcContract(hostMethods),
  handlers: {
    async create(_, {experimental_paths: {dataDir}}) {
      await mkdir(dataDir, {recursive: true, mode: 0o700});
      const path = join(dataDir, filename);
      const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await file.writeFile('s9-before\n'); } finally { await file.close(); }
      return path;
    },
    read(_, {experimental_paths: {dataDir}}) {
      return readFile(join(dataDir, filename), 'utf8');
    },
    async write(text, {experimental_paths: {dataDir}}) {
      const path = join(dataDir, filename);
      const file = await open(path, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
      try { await file.writeFile(text, 'utf8'); } finally { await file.close(); }
      return readFile(path, 'utf8');
    },
  },
});
