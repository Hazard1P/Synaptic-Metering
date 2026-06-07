import { z } from "zod";

export const CreateSessionBody = z.object({
  seat_id: z.string().min(1).max(80).optional(),
  metadata: z.record(z.any()).optional()
}).strict();

export const StartBody = z.object({
  item_id: z.string().min(1).max(120)
});

export const HeartbeatBody = z.object({
  seconds: z.number().int().min(1).max(10).default(1)
});

export function parseBody(schema, body){
  const r = schema.safeParse(body);
  if(!r.success){
    const issues = r.error.issues.map(i=>({ path: i.path.join("."), message: i.message }));
    const err = new Error("validation_error");
    err.status = 400;
    err.issues = issues;
    throw err;
  }
  return r.data;
}
