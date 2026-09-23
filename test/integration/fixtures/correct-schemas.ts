import { z } from "zod";

export const WidgetSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  tags: z.array(z.string()).optional(),
});
export type Widget = z.infer<typeof WidgetSchema>;

export const NewWidgetSchema = z.object({
  name: z.string(),
  tags: z.array(z.string()).optional(),
});
export type NewWidget = z.infer<typeof NewWidgetSchema>;
