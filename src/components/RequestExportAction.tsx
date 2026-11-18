import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import type { EnrichedRequest } from "@/lib/requests-data";
import type { RequestReadIssue } from "@/lib/request-list";
import { prepareRequestExport, requestExportBlockReason } from "@/lib/request-export";
import { downloadBlob } from "@/lib/download-file";

export default function RequestExportAction({ rows, loading, readIssue }: {
  rows: readonly EnrichedRequest[];
  loading: boolean;
  readIssue: RequestReadIssue | null;
}) {
  const auth = useAuth();
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const context = { userId: auth.user?.id, needsMfa: auth.needsMfa, loading: loading || auth.loading, readIssue };
  const reason = requestExportBlockReason(context, rows.length);

  const exportCsv = () => {
    setFeedback(null);
    try {
      const file = prepareRequestExport(rows, context);
      downloadBlob(new Blob(["\uFEFF", file.csv], { type: "text/csv;charset=utf-8" }), file.filename);
      setFeedback({ error: false, message: `Download started: ${file.filename} (${file.count} requests). Nothing was sent. Share the file only with authorized recipients.` });
    } catch (error) {
      setFeedback({ error: true, message: error instanceof Error ? error.message : "The CSV could not be downloaded. Please try again." });
    }
  };

  return (
    <div className="flex max-w-md flex-col items-start gap-1 sm:items-end">
      <Button size="sm" onClick={exportCsv} disabled={!!reason} aria-describedby="request-export-feedback">
        <Download aria-hidden="true" /> Export CSV
      </Button>
      <p id="request-export-feedback" role={feedback?.error ? "alert" : "status"}
        className={feedback?.error ? "text-xs text-destructive sm:text-right" : "text-xs text-muted-foreground sm:text-right"}>
        {reason || feedback?.message || `${rows.length} visible requests · Download for manual sharing`}
      </p>
    </div>
  );
}