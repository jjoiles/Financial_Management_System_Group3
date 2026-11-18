import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Bell, Check, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useRequesterNotifications } from "@/lib/requester-notifications-data";
import { notificationStatusLabel } from "@/lib/requester-notifications";

export default function RequesterNotifications() {
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);
  const { notifications, loading, error, reload, markRead } = useRequesterNotifications();
  const unread = notifications.filter(row => !row.read_at).length;
  return (
    <Popover open={open} onOpenChange={value => { setOpen(value); if (value) void reload(); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className="relative shrink-0" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} title="Notifications">
          <Bell className="text-muted-foreground" />
          {unread > 0 && <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-0.5 text-[10px] font-bold text-destructive-foreground">{unread}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0" aria-label="Requester notifications">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Notifications</h2>
          <Button variant="ghost" size="icon" title="Refresh notifications" aria-label="Refresh notifications" disabled={loading} onClick={() => void reload()}><RefreshCw /></Button>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {loading && <p role="status" className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading notifications…</p>}
          {error && <p role="alert" className="p-4 text-xs text-destructive">{error}</p>}
          {!loading && !error && notifications.length === 0 && <p className="p-4 text-xs text-muted-foreground">No status updates yet.</p>}
          {notifications.map(row => (
            <div key={row.id} className={`flex items-start gap-2 border-b border-border px-4 py-3 ${row.read_at ? "" : "bg-primary/5"}`}>
              <div className="min-w-0 flex-1">
                <p className="break-words text-xs font-semibold">{row.request_number} · {notificationStatusLabel[row.new_status]}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{new Date(row.created_at).toLocaleString()}</p>
                <Button asChild variant="link" size="sm" className="mt-1 h-auto p-0 text-xs">
                  <Link to="/tracking" search={{ request: row.request_id }} onClick={() => setOpen(false)}>View request</Link>
                </Button>
              </div>
              {!row.read_at && <Button variant="ghost" size="icon" title="Mark as read" aria-label={`Mark ${row.request_number} ${notificationStatusLabel[row.new_status]} as read`} disabled={marking !== null} onClick={async () => {
                setMarking(row.id); try { await markRead(row); } finally { setMarking(null); }
              }}>{marking === row.id ? <Loader2 className="animate-spin" /> : <Check />}</Button>}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}