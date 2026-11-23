import { z } from "zod";

export const repositorySection = z.enum(["actions","issues","variables"]);
export type RepositorySection = z.infer<typeof repositorySection>;
export const featureList = z.object({
  items:z.array(z.object({
    id:z.string(), name:z.string(), status:z.string(), detail:z.string().nullable(),
    updated:z.string().nullable(), url:z.url().nullable(),
  })),
  notice:z.string().nullable(),
});
export type FeatureList = z.infer<typeof featureList>;
