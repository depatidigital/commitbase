import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Globe,
  ArrowLeft,
  GitBranch,
  Terminal,
  Zap,
  CheckCircle,
  AlertCircle,
  Github,
  Gitlab,
  Lock,
  Search,
  Upload,
  FileCode,
  Server,
  Check,
  ChevronsUpDown,
} from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useCreateApplication } from "@/hooks/useApplications";
import { AppLaunchProgress } from "@/components/AppLaunchProgress";
import { SourcePicker } from "@/components/SourcePicker";
import { useDomains } from "@/hooks/useDomains";
import { PageLayout } from "@/components/PageLayout";
import {
  CreateApplicationData,
  DetectedProject,
  detectProject,
  readDetectFiles,
  uploadApplicationSource,
  startApplication,
  listRepositoryBranches,
  type DnsOutcome,
  type UploadEntry,
} from "@/lib/applications";
import { getGithubAuthUrl, getGitlabAuthUrl, listGitRepositories, type GitRepositoryListing } from "@/lib/git";
import { t } from "@/lib/i18n";
import { isSuperAdmin } from "@/lib/auth";
import { getServers } from "@/lib/servers";

const PENDING_REPOSITORY = "addApp.pendingRepository";
// what the backend accepts as a repository (projectDetect.ts REPOSITORY_URL)
const REPOSITORY_URL = /^(https?:\/\/|git@|ssh:\/\/)[^\s'"]+$/;

export default function AddApp() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const createApp = useCreateApplication();
  const {
    data: domains,
    isLoading: domainsLoading,
    error: domainsError,
  } = useDomains();

  const [formData, setFormData] = useState({
    name: "",
    selectedDomain: "",
    subdomain: "",
    type: "",
    repository: "",
    branch: "main",
    buildCommand: "",
    startCommand: "",
    port: "",
    envVars: "",
  });
  // 1 = where the code comes from, 2 = type, name and domain
  const [step, setStep] = useState(1);
  // Which node the app runs on. Only a superadmin picks; "" = the org's default server.
  const superadmin = isSuperAdmin();
  const [serverId, setServerId] = useState("");
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: getServers, enabled: superadmin });
  // set once the app exists — the wizard turns into a progress view rather than
  // dumping the user on the dashboard while the deploy is still running
  const [launch, setLaunch] = useState<{
    id: string;
    domain: string;
    dns?: DnsOutcome;
    uploading: boolean;
    uploadFailed: string | null;
  } | null>(null);
  const [sourceMode, setSourceMode] = useState<"git" | "upload">("git");
  // everything picked, and the paths unticked in the preview; what detection
  // and the upload see is the difference
  const [pickedFiles, setPickedFiles] = useState<UploadEntry[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const uploadFiles = useMemo(
    () => pickedFiles.filter(({ path }) => !excluded.has(path)),
    [pickedFiles, excluded],
  );
  const setUploadFiles = (entries: UploadEntry[]) => {
    setPickedFiles(entries);
    setExcluded(new Set());
  };
  const [domainOpen, setDomainOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");
  // every repo the connected accounts can see — cmdk searches the list locally
  const repoListing = useQuery({
    queryKey: ["git", "repositories"],
    queryFn: listGitRepositories,
    enabled: sourceMode === "git",
    staleTime: 60_000,
  });
  const repoGroups = useMemo(() => {
    const groups = new Map<string, { key: string; heading: string; repositories: GitRepositoryListing["repositories"] }>();
    for (const repo of repoListing.data?.repositories ?? []) {
      const group = groups.get(repo.accountId) ?? {
        key: repo.accountId,
        heading: `${repo.provider === "github" ? "GitHub" : "GitLab"} · ${repo.account}`,
        repositories: [],
      };
      group.repositories.push(repo);
      groups.set(repo.accountId, group);
    }
    return [...groups.values()];
  }, [repoListing.data]);
  // the chosen repository, when it came from the list — shown by name, not URL
  const pickedRepo = repoListing.data?.repositories.find((repo) => repo.cloneUrl === formData.repository);
  const [detected, setDetected] = useState<DetectedProject | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState("");

  // an empty subdomain means the root domain
  const fullDomain = formData.subdomain
    ? `${formData.subdomain}.${formData.selectedDomain}`
    : formData.selectedDomain;

  // The domain is picked first and the app name follows it until the user
  // edits the name — the name is only a label, so it may then differ.
  const [nameTouched, setNameTouched] = useState(false);
  useEffect(() => {
    if (!nameTouched) {
      setFormData((prev) => ({
        ...prev,
        name: prev.selectedDomain ? fullDomain : "",
      }));
    }
  }, [fullDomain, nameTouched]);

  // A pasted URL: read its branches and switch to the default one (not every
  // repo uses "main"). null = not read, which leaves the branch as free text.
  const [remoteBranches, setRemoteBranches] = useState<string[] | null>(null);
  const [remoteDefault, setRemoteDefault] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState("");
  // A private repo is read — and later cloned — through whichever of the
  // user's connected accounts can see it; the backend finds that account.
  const [manualAccountId, setManualAccountId] = useState<string | null>(null);
  const [needsAccount, setNeedsAccount] = useState<{ provider: "github" | "gitlab"; tried: number } | null>(null);
  const gitSource = sourceMode === "git";
  useEffect(() => {
    setRemoteBranches(null);
    setBranchesError("");
    setManualAccountId(null);
    setNeedsAccount(null);
    const url = formData.repository.trim();
    if (!gitSource || !url) return;

    let cancelled = false;
    // shorter than detection's 800ms, so detection sees the lookup start and waits
    const timer = setTimeout(async () => {
      setBranchesLoading(true);
      try {
        const { defaultBranch, branches, gitAccountId, needsAccount, triedAccounts } =
          await listRepositoryBranches(url);
        if (cancelled) return;
        if (needsAccount) {
          setNeedsAccount({ provider: needsAccount, tried: triedAccounts ?? 0 });
          return;
        }
        setManualAccountId(gitAccountId);
        setRemoteBranches(branches);
        setRemoteDefault(defaultBranch);
        setFormData((prev) => ({
          ...prev,
          branch: defaultBranch || branches[0] || prev.branch,
        }));
      } catch (error) {
        if (!cancelled)
          setBranchesError(error instanceof Error ? error.message : "");
      } finally {
        if (!cancelled) setBranchesLoading(false);
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setBranchesLoading(false);
    };
  }, [gitSource, formData.repository]);

  // Auto-detect the framework from the source (Vercel-style) and prefill the
  // build settings. Everything stays editable.
  useEffect(() => {
    const isGit = sourceMode === "git";
    // wait for the branch lookup — detecting "main" on a "master" repo just fails
    if (isGit && branchesLoading) return;
    // a repository nobody could read yet would only fail detection too
    const canDetect = isGit ? !!remoteBranches?.length : uploadFiles.length > 0;
    if (!canDetect) {
      setDetected(null);
      setDetectError("");
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setDetecting(true);
      setDetectError("");
      try {
        const result = isGit
          ? await detectProject({
              repository: formData.repository.trim(),
              branch: formData.branch || "main",
              gitAccountId: (gitSource && manualAccountId) || undefined,
            })
          : await detectProject({ files: await readDetectFiles(uploadFiles) });
        if (cancelled) return;
        setDetected(result);
        setFormData((prev) => ({
          ...prev,
          // an unrecognised project leaves the type blank, so the user has
          // to pick one instead of deploying a wrong guess
          type:
            result.framework === null
              ? ""
              : result.type === "PYTHON"
                ? "NODEJS"
                : result.type,
          buildCommand: result.buildCommand || "",
          startCommand: result.startCommand || "",
        }));
      } catch (error) {
        if (!cancelled) {
          setDetectError(
            error instanceof Error ? error.message : t("Detection failed"),
          );
          // whatever an earlier source detected no longer applies
          setFormData((prev) => ({ ...prev, type: "" }));
        }
      } finally {
        if (!cancelled) setDetecting(false);
      }
    }, isGit ? 800 : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode, formData.repository, formData.branch, uploadFiles, branchesLoading, manualAccountId, remoteBranches]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Enter on an earlier step must not fire the deploy
    if (step < 2) return;

    // Parse environment variables
    const envVars: Record<string, string> = {};
    if (formData.envVars) {
      formData.envVars.split("\n").forEach((line) => {
        const [key, ...valueParts] = line.split("=");
        if (key && valueParts.length > 0) {
          envVars[key.trim()] = valueParts.join("=").trim();
        }
      });
    }

    const applicationData: CreateApplicationData = {
      name: formData.name,
      domain: fullDomain,
      type: formData.type as CreateApplicationData["type"],
      repository:
        sourceMode === "git" ? formData.repository || undefined : undefined,
      // Which connected account clones it: the one the branch lookup found
      // can read this repo. None for a public repo or an upload.
      gitAccountId: (sourceMode === "git" && manualAccountId) || undefined,
      branch: formData.branch,
      buildCommand: formData.buildCommand || undefined,
      startCommand: formData.startCommand || undefined,
      port: formData.port ? parseInt(formData.port) : undefined,
      envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
      serverId: serverId || undefined,
    };

    try {
      const created = await createApp.mutateAsync(applicationData);
      const needsUpload = sourceMode === "upload" && uploadFiles.length > 0;

      setLaunch({
        id: created.id,
        domain: fullDomain,
        dns: created.dns,
        uploading: needsUpload,
        uploadFailed: null,
      });

      if (needsUpload) {
        try {
          await uploadApplicationSource(created.id, uploadFiles);
          setLaunch((prev) => (prev ? { ...prev, uploading: false } : prev));
        } catch (error) {
          setLaunch((prev) =>
            prev
              ? {
                  ...prev,
                  uploading: false,
                  uploadFailed:
                    error instanceof Error ? error.message : t("Upload failed"),
                }
              : prev,
          );
          return;
        }
      }

      // A static upload is already served from its bucket; everything else has
      // to be built and started, which the wizard now kicks off itself.
      if (formData.type !== "STATIC") {
        await startApplication(created.id).catch((error: Error) =>
          toast({
            variant: "destructive",
            title: t("Deployment did not start"),
            description: error.message,
          }),
        );
      }
    } catch (error) {
      // createApp reports its own failures; an upload failure would otherwise be silent
      if (error instanceof Error && error.message.includes("upload")) {
        toast({
          variant: "destructive",
          title: t("Upload failed"),
          description: error.message,
        });
      }
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const appTypeOptions = [
    {
      value: "STATIC",
      label: t("Static site"),
      description: t("HTML, CSS and JS files served from object storage."),
      icon: Globe,
    },
    {
      value: "PHP",
      label: "PHP",
      description: t("PHP application served by the platform runtime."),
      icon: FileCode,
    },
    {
      value: "NODEJS",
      label: "Node.js",
      description: t("Node app built and run as a service on the server."),
      icon: Server,
    },
  ];

  // no type step: detection fills it from the source, and it is corrected
  // on the configure step next to the detection result
  const steps = [t("Source"), t("Configure")];

  const stepComplete = (value: number) => {
    if (value === 1)
      return sourceMode === "upload"
        ? uploadFiles.length > 0
        : // read, public or through an account, and has a branch to deploy
          !!remoteBranches?.length;
    return !!formData.name && !!formData.selectedDomain && !!formData.type;
  };

  const availableDomains =
    domains?.filter((domain) => domain.status === "ACTIVE") || [];
  // The OAuth round trip reloads the page; keep the pasted URL across it.
  const rememberRepository = () => {
    if (formData.repository.trim()) sessionStorage.setItem(PENDING_REPOSITORY, formData.repository.trim());
  };
  useEffect(() => {
    const pending = sessionStorage.getItem(PENDING_REPOSITORY);
    if (!pending) return;
    sessionStorage.removeItem(PENDING_REPOSITORY);
    setFormData((prev) => ({ ...prev, repository: pending }));
  }, []);

  const handleConnectGithub = async () => {
    rememberRepository();
    try {
      const url = await getGithubAuthUrl();
      window.location.href = url;
    } catch (error) {
      const message =
        error instanceof Error && error.message === "GitHub OAuth is not configured"
          ? t("GitHub OAuth is not configured on the server. Please set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.")
          : t("Could not start GitHub OAuth flow.");
      toast({
        variant: "destructive",
        title: t("GitHub connection failed"),
        description: message,
      });
    }
  };

  const handleConnectGitlab = async () => {
    rememberRepository();
    try {
      const url = await getGitlabAuthUrl();
      window.location.href = url;
    } catch (error) {
      const message =
        error instanceof Error && error.message === "GitLab OAuth is not configured"
          ? t("GitLab OAuth is not configured on the server. Please set GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET.")
          : t("Could not start GitLab OAuth flow.");
      toast({
        variant: "destructive",
        title: t("GitLab connection failed"),
        description: message,
      });
    }
  };

  // deploy fired: the wizard is done, the setup is not
  if (launch) {
    return (
      <PageLayout
        title={t("Deploying")}
        description={t("{domain} is being set up.", { domain: launch.domain })}
        icon={Zap}
        backTo="/"
      >
        <AppLaunchProgress
          applicationId={launch.id}
          domain={launch.domain}
          dns={launch.dns}
          uploading={launch.uploading}
          uploadFailed={launch.uploadFailed}
        />
      </PageLayout>
    );
  }

  if (domainsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center space-y-4">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-current border-t-transparent" />
          <p className="text-sm text-muted-foreground">{t("Loading domains...")}</p>
        </div>
      </div>
    );
  }

  if (domainsError) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">{t("Error Loading Domains")}</h3>
          <p className="text-muted-foreground">
            {t("Failed to load domains. Please try again.")}
          </p>
        </div>
      </div>
    );
  }

  if (availableDomains.length === 0) {
    return (
      <div className="max-w-4xl mx-auto space-y-8 animate-fade-in">
        <div className="flex items-center space-x-4">
          <Button
            variant="ghost"
            onClick={() => navigate("/")}
            className="hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("Back to Apps")}
          </Button>
        </div>

        <Card className="bg-gradient-card border-border/50">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Globe className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">{t("No Active Domains")}</h3>
            <p className="text-muted-foreground text-center max-w-md mb-4">
              {t(
                "You need to have at least one active domain to deploy applications. Please add a domain first.",
              )}
            </p>
            <Button
              onClick={() => navigate("/domains")}
              className="bg-gradient-primary"
            >
              <Globe className="h-4 w-4 mr-2" />
              {t("Manage Domains")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <PageLayout
      backTo="/"
      title={t("Add App")}
      description={t("Point at the code, then name it — the type is detected.")}
    >
      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Wizard progress */}
        <ol className="flex flex-wrap items-center gap-2 text-sm">
          {steps.map((label, index) => {
            const value = index + 1;
            return (
              <li key={label} className="flex items-center gap-2">
                <button
                  type="button"
                  // only step back — moving forward has to pass the checks below
                  onClick={() => value < step && setStep(value)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-1 ${
                    value === step
                      ? "border-primary bg-primary/10 font-medium text-primary"
                      : value < step
                        ? "border-border/60 text-muted-foreground hover:border-primary/40"
                        : "border-border/40 text-muted-foreground/60"
                  }`}
                >
                  <span className="font-mono text-xs">{value}</span>
                  {label}
                </button>
                {index < steps.length - 1 && (
                  <span className="text-muted-foreground/50">/</span>
                )}
              </li>
            );
          })}
        </ol>

        {step === 1 && (
          <>
            <Card className="bg-gradient-card border-border/50 shadow-elegant">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <GitBranch className="h-5 w-5 text-primary" />
                  <span>{t("Where does the code come from?")}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setSourceMode("git")}
                    className={`rounded-lg border p-4 text-left transition-colors ${
                      sourceMode === "git"
                        ? "border-primary bg-primary/5"
                        : "border-border/60 hover:border-primary/40"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-medium">
                      <GitBranch className="h-4 w-4 text-primary" />
                      {t("Git repository")}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("Clone from GitHub, GitLab, or any repository URL.")}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSourceMode("upload")}
                    className={`rounded-lg border p-4 text-left transition-colors ${
                      sourceMode === "upload"
                        ? "border-primary bg-primary/5"
                        : "border-border/60 hover:border-primary/40"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-medium">
                      <Upload className="h-4 w-4 text-primary" />
                      {t("Upload files or folder")}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("Send files straight from this machine. No repository needed.")}
                    </p>
                  </button>
                </div>

                {sourceMode === "upload" && (
                  <div className="space-y-4">
                    <SourcePicker
                      picked={pickedFiles}
                      excluded={excluded}
                      onPick={setUploadFiles}
                      onExcludedChange={setExcluded}
                    />
                    {formData.type === "STATIC" && (
                      <p className="text-xs text-muted-foreground">
                        {t(
                          "Static uploads go straight to object storage and are served from there — nothing is built.",
                        )}
                      </p>
                    )}
                  </div>
                )}

                {sourceMode === "git" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="repository">{t("Repository")}</Label>
                      {/* one field: pick from the connected accounts, or paste any URL into its search */}
                      <Popover
                        open={repoOpen}
                        onOpenChange={(open) => {
                          setRepoOpen(open);
                          if (!open) setRepoSearch("");
                        }}
                      >
                        <PopoverTrigger asChild>
                          <Button
                            id="repository"
                            type="button"
                            variant="outline"
                            role="combobox"
                            aria-expanded={repoOpen}
                            className="w-full justify-between bg-card font-normal"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              {pickedRepo ? (
                                pickedRepo.provider === "github" ? (
                                  <Github className="h-4 w-4 shrink-0" />
                                ) : (
                                  <Gitlab className="h-4 w-4 shrink-0" />
                                )
                              ) : (
                                <Search className="h-4 w-4 shrink-0 opacity-50" />
                              )}
                              <span className={`truncate ${formData.repository ? "" : "text-muted-foreground"}`}>
                                {pickedRepo?.fullName || formData.repository || t("Select a repository or paste a URL")}
                              </span>
                            </span>
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[--radix-popover-trigger-width] max-w-[calc(100vw-2rem)] p-0" align="start">
                          <Command>
                            <CommandInput
                              placeholder={t("Search your repositories, or paste a Git URL…")}
                              value={repoSearch}
                              onValueChange={setRepoSearch}
                            />
                            <CommandList>
                              {/* a pasted URL is always offered, whatever the list filter says */}
                              {REPOSITORY_URL.test(repoSearch.trim()) && (
                                <CommandGroup>
                                  <CommandItem
                                    forceMount
                                    value={`url:${repoSearch.trim()}`}
                                    onSelect={() => {
                                      handleInputChange("repository", repoSearch.trim());
                                      setRepoOpen(false);
                                      setRepoSearch("");
                                    }}
                                  >
                                    <GitBranch className="mr-2 h-4 w-4 shrink-0" />
                                    <span className="truncate">
                                      {t("Use this URL: {url}", { url: repoSearch.trim() })}
                                    </span>
                                  </CommandItem>
                                </CommandGroup>
                              )}
                              {repoListing.isLoading ? (
                                <p className="p-4 text-sm text-muted-foreground">{t("Loading repositories…")}</p>
                              ) : (
                                !REPOSITORY_URL.test(repoSearch.trim()) && (
                                  <CommandEmpty>
                                    {repoListing.data?.accounts.length
                                      ? t("No repositories found — paste the URL instead.")
                                      : t("No GitHub or GitLab account connected. Connect one below, or paste a public repository URL.")}
                                  </CommandEmpty>
                                )
                              )}
                              {repoGroups.map(({ key, heading, repositories }) => (
                                <CommandGroup key={key} heading={heading}>
                                  {repositories.map((repo) => (
                                    <CommandItem
                                      key={`${repo.accountId}:${repo.fullName}`}
                                      value={`${repo.fullName} ${repo.accountId}`}
                                      onSelect={() => {
                                        handleInputChange("repository", repo.cloneUrl);
                                        setRepoOpen(false);
                                        setRepoSearch("");
                                      }}
                                    >
                                      <Check
                                        className={`mr-2 h-4 w-4 shrink-0 ${
                                          formData.repository === repo.cloneUrl ? "opacity-100" : "opacity-0"
                                        }`}
                                      />
                                      <span className="flex-1 truncate">{repo.fullName}</span>
                                      {repo.private && <Lock className="ml-2 h-3 w-3 shrink-0 text-muted-foreground" />}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              ))}
                            </CommandList>
                          </Command>
                          {!!repoListing.data?.errors.length && (
                            <p className="border-t px-3 py-2 text-xs text-destructive">
                              {repoListing.data.errors.join(" · ")}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-1 border-t p-2">
                            <Button type="button" variant="ghost" size="sm" onClick={handleConnectGithub}>
                              <Github className="h-4 w-4 mr-2" />
                              {t("Connect GitHub")}
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={handleConnectGitlab}>
                              <Gitlab className="h-4 w-4 mr-2" />
                              {t("Connect GitLab")}
                            </Button>
                          </div>
                        </PopoverContent>
                      </Popover>
                      {branchesLoading ? (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="animate-spin rounded-full h-3 w-3 border-2 border-current border-t-transparent" />
                          {t("Checking the repository…")}
                        </p>
                      ) : branchesError ? (
                        <p className="flex items-center gap-1.5 text-xs text-destructive">
                          <AlertCircle className="h-3 w-3" />
                          {t("This repository cannot be read. Check the URL — a private repository has to be on GitHub or GitLab.")}
                        </p>
                      ) : manualAccountId ? (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Lock className="h-3 w-3" />
                          {t("Private repository — read and deployed through your connected account.")}
                        </p>
                      ) : null}
                    </div>

                    {needsAccount && (
                      <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
                        <p className="flex items-center gap-1.5 text-sm font-medium">
                          <Lock className="h-4 w-4" />
                          {t("Private repository")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {needsAccount.tried > 0
                            ? t("None of your connected {provider} accounts can read this repository. Connect an account that has access, or check the URL.", {
                                provider: needsAccount.provider === "github" ? "GitHub" : "GitLab",
                              })
                            : t("This repository is private or does not exist. Connect {provider} so it can be read and deployed.", {
                                provider: needsAccount.provider === "github" ? "GitHub" : "GitLab",
                              })}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={needsAccount.provider === "github" ? handleConnectGithub : handleConnectGitlab}
                        >
                          {needsAccount.provider === "github" ? (
                            <Github className="h-4 w-4 mr-2" />
                          ) : (
                            <Gitlab className="h-4 w-4 mr-2" />
                          )}
                          {needsAccount.provider === "github" ? t("Connect GitHub") : t("Connect GitLab")}
                        </Button>
                      </div>
                    )}

                    {/* only once the repository has been read — the branches come from it */}
                    {remoteBranches && (
                    <div className="space-y-2">
                      <Label htmlFor="branch">{t("Branch")}</Label>
                      {remoteBranches.length > 0 ? (
                        <Select
                          value={formData.branch}
                          onValueChange={(value) =>
                            handleInputChange("branch", value)
                          }
                        >
                          <SelectTrigger id="branch">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {remoteBranches.map((branch) => (
                              <SelectItem key={branch} value={branch}>
                                {branch}
                                {branch === remoteDefault && (
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    {t("default")}
                                  </span>
                                )}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {t("This repository has no branches yet — push a commit first.")}
                        </p>
                      )}
                    </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {step === 2 && (
          <>
            {/* one card: domain first, then the name it prefills, then the
                type — which lives next to what detection guessed, so a wrong
                guess is fixed where it is shown */}
            <Card className="bg-gradient-card border-border/50 shadow-elegant">
              <CardContent className="space-y-5 pt-6">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="subdomain">
                      {t("Domain Configuration")}{" "}
                      <span className="text-red-500">*</span>
                    </Label>
                    <div className="flex items-center gap-2">
                      <Globe className="min-w-4 min-h-4 text-muted-foreground" />
                      <Input
                        id="subdomain"
                        placeholder="app"
                        value={formData.subdomain}
                        onChange={(e) =>
                          handleInputChange("subdomain", e.target.value.trim().toLowerCase())
                        }
                      />
                      <span className="text-muted-foreground">.</span>
                      <Popover open={domainOpen} onOpenChange={setDomainOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            id="domain-select"
                            type="button"
                            variant="outline"
                            role="combobox"
                            aria-expanded={domainOpen}
                            aria-invalid={!formData.selectedDomain}
                            // red until picked — the deploy button stays disabled without it
                            className={`w-full justify-between bg-card font-normal ${
                              formData.selectedDomain
                                ? ""
                                : "border-destructive text-destructive hover:text-destructive"
                            }`}
                          >
                            <span className="truncate">
                              {formData.selectedDomain || t("Select a domain")}
                            </span>
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-72 p-0" align="end">
                          {/* the whole list is already loaded, so cmdk filters it locally */}
                          <Command>
                            <CommandInput placeholder={t("Search domains…")} />
                            <CommandList>
                              <CommandEmpty>{t("No domains found.")}</CommandEmpty>
                              <CommandGroup>
                                {availableDomains.map((domain) => {
                                  const apps = domain._count?.applications ?? 0;
                                  return (
                                    <CommandItem
                                      key={domain.id}
                                      value={domain.name}
                                      onSelect={() => {
                                        handleInputChange("selectedDomain", domain.name);
                                        setDomainOpen(false);
                                      }}
                                    >
                                      <Check
                                        className={`mr-2 h-4 w-4 shrink-0 ${
                                          formData.selectedDomain === domain.name
                                            ? "opacity-100"
                                            : "opacity-0"
                                        }`}
                                      />
                                      <span className="flex-1 truncate">{domain.name}</span>
                                      <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                                        {apps === 0
                                          ? t("Unused")
                                          : apps === 1
                                            ? t("{count} app", { count: apps })
                                            : t("{count} apps", { count: apps })}
                                      </span>
                                    </CommandItem>
                                  );
                                })}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                    {/* the result and the hint on one line */}
                    <p className="text-xs text-muted-foreground">
                      {formData.selectedDomain && (
                        <>
                          <span className="font-mono text-foreground">{fullDomain}</span>
                          {" · "}
                        </>
                      )}
                      {t("Leave the subdomain empty to use the root domain.")}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="name">
                      {t("App Name")} <span className="text-red-500">*</span>
                    </Label>
                    <Input
                      id="name"
                      placeholder={t("Filled from the domain")}
                      value={formData.name}
                      onChange={(e) => {
                        setNameTouched(true);
                        handleInputChange("name", e.target.value);
                      }}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("Follows the domain — change it for a friendlier label.")}
                    </p>
                  </div>
                </div>

                {superadmin && (
                  <div className="space-y-2">
                    <Label htmlFor="server">{t("Server")}</Label>
                    <Select value={serverId || "__default"} onValueChange={(v) => setServerId(v === "__default" ? "" : v)}>
                      <SelectTrigger id="server" className="max-w-md">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__default">{t("Organization's default server")}</SelectItem>
                        {servers.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name} ({s.status})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {t("Fixed once the app exists.")}
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  {/* what detection found sits on the heading line */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Label>
                      {t("App type")} <span className="text-red-500">*</span>
                    </Label>
                    {detecting ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="animate-spin rounded-full h-3 w-3 border-2 border-current border-t-transparent" />
                        {t("Inspecting the project…")}
                      </span>
                    ) : detectError ? (
                      <span className="flex items-center gap-1.5 text-xs text-destructive">
                        <AlertCircle className="h-3.5 w-3.5" />
                        {t("{error} — fill the build settings by hand.", {
                          error: detectError,
                        })}
                      </span>
                    ) : detected ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <CheckCircle className="h-3.5 w-3.5 text-primary" />
                        {t("Detected: {label}", { label: detected.label })}
                        {" · "}
                        {detected.packageManager}
                        {detected.nodeVersion && ` · Node ${detected.nodeVersion}`}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {appTypeOptions.map((option) => {
                      const Icon = option.icon;
                      const selected = formData.type === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={selected}
                          title={option.description}
                          onClick={() => handleInputChange("type", option.value)}
                          className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                            selected
                              ? "border-primary bg-primary/5 font-medium text-primary"
                              : "border-border/60 hover:border-primary/40"
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  {!formData.type && !detecting ? (
                    <p className="text-xs text-destructive">
                      {t("Could not tell what this project is — pick its type.")}
                    </p>
                  ) : detected ? (
                    <p className="text-xs text-muted-foreground">
                      {t("Install:")} <code>{detected.installCommand}</code>
                      {detected.buildCommand && (
                        <> · {t("Build:")} <code>{detected.buildCommand}</code></>
                      )}
                      {detected.startCommand && (
                        <> · {t("Start:")} <code>{detected.startCommand}</code></>
                      )}
                    </p>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            {!(sourceMode === "upload" && formData.type === "STATIC") && (
              <Card className="bg-gradient-card border-border/50 shadow-elegant">
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Terminal className="h-5 w-5 text-primary" />
                    <span>{t("Build & Runtime Configuration")}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <Label htmlFor="buildCommand">{t("Build Command")}</Label>
                      <Input
                        id="buildCommand"
                        placeholder={
                          formData.type === "STATIC"
                            ? "npm run build"
                            : "npm install"
                        }
                        value={formData.buildCommand}
                        onChange={(e) =>
                          handleInputChange("buildCommand", e.target.value)
                        }
                      />
                    </div>

                    {formData.type === "NODEJS" && (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="startCommand">{t("Start Command")}</Label>
                          <Input
                            id="startCommand"
                            placeholder="npm start"
                            value={formData.startCommand}
                            onChange={(e) =>
                              handleInputChange("startCommand", e.target.value)
                            }
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="port">
                            {t("Port")}{" "}
                            <span className="text-xs text-muted-foreground">
                              {t("(assigned automatically — set only if the app ignores $PORT)")}
                            </span>
                          </Label>
                          <Input
                            id="port"
                            type="number"
                            placeholder={t("auto")}
                            value={formData.port}
                            onChange={(e) =>
                              handleInputChange("port", e.target.value)
                            }
                          />
                        </div>
                      </>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="envVars">{t("Environment Variables")}</Label>
                    <Textarea
                      id="envVars"
                      placeholder="NODE_ENV=production&#10;API_URL=https://api.example.com"
                      value={formData.envVars}
                      onChange={(e) =>
                        handleInputChange("envVars", e.target.value)
                      }
                      rows={4}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("One variable per line in KEY=value format")}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Wizard navigation */}
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => (step === 1 ? navigate("/") : setStep(step - 1))}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            {step === 1 ? t("Cancel") : t("Back")}
          </Button>

          {step < 2 ? (
            <Button
              type="button"
              disabled={!stepComplete(step)}
              onClick={() => setStep(step + 1)}
              className="bg-gradient-primary min-w-[140px]"
            >
              {t("Continue")}
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!stepComplete(2) || createApp.isPending}
              className="bg-gradient-primary shadow-glow hover:shadow-elegant transition-all duration-300 min-w-[140px]"
            >
              {createApp.isPending ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent mr-2" />
                  {t("Deploying...")}
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4 mr-2" />
                  {t("Deploy App")}
                </>
              )}
            </Button>
          )}
        </div>
      </form>
    </PageLayout>
  );
}
