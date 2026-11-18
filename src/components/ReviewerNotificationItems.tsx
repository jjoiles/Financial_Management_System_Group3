import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Mail, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { REVIEWER_REASON_LABEL, type ReviewerNotification } from "@/lib/reviewer-notifications";

export default function ReviewerNotificationItems({ rows, loading, error, authorized, setRead, close }: {
  rows: ReviewerNotification[]; loading: boolean; error: string | null; authorized: boolean;
  setRead: (row: ReviewerNotification, read: boolean) => Promise<void>; close: () => void;
}) {
  const [marking, setMarking] = useState<string | null>(null);
  if (!authorized && !error) return null;
  return (
    <section aria-label="Reviewer updates" className="border-t border-border">
      <h3 className="px-4 pt-3 text-xs font-semibold">Reviewer updates</h3>
      {loading && <p role="status" className="p-4 text-xs text-muted-foreground">Loading reviewer updates…</p>}
      {error && <p role="alert" className="p-4 text-xs text-destructive">{error}</p>}
      {!error && !loading && rows.length === 0 && <p className="p-4 text-xs text-muted-foreground">No reviewer updates yet.</p>}
      {!error && rows.map(row => (
        <div key={row.id} className={`flex items-start gap-2 border-b border-border px-4 py-3 ${row.read_at ? "" : "bg-primary/5"}`}>
          <div className="min-w-0 flex-1">
            <p className="break-words text-xs font-semibold">{row.request_number} · {REVIEWER_REASON_LABEL[row.reason]}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{row.read_at ? "Read" : "Unread"} · {new Date(row.created_at).toLocaleString()}</p>
            <Button asChild variant="link" size="sm" className="mt-1 h-auto p-0 text-xs">
              <Link to="/requests" search={{ request: row.request_id }} onClick={close}>View request</Link>
            </Button>
          </div>
          <Button variant="ghost" size="icon" disabled={marking !== null}
            title={row.read_at ? "Mark as unread" : "Mark as read"}
            aria-label={`Mark ${row.request_number} reviewer update as ${row.read_at ? "unread" : "read"}`}
            onClick={async () => { setMarking(row.id); try { await setRead(row, !row.read_at); } finally { setMarking(null); } }}>
            {marking === row.id ? <Loader2 className="animate-spin" /> : row.read_at ? <Mail /> : <Check />}
          </Button>
        </div>
      ))}
    </section>
  );
}