import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Server, Shield, Bell, GitBranch, Github, Gitlab, Trash2 } from "lucide-react";
import { useGitAccounts } from "@/hooks/useGitAccounts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteGitAccount, updateGitAccountDisplayName } from "@/lib/git";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function Settings() {
  const queryClient = useQueryClient();

  const { data: githubAccounts = [] } = useGitAccounts("github", true);
  const { data: gitlabAccounts = [] } = useGitAccounts("gitlab", true);

  const [editingNames, setEditingNames] = useState<Record<string, string>>({});
  const [accountPendingDelete, setAccountPendingDelete] = useState<{
    id: string;
    providerLabel: "GitHub" | "GitLab";
    username: string;
  } | null>(null);

  const updateMutation = useMutation({
    mutationFn: async ({ id, displayName }: { id: string; displayName: string }) => {
      return updateGitAccountDisplayName(id, displayName);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["git", "github", "accounts"] });
      queryClient.invalidateQueries({ queryKey: ["git", "gitlab", "accounts"] });
      toast.success("Git account updated");
    },
    onError: (error: any) => {
      toast.error(error?.message || "Failed to update git account");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return deleteGitAccount(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["git", "github", "accounts"] });
      queryClient.invalidateQueries({ queryKey: ["git", "gitlab", "accounts"] });
      toast.success("Git account disconnected");
    },
    onError: (error: any) => {
      toast.error(error?.message || "Failed to disconnect git account");
    },
  });

  const allAccounts = [
    ...githubAccounts.map((acc) => ({ ...acc, providerLabel: "GitHub" as const })),
    ...gitlabAccounts.map((acc) => ({ ...acc, providerLabel: "GitLab" as const })),
  ];

  const handleNameChange = (id: string, value: string) => {
    setEditingNames((prev) => ({ ...prev, [id]: value }));
  };

  const handleSaveName = (id: string) => {
    const value = (editingNames[id] ?? "").trim();
    if (!value) {
      toast.error("Display name cannot be empty");
      return;
    }
    updateMutation.mutate({ id, displayName: value });
  };

  const handleDisconnect = (id: string, providerLabel: "GitHub" | "GitLab", username: string) => {
    setAccountPendingDelete({ id, providerLabel, username });
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
          Settings
        </h1>
        <p className="text-muted-foreground mt-1">
          Configure your deployment platform
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Server className="h-5 w-5 text-primary" />
              <span>Server Config</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Configure server settings, domains, and SSL</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Shield className="h-5 w-5 text-primary" />
              <span>Security</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Manage authentication and access controls</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-card border-border/50 hover:shadow-elegant transition-all duration-300">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Bell className="h-5 w-5 text-primary" />
              <span>Notifications</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Configure alerts and monitoring</p>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold flex items-center space-x-2">
              <GitBranch className="h-5 w-5 text-primary" />
              <span>Git Integrations</span>
            </h2>
            <p className="text-sm text-muted-foreground">
              Manage connected GitHub and GitLab accounts.
            </p>
          </div>
        </div>

        {allAccounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Git accounts connected yet. Connect from the Add App page when selecting a repository.
          </p>
        ) : (
          <div className="space-y-3">
            {allAccounts.map((account) => {
              const Icon = account.provider === "github" ? Github : Gitlab;
              const currentName =
                editingNames[account.id] ??
                account.displayName ??
                account.username ??
                account.id;

              return (
                <div
                  key={account.id}
                  className="flex items-center justify-between rounded-lg border border-border/60 bg-card/80 p-3 gap-3"
                >
                  <div className="flex items-center gap-3 flex-1">
                    <div className="p-2 rounded-full bg-muted flex items-center justify-center">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                          {account.providerLabel}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {account.username}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          value={currentName}
                          onChange={(e) =>
                            handleNameChange(account.id, e.target.value)
                          }
                          aria-label="Display name"
                          placeholder="Display name"
                          className="h-8 max-w-xs"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleSaveName(account.id)}
                          disabled={updateMutation.isPending}
                        >
                          Save
                        </Button>
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() =>
                      handleDisconnect(
                        account.id,
                        account.providerLabel,
                        account.username,
                      )
                    }
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                            <span className="sr-only">Disconnect account</span>
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        {accountPendingDelete && (
          <AlertDialog
            open={!!accountPendingDelete}
            onOpenChange={(open) => {
              if (!open) {
                setAccountPendingDelete(null);
              }
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect Git account</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to disconnect your{" "}
                  {accountPendingDelete.providerLabel} account{" "}
                  <span className="font-mono">
                    {accountPendingDelete.username}
                  </span>
                  ? You can reconnect later from the Add App page, but existing
                  deployments will keep using their configured repositories.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteMutation.isPending}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (accountPendingDelete) {
                      deleteMutation.mutate(accountPendingDelete.id, {
                        onSuccess: () => {
                          setAccountPendingDelete(null);
                        },
                        onError: () => {
                          setAccountPendingDelete(null);
                        },
                      });
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {deleteMutation.isPending ? "Disconnecting..." : "Disconnect"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}
