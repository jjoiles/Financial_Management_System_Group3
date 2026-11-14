import { useState } from "react";

import {
  X,
  Paperclip,
  Calendar,
  Building2,
  DollarSign,
  AlertCircle,
  Mail,
  Tag,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react";

import StatusBadge from "@/components/StatusBadge";
import WorkflowTracker from "@/components/WorkflowTracker";

import type { EnrichedRequest } from "@/lib/requests-data";

import { useRequestActivity } from "@/lib/activity-data";

import { linkTypeLabel, useRequestLinks } from "@/lib/links-data";

import { formatCurrency } from "@/lib/format";

import { useAuth } from "@/lib/auth-context";

import { supabase } from "@/integrations/supabase/client";

import {
  recordApprovalDecision,
  type ApprovalDecision,
} from "@/lib/workflow/record-approval-decision";

type RequestDetailDialogProps = {
  request: EnrichedRequest | null;
  onClose: () => void;
  onDecisionRecorded?: () => Promise<void> | void;
};

export default function RequestDetailDialog({
  request,
  onClose,
  onDecisionRecorded,
}: RequestDetailDialogProps) {
  const { roles } = useAuth();

  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);

  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const canReview = roles.includes("admin") || roles.includes("leadership");

  const canDecide =
    !!request &&
    !request.prototype &&
    canReview &&
    !!request.activeStage &&
    (request.status === "Submitted" || request.status === "Under Review");

  const handleDecision = async (decision: ApprovalDecision) => {
    if (!request || !request.activeStage || !canDecide || submitting) {
      return;
    }

    setSubmitting(decision);
    setFeedback(null);

    try {
      const { data: sessionData } = await supabase.auth.getSession();

      const token = sessionData.session?.access_token;

      if (!token) {
        throw new Error("Your session has expired. Please sign in again.");
      }

      await recordApprovalDecision({
        data: {
          requestId: request.uuid,
          stageId: request.activeStage.id,
          decision,
          comment: comment.trim() || null,
        },
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      setComment("");

      setFeedback({
        type: "success",
        message:
          decision === "approve"
            ? "Approval recorded successfully."
            : "Request rejected successfully.",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to record your decision.",
      });

      setSubmitting(null);
      return;
    }

    setSubmitting(null);

    // Refresh the parent request list after a successful decision.
    try {
      await onDecisionRecorded?.();
    } catch {
      setFeedback({
        type: "error",
        message:
          "Your decision was recorded, but the request list could not refresh. Please reload the page.",
      });
    }
  };

  if (!request) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-border bg-card shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-border bg-card px-6 py-4">
          <div className="min-w-0">
            <p className="font-mono text-xs text-primary">{request.id}</p>

            <h2 className="mt-1 truncate text-lg font-semibold text-card-foreground">
              {request.title}
            </h2>

            <div className="mt-2 flex items-center gap-2">
              <StatusBadge status={request.status} />

              {request.prototype && (
                <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">
                  Prototype
                </span>
              )}
            </div>
          </div>

          <button
            onClick={onClose}
            disabled={submitting !== null}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label="Close request details"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Request details */}
        <div className="space-y-6 p-6">
          <WorkflowTracker status={request.status} />

          {/* Current SLA Stage */}
          {request.activeStage && (
            <div className="rounded-xl border border-border bg-background p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Current Approval Stage
              </p>

              <p className="mt-2 text-base font-semibold text-foreground">
                {request.activeStage.stageName}
              </p>

              <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <p>Stage {request.activeStage.stageOrder}</p>

                <p>Processing target: {request.activeStage.durationHours} hours</p>

                <p>Started: {new Date(request.activeStage.startedAt).toLocaleString()}</p>

                <p>Deadline: {new Date(request.activeStage.deadlineAt).toLocaleString()}</p>
              </div>
            </div>
          )}

          {/* Approval Decision Controls */}
          {canDecide && (
            <section className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Reviewer Decision</h3>

                <p className="mt-1 text-xs text-muted-foreground">
                  Review this request and record your approval decision.
                </p>
              </div>

              <div>
                <label
                  htmlFor="approval-comment"
                  className="mb-2 block text-xs font-medium text-foreground"
                >
                  Reviewer Comments (Optional)
                </label>

                <textarea
                  id="approval-comment"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  maxLength={2000}
                  rows={3}
                  disabled={submitting !== null}
                  placeholder="Enter any notes about your decision..."
                  className="w-full resize-y rounded-lg border border-border bg-background p-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                />

                <p className="mt-1 text-right text-[10px] text-muted-foreground">
                  {comment.length}/2000 characters
                </p>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={() => void handleDecision("approve")}
                  disabled={submitting !== null}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-success px-4 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting === "approve" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}

                  {submitting === "approve" ? "Approving..." : "Approve Request"}
                </button>

                <button
                  type="button"
                  onClick={() => void handleDecision("reject")}
                  disabled={submitting !== null}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-destructive bg-background px-4 py-3 text-sm font-semibold text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting === "reject" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4" />
                  )}

                  {submitting === "reject" ? "Rejecting..." : "Reject Request"}
                </button>
              </div>

              {feedback && (
                <div
                  role="alert"
                  className={`rounded-lg p-3 text-xs ${
                    feedback.type === "success"
                      ? "bg-success/10 text-success"
                      : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {feedback.message}
                </div>
              )}
            </section>
          )}

          {/* Request Information */}
          <div className="grid gap-3 sm:grid-cols-2">
            <DetailRow icon={Mail} label="Requester" value={request.email} />

            <DetailRow icon={Building2} label="Department" value={request.department} />

            <DetailRow icon={Tag} label="Funding Source" value={`${request.fundingType} Fund`} />

            <DetailRow icon={DollarSign} label="Amount" value={formatCurrency(request.amount)} />

            <DetailRow icon={AlertCircle} label="Priority" value={request.priority} />

            <DetailRow icon={Calendar} label="Needed By" value={request.neededBy} />

            <DetailRow icon={Calendar} label="Submitted" value={request.submittedAt} />

            {request.routedTo && (
              <DetailRow icon={Paperclip} label="Routed To" value={request.routedTo} />
            )}

            <DetailRow icon={Paperclip} label="Attachments" value={String(request.attachments)} />
          </div>

          {/* Approval Chain */}
          {request.routing && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Approval Chain
              </p>

              <ol className="space-y-2 rounded-lg border border-border bg-background p-4">
                {request.routing.approvalChain.map((step) => (
                  <li key={step.queue} className="text-sm text-foreground">
                    <span className="font-medium">
                      {step.step}. {step.label}
                    </span>

                    <span className="block text-xs text-muted-foreground">{step.reason}</span>
                  </li>
                ))}

                {request.routing.flags.includes("expedited") && (
                  <li className="text-xs font-semibold text-warning">Expedited</li>
                )}
              </ol>
            </div>
          )}

          {/* Description */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Description
            </p>

            <p className="whitespace-pre-wrap rounded-lg border border-border bg-background p-4 text-sm leading-6 text-foreground">
              {request.description}
            </p>
          </div>

          {/* Generated Metadata */}
          {request.metadata && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Generated Metadata (F4)
              </p>

              <div className="space-y-3 rounded-lg border border-border bg-background p-4 text-xs">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div>
                    <span className="text-muted-foreground">Fiscal Period: </span>

                    <span className="font-medium text-foreground">
                      {request.metadata.derived.fiscalYear} ·{" "}
                      {request.metadata.derived.fiscalQuarter}
                    </span>
                  </div>

                  <div>
                    <span className="text-muted-foreground">Amount Tier: </span>

                    <span className="font-medium capitalize text-foreground">
                      {request.metadata.derived.amountTier}
                    </span>
                  </div>

                  <div>
                    <span className="text-muted-foreground">Schema: </span>

                    <span className="font-mono text-foreground">
                      v{request.metadata.schemaVersion} ({request.metadata.generationStatus})
                    </span>
                  </div>
                </div>

                {request.metadata.attachments.length > 0 && (
                  <div className="border-t border-border pt-2">
                    <p className="mb-1 font-medium text-muted-foreground">
                      Extracted Attachment Manifest ({request.metadata.attachments.length} file
                      {request.metadata.attachments.length === 1 ? "" : "s"} ·{" "}
                      {request.metadata.derived.totalAttachmentBytes.toLocaleString()} bytes)
                    </p>

                    <ul className="space-y-1">
                      {request.metadata.attachments.map((att, idx) => (
                        <li
                          key={`${att.safeFileName}-${idx}`}
                          className="flex items-center justify-between gap-2 font-mono text-[11px] text-foreground"
                        >
                          <span className="truncate">{att.safeFileName}</span>

                          <span className="shrink-0 text-muted-foreground">
                            {att.contentType} · {att.sizeBytes.toLocaleString()} B
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Linked Records */}
          {!request.prototype && <LinkedRecords requestId={request.uuid} />}

          {/* Activity Log */}
          {!request.prototype && <ActivityLog requestId={request.uuid} />}
        </div>
      </div>
    </div>
  );
}

/* Request Information Row */
function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Mail;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>

      <p className="mt-1 break-words text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

/* Request Activity History */
function ActivityLog({ requestId }: { requestId: string }) {
  const { events, loading, error } = useRequestActivity(requestId);

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Activity
      </p>

      <div className="rounded-lg border border-border bg-background p-4">
        {loading && <p className="text-xs text-muted-foreground">Loading activity…</p>}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {!loading && !error && events.length === 0 && (
          <p className="text-xs text-muted-foreground">No activity recorded yet.</p>
        )}

        <ol className="space-y-2">
          {events.map((event) => (
            <li key={event.id} className="flex gap-3 text-sm">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />

              <div className="min-w-0">
                <p className="text-foreground">{event.message}</p>

                <p className="text-[11px] text-muted-foreground">
                  {new Date(event.createdAt).toLocaleString()} ·{" "}
                  {event.eventType.replace(/_/g, " ")}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/* Related Financial Requests */
function LinkedRecords({ requestId }: { requestId: string }) {
  const { links, loading } = useRequestLinks(requestId);

  if (loading || links.length === 0) return null;

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Linked Records
      </p>

      <ul className="space-y-2 rounded-lg border border-border bg-background p-4">
        {links.map((link) => (
          <li key={link.id} className="flex flex-wrap items-start justify-between gap-2 text-sm">
            <div className="min-w-0">
              <p className="font-mono text-xs text-primary">
                {link.linked?.requestNumber ?? "Unavailable"}
              </p>

              <p className="truncate text-foreground">{link.linked?.title}</p>

              <p className="text-[11px] text-muted-foreground">{link.reason}</p>
            </div>

            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                link.linkType === "possible_duplicate"
                  ? "bg-warning/15 text-warning"
                  : "bg-primary/10 text-primary"
              }`}
            >
              {linkTypeLabel[link.linkType]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
