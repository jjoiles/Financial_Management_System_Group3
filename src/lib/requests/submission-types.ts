import type { RoutingDecision } from "../routing/engine";
import type { RequestPayload } from "../validation/gateways";
import type { FormErrors } from "../validation/request-schema";
import type { InitializeWorkflowResult } from "../workflow/initialize-workflow";

export type SavedRequest = {
  id: string;
  request_number: string;
  created_at: string;
  prototype?: boolean;
};

export type AttachmentRecord = {
  request_id: string;
  user_id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  content_type: string;
};

export type SubmissionResult = {
  id: string;
  createdAt: string;
  routedTo: string;
  routing: RoutingDecision;
  workflow: string;
  warning?: string;
};

export type SubmissionCommand = {
  userId: string | null;
  values: Record<string, unknown>;
  files: File[];
};

export type SubmissionOutcome =
  | { ok: true; result: SubmissionResult }
  | { ok: false; errors: FormErrors; message: string };

export type SubmissionService = (command: SubmissionCommand) => Promise<SubmissionOutcome>;

/** External effects required by the use case. Tests supply in-memory adapters. */
export type SubmissionPorts = {
  insertRequest: (payload: RequestPayload) => Promise<SavedRequest>;
  findRequest: (requestNumber: string) => Promise<SavedRequest | null>;
  uploadAttachment: (path: string, file: File) => Promise<{ error: unknown }>;
  linkAttachment: (record: AttachmentRecord) => Promise<{ error: unknown }>;
  savePrototypeRequest: (
    payload: RequestPayload,
    requestNumber: string,
    createdAt: string,
  ) => SavedRequest;
  savePrototypeAttachments: (requestId: string, userId: string, files: File[]) => void;
  startWorkflow: (requestId: string) => Promise<InitializeWorkflowResult>;
  wait: (milliseconds: number) => Promise<void>;
  now: () => Date;
};
