import { z } from 'zod';

export const hostMethods = {
  create: { input: z.null(), output: z.string() },
  read: { input: z.null(), output: z.string() },
  write: { input: z.string().max(128), output: z.string() },
};

export const methods = {
  create: { input: z.null(), output: z.object({path: z.string(), hostId: z.string()}) },
  read: hostMethods.read,
  write: hostMethods.write,
};
