import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { initializeWorkflow } from "../workflow/initialize-workflow";
import { createSubmissionService } from "./submission-service";
import type { SubmissionPorts } from "./submission-types";

/** Production adapter: all Supabase and browser storage access stays here. */
const browserPorts: SubmissionPorts = {
  async insertRequest(payload) {
    const { metadata, ...row } = payload;
    // F4 validates this object before the generated JSON column boundary.
    const { data, error } = await supabase
      .from("financial_requests")
      .insert({ ...row, metadata: metadata as Json })
      .select("id, request_number, created_at")
      .single();
    if (error) throw error;
    return data;
  },
  async findRequest(requestNumber) {
    const { data, error } = await supabase
      .from("financial_requests")
      .select("id, request_number, created_at")
      .eq("request_number", requestNumber)
      .maybeSingle();
    if (error) return null;
    return data;
  },
  async uploadAttachment(path, file) {
    return supabase.storage.from("request-attachments").upload(path, file, { upsert: false });
  },
  async linkAttachment(record) {
    return supabase.from("request_attachments").insert(record);
  },
  savePrototypeRequest(payload, requestNumber, createdAt) {
    const saved = {
      ...payload,
      id: crypto.randomUUID(),
      request_number: requestNumber,
      created_at: createdAt,
      prototype: true,
    };
    const existing = JSON.parse(
      window.localStorage.getItem("prototype-financial-requests") ?? "[]",
    ) as unknown[];
    window.localStorage.setItem(
      "prototype-financial-requests",
      JSON.stringify([saved, ...existing].slice(0, 50)),
    );
    return saved;
  },
  savePrototypeAttachments(requestId, userId, files) {
    if (files.length === 0) return;
    const records = files.map((file) => ({
      id: crypto.randomUUID(),
      request_id: requestId,
      user_id: userId,
      file_name: file.name,
      file_path: `prototype://${requestId}/${file.name}`,
      file_size: file.size,
      content_type: file.type,
      created_at: new Date().toISOString(),
    }));
    const existing = JSON.parse(
      window.localStorage.getItem("prototype-request-attachments") ?? "[]",
    ) as unknown[];
    window.localStorage.setItem(
      "prototype-request-attachments",
      JSON.stringify([...records, ...existing].slice(0, 100)),
    );
  },
  async startWorkflow(requestId) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("No active session");
    return initializeWorkflow({
      data: { requestId },
      headers: { Authorization: `Bearer ${token}` },
    });
  },
  wait: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
  now: () => new Date(),
};

export const submitFinancialRequest = createSubmissionService(browserPorts);
