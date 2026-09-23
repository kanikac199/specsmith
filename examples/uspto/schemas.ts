import { z } from "zod";

export const dataSetListSchema = z.object({
  total: z.number().int().optional(),
  apis: z
    .array(
      z.object({
        apiKey: z.string().optional(),
        apiVersionNumber: z.string().optional(),
        apiUrl: z.string().optional(),
        apiDocumentationUrl: z.string().optional(),
      })
    )
    .optional(),
});
export type dataSetList = z.infer<typeof dataSetListSchema>;
