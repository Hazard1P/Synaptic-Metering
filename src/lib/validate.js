import { z } from "zod";

export const CreateSessionBody = z.object({
  seat_id: z.string().min(1).max(80).optional(),
  metadata: z.record(z.any()).optional()
}).strict();

export const StartBody = z.object({
  item_id: z.string().min(1).max(120)
});

export const HeartbeatBody = z.object({
  seconds: z.number().int().min(1).max(10).default(1),
  anchor_id: z.enum(["major-ursa", "cassiopeia", "isolated-blackholes"]).default("major-ursa")
});


export const MasterKeyBody = z.object({
  key_label: z.string().min(1).max(240),
  account_id: z.string().min(1).max(120).nullable().optional(),
  anchor_asset_id: z.enum(["major-ursa", "cassiopeia", "isolated-blackholes"]).default("major-ursa"),
  status: z.enum(["pending", "confirmed", "revoked"]).default("confirmed")
}).strict();

export const ImportInvoiceBody = z.object({
  source: z.enum(["legacy_upload", "platform_attachment"]).default("platform_attachment"),
  source_reference: z.string().min(1).max(240).optional(),
  session_id: z.string().min(1).max(120).optional(),
  invoice: z.record(z.any()).optional(),
  payload: z.record(z.any()).optional()
}).strict().refine(body => body.invoice || body.payload, {
  path: ["payload"],
  message: "invoice or payload is required"
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
