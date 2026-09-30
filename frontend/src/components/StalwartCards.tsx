import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Loader2, Lock, RefreshCw, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Column, DataTable, useTableQuery } from '@/components/DataTable';
import { useToast } from '@/hooks/use-toast';
import { getServers } from '@/lib/servers';
import {
  cancelMailQueue,
  getLogSenders,
  getMailQueue,
  getStalwartConfig,
  lockMailAccount,
  saveStalwartConfig,
  type LogSender,
  type QueueSender,
  type StalwartConfig,
} from '@/lib/stalwart';
import { t } from '@/lib/i18n';

const CONFIG_KEY = ['integrations', 'stalwart'];
const QUEUE_KEY = ['stalwart', 'queue'];

type Form = { baseUrl: string; username: string; password: string; serverId: string; logDir: string; alertThreshold: string };

/** Stalwart's admin URL and login, the node it runs on, and when a sender counts as a flood. */
export function StalwartSettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form | null>(null);
  const { data: status, isLoading } = useQuery({ queryKey: CONFIG_KEY, queryFn: getStalwartConfig });
  const { data: servers = [] } = useQuery({ queryKey: ['servers'], queryFn: getServers, enabled: !!form });

  const save = useMutation({
    mutationFn: (f: Form) =>
      saveStalwartConfig({ baseUrl: f.baseUrl, username: f.username, password: f.password, serverId: f.serverId, logDir: f.logDir, alertThreshold: Number(f.alertThreshold) }),
    onSuccess: (saved: StalwartConfig) => {
      queryClient.setQueryData(CONFIG_KEY, saved);
      void queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
      setForm(null);
      toast(saved.error ? { title: t('Saved, but Stalwart refused the call'), description: saved.error, variant: 'destructive' } : { title: t('Stalwart settings saved') });
    },
    onError: (error: Error) => toast({ title: t('Failed to save the Stalwart settings'), description: error.message, variant: 'destructive' }),
  });

  const connected = status?.passwordSet && !status.error;
  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Stalwart</span>
          <Badge variant={connected ? 'default' : 'outline'}>{connected ? t('Connected') : status?.passwordSet ? t('Not reachable') : t('Not configured')}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">URL</span>
              <span className="font-mono break-all">{status?.baseUrl || '—'}</span>
              <span className="text-muted-foreground">{t('Admin')}</span>
              <span>{status?.username || '—'}</span>
              <span className="text-muted-foreground">{t('Node')}</span>
              <span>{status?.server?.name ?? '—'}</span>
              <span className="text-muted-foreground">{t('Log folder')}</span>
              <span className="font-mono">{status?.logDir}</span>
              <span className="text-muted-foreground">{t('Alert at')}</span>
              <span>{t('{count} queued from one sender', { count: status?.alertThreshold ?? 0 })}</span>
              {status?.error && (
                <>
                  <span className="text-muted-foreground">{t('Error')}</span>
                  <span className="text-destructive">{status.error}</span>
                </>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setForm({
                  baseUrl: status?.baseUrl ?? '',
                  username: status?.username ?? '',
                  password: '',
                  serverId: status?.server?.id ?? '',
                  logDir: status?.logDir ?? '/var/log/stalwart',
                  alertThreshold: String(status?.alertThreshold ?? 500),
                })
              }
            >
              {t('Edit')}
            </Button>
          </>
        )}
      </CardContent>

      <Dialog open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stalwart</DialogTitle>
            <DialogDescription>{t("Stalwart's admin URL and an administrator login. Stored encrypted; saving checks it with one call.")}</DialogDescription>
          </DialogHeader>
          {form && (
            <form
              id="stalwart-settings"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(form);
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="stalwart-url">URL</Label>
                <Input id="stalwart-url" className="font-mono" placeholder="https://mail.example.com" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="stalwart-user">{t('Admin user')}</Label>
                  <Input id="stalwart-user" autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="stalwart-password">{t('Password')}</Label>
                  <Input
                    id="stalwart-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder={status?.passwordSet ? t('Leave blank to keep the current one') : ''}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>{t('Node Stalwart runs on')}</Label>
                <Select value={form.serverId || undefined} onValueChange={(serverId) => setForm({ ...form, serverId })}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('Pick a node to read its log')} />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name} <span className="text-muted-foreground">({s.publicIp})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="stalwart-logdir">{t('Log folder')}</Label>
                  <Input id="stalwart-logdir" className="font-mono" value={form.logDir} onChange={(e) => setForm({ ...form, logDir: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="stalwart-threshold">{t('Alert at (queued from one sender)')}</Label>
                  <Input id="stalwart-threshold" type="number" min={1} value={form.alertThreshold} onChange={(e) => setForm({ ...form, alertThreshold: e.target.value })} />
                </div>
              </div>
            </form>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={save.isPending}>
              {t('Cancel')}
            </Button>
            <Button type="submit" form="stalwart-settings" disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('Save changes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Lock the account and cancel its queue, each confirmed first. */
function SenderActions({ sender }: { sender: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<'lock' | 'cancel' | null>(null);
  const lock = useMutation({
    mutationFn: () => lockMailAccount(sender),
    onSuccess: () => toast({ title: t('{email} is locked', { email: sender }), description: t('Nothing can log in as it any more. Its mail stays.') }),
    onError: (error: Error) => toast({ title: t('Could not lock the account'), description: error.message, variant: 'destructive' }),
  });
  const cancel = useMutation({
    mutationFn: () => cancelMailQueue(sender),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: QUEUE_KEY });
      toast({ title: t('{count} message(s) cancelled', { count: r.cancelled }) });
    },
    onError: (error: Error) => toast({ title: t('Could not cancel the queue'), description: error.message, variant: 'destructive' }),
  });
  // a bounce (<>) has no account to lock
  const canLock = sender.includes('@');
  return (
    <div className="flex justify-end gap-1">
      {canLock && (
        <Button size="sm" variant="outline" onClick={() => setConfirm('lock')} disabled={lock.isPending}>
          {lock.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Lock className="mr-1 h-3.5 w-3.5" />}
          {t('Lock')}
        </Button>
      )}
      <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirm('cancel')} disabled={cancel.isPending}>
        {cancel.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Ban className="mr-1 h-3.5 w-3.5" />}
        {t('Cancel queue')}
      </Button>
      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === 'lock' ? t('Lock {email}?', { email: sender }) : t('Cancel the queue of {email}?', { email: sender })}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'lock'
                ? t('Every password, app password and API key of this account is removed, so nobody can log in or send as it. Its mailbox stays. If an app manages this mailbox and syncs its password, deactivate it there too, or the sync sets the old password back.')
                : t('Every message from this sender still waiting to go out is deleted and will not be delivered. Lock the account first, or new ones keep coming.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => (confirm === 'lock' ? lock.mutate() : cancel.mutate())}
            >
              {confirm === 'lock' ? t('Lock account') : t('Cancel messages')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** What is waiting to go out, by sender: a leaked password shows as one account with thousands, handed in from many IPs. */
export function MailQueueCard() {
  const query = useTableQuery(10);
  const { data: config } = useQuery({ queryKey: CONFIG_KEY, queryFn: getStalwartConfig });
  const { data, isFetching, refetch, error } = useQuery({ queryKey: QUEUE_KEY, queryFn: getMailQueue, enabled: !!config?.passwordSet && !config.error });
  const threshold = config?.alertThreshold ?? 500;

  const columns: Column<QueueSender>[] = [
    {
      header: t('Sender'),
      className: 'w-[34%]',
      cell: (s) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{s.sender}</span>
          {s.messages >= threshold && <Badge variant="destructive">{t('Flood')}</Badge>}
        </span>
      ),
    },
    { header: t('Messages'), className: 'w-24 text-right', cell: (s) => <span className="tabular-nums">{s.messages.toLocaleString()}</span> },
    { header: t('Recipients'), className: 'w-24 text-right', cell: (s) => <span className="tabular-nums">{s.recipients.toLocaleString()}</span> },
    {
      header: t('Handed in from'),
      cell: (s) => (
        <span className="block truncate font-mono text-xs text-muted-foreground" title={s.ips.map((i) => `${i.ip} (${i.messages})`).join('\n')}>
          {s.ips.map((i) => `${i.ip} (${i.messages})`).join(', ') || '—'}
        </span>
      ),
    },
    { header: <span className="sr-only">{t('Actions')}</span>, className: 'w-64', cell: (s) => <SenderActions sender={s.sender} /> },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t('Outgoing queue')}
          {data && <span className="ml-2 text-sm font-normal text-muted-foreground">{t('{count} waiting', { count: data.total.toLocaleString() })}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error && <p className="mb-3 text-sm text-destructive">{(error as Error).message}</p>}
        <DataTable
          columns={columns}
          rows={data?.senders ?? []}
          rowKey={(s) => s.sender}
          query={query}
          filter={(s, search) => s.sender.toLowerCase().includes(search.toLowerCase())}
          isLoading={isFetching && !data}
          searchPlaceholder={t('Search senders…')}
          empty={config?.passwordSet ? t('The queue is empty.') : t('Connect Stalwart first.')}
          toolbar={
            <Button size="sm" variant="outline" onClick={() => void refetch()} disabled={isFetching || !config?.passwordSet}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} /> {t('Refresh')}
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}

/** One day of the log, counted on the node: who sent how much, to how many. */
export function LogSendersCard() {
  const query = useTableQuery(10);
  const { data: config } = useQuery({ queryKey: CONFIG_KEY, queryFn: getStalwartConfig });
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const read = useMutation({ mutationFn: () => getLogSenders(day) });

  const columns: Column<LogSender>[] = [
    { header: t('Sender'), cell: (s) => <span className="truncate font-medium">{s.sender}</span> },
    { header: t('Messages'), className: 'w-28 text-right', cell: (s) => <span className="tabular-nums">{s.messages.toLocaleString()}</span> },
    { header: t('Recipients'), className: 'w-28 text-right', cell: (s) => <span className="tabular-nums">{s.recipients.toLocaleString()}</span> },
    { header: t('Log lines'), className: 'w-28 text-right', cell: (s) => <span className="tabular-nums text-muted-foreground">{s.lines.toLocaleString()}</span> },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Senders in the log')}</CardTitle>
      </CardHeader>
      <CardContent>
        {!config?.server ? (
          <p className="text-sm text-muted-foreground">{t('Pick the node Stalwart runs on in the settings above to read its log.')}</p>
        ) : (
          <>
            {read.error && <p className="mb-3 text-sm text-destructive">{(read.error as Error).message}</p>}
            <DataTable
              columns={columns}
              rows={read.data ?? []}
              rowKey={(s) => s.sender}
              query={query}
              filter={(s, search) => s.sender.toLowerCase().includes(search.toLowerCase())}
              isLoading={read.isPending}
              searchPlaceholder={t('Search senders…')}
              empty={read.data ? t('Nobody sent anything that day.') : t('Pick a day and read its log. A flooded day is gigabytes: it can take a minute.')}
              toolbar={
                <div className="flex items-center gap-2">
                  <Input type="date" className="w-40" value={day} onChange={(e) => setDay(e.target.value)} />
                  <Button size="sm" variant="outline" onClick={() => read.mutate()} disabled={read.isPending || !day}>
                    {read.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                    {t('Read log')}
                  </Button>
                </div>
              }
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
